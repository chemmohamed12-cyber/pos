import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { CommissionService } from '../application/commission.service';
import { HrService } from '../../hr/application/hr.service';
import { TargetService } from '../../targets/application/target.service';
import { CommissionApprovalBatch } from '../infrastructure/commission-approval-batch.entity';
import { LimitService } from '../../../foundation/limit-engine/limit.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

/**
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for `commission.controller.ts`:
 * two real Company databases, real HR + Targets + Approval + Process engines and the company-scope approval
 * subscriber. Policies, immutable results, approval batches and adjustments live — and are approved — only
 * inside their own Company; Payroll's read contract (`listApprovedCommissionResults`) sees only its own Company.
 */
describe('CommissionService Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let hr: HrService;
  let commission: CommissionService;
  let makerA: string;
  let approverA: string;
  const NODE = 'commission.batch.approve';

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'commission_isolation', extraCompanyTags: ['hr', 'targets', 'commission'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const events = new EventBusService(inert, h.connections);
    const limits = new LimitService(ambient, { sync: async () => undefined } as never, audit);
    const process = new ProcessEngineService(ambient);
    const approvals = new ApprovalEngineService(
      ambient,
      process,
      audit,
      events,
      new PermissionService(inert, new AuthorizationService(inert, inert)),
      { get: () => 24 } as never,
    );
    hr = new HrService(ambient, limits, events, audit, new OrganizationService(ambient), new NumberingService(ambient), approvals, h.users);
    const targets = new TargetService(ambient, audit, events, approvals, process, hr);
    commission = new CommissionService(ambient, audit, events, approvals, process, hr, targets);
    await hr.onModuleInit();
    await targets.onModuleInit();
    await commission.onModuleInit();

    makerA = (await h.createUserWithAdminRoleIn('Commission Maker A', h.companyAId)).id;
    approverA = (await h.createUserWithAdminRoleIn('Commission Approver A', h.companyAId)).id;
    const ds = await h.connections.getDataSource(h.companyAId);
    const role = (await ds.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    await ds.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable') ON CONFLICT DO NOTHING`, [role.id, NODE]);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown();
  });

  const mgr = async (id: string) => (await h.connections.getDataSource(id)).manager;
  let empA = '';
  let resultA = '';
  let batchA = '';

  it('a policy for a Company\'s own employee is created in that Company only; a foreign employee is not a valid reference', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    empA = (await hr.createEmployee({ fullName: 'Comm Emp A' }, makerA, mA)).id;
    const empB = (await hr.createEmployee({ fullName: 'Comm Emp B' }, makerA, mB)).id;
    const input = { scope: 'sales_rep' as const, scopeRefId: empA, basis: 'gross_sales' as const, rateModel: 'flat' as const, flatRate: '0.05' };
    await expect(commission.createPolicy(input, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
    await commission.createPolicy(input, makerA, mA);
    await commission.createPolicy({ ...input, scopeRefId: empB, flatRate: '0.09' }, makerA, mB);
    expect((await commission.listPolicies(mA)).map((p) => p.flatRate)).toEqual(['0.0500']);
    expect((await commission.listPolicies(mB)).map((p) => p.flatRate)).toEqual(['0.0900']);
  });

  it('results are Company-local; an un-batched result is submitted → approved entirely inside the Company', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const [policy] = await commission.listPolicies(mA);
    resultA = (
      await mA.query(
        `INSERT INTO commission_results ("employeeId","customerId","sourceTransactionRefs","resolvedPolicyId","policyScope","calculationBasis","rate","calculationInputs","calculatedAmount","calculationTimestamp","triggerEventKey")
         VALUES ($1, gen_random_uuid(), '{}', $2, 'sales_rep', 'gross_sales', 0.05, '{}', 50, '2026-09-10T10:00:00Z', 'invoice:iso-1') RETURNING id`,
        [empA, policy.id],
      )
    )[0].id;
    expect((await commission.listResults(undefined, mA)).length).toBe(1);
    expect(await commission.listResults(undefined, mB)).toEqual([]);
    await expect(commission.submitApprovalBatch('2026-09-01', '2026-09-30', makerA, mB)).rejects.toThrow(/No un-batched/); // B has none

    const batch = await commission.submitApprovalBatch('2026-09-01', '2026-09-30', makerA, mA);
    batchA = batch.id;
    expect(batch.status).toBe('submitted');
    await expect(commission.decide(batch.approvalRequestId!, approverA, 'approved', null, mB)).rejects.toBeInstanceOf(NotFoundException);
    await commission.decide(batch.approvalRequestId!, approverA, 'approved', null, mA);
    expect((await mA.getRepository(CommissionApprovalBatch).findOneOrFail({ where: { id: batchA } })).status).toBe('approved');
    expect(await commission.listApprovalBatches(mB)).toEqual([]);
  });

  it('Payroll\'s read contract returns approved results of its own Company only', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    expect((await commission.listApprovedCommissionResults(empA, '2026-09-01', '2026-09-30', mA)).map((r) => r.id)).toEqual([resultA]);
    expect(await commission.listApprovedCommissionResults(empA, '2026-09-01', '2026-09-30', mB)).toEqual([]);
  });

  it('adjustments reference only their own Company\'s results', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const input = { originalCommissionResultId: resultA, kind: 'adjustment' as const, reason: 'rounding', amountDelta: '-1.00' };
    await expect(commission.createAdjustment(input, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
    const adj = await commission.createAdjustment(input, makerA, mA);
    expect((await commission.listAdjustments(undefined, mA)).map((a) => a.id)).toEqual([adj.id]);
    expect(await commission.listAdjustments(undefined, mB)).toEqual([]);
  });

  it('Test F — nothing leaked into the other Company\'s commission tables', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsB.query(`SELECT count(*)::int n FROM commission_results`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM commission_adjustments`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM commission_approval_batches`))[0].n).toBe(0);
  });
});
