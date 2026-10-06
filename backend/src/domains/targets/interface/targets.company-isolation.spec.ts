import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { TargetService } from '../application/target.service';
import { HrService } from '../../hr/application/hr.service';
import { Target } from '../infrastructure/target.entity';
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
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for `target.controller.ts`:
 * two real Company databases, real HR + Approval + Process engines and the real company-scope approval
 * subscriber. A Target lives, is approved and is read only inside its own Company.
 */
describe('TargetService Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let hr: HrService;
  let targets: TargetService;
  let makerA: string;
  let approverA: string;
  const NODE = 'targets.target.approve';

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'targets_isolation', extraCompanyTags: ['hr', 'targets'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const events = new EventBusService(inert, h.connections);
    const limits = new LimitService(ambient, { sync: async () => undefined } as never, audit);
    const approvals = new ApprovalEngineService(
      ambient,
      new ProcessEngineService(ambient),
      audit,
      events,
      new PermissionService(inert, new AuthorizationService(inert, inert)),
      { get: () => 24 } as never,
    );
    hr = new HrService(ambient, limits, events, audit, new OrganizationService(ambient), new NumberingService(ambient), approvals, h.users);
    targets = new TargetService(ambient, audit, events, approvals, new ProcessEngineService(ambient), hr);
    await hr.onModuleInit();
    await targets.onModuleInit();

    makerA = (await h.createUserWithAdminRoleIn('Targets Maker A', h.companyAId)).id;
    approverA = (await h.createUserWithAdminRoleIn('Targets Approver A', h.companyAId)).id;
    const ds = await h.connections.getDataSource(h.companyAId);
    const role = (await ds.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    await ds.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable') ON CONFLICT DO NOTHING`, [role.id, NODE]);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown();
  });

  const mgr = async (id: string) => (await h.connections.getDataSource(id)).manager;

  it('a Target for a Company\'s own employee is created in that Company only; another Company\'s employee is not a valid reference', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const empA = await hr.createEmployee({ fullName: 'Target Emp A' }, makerA, mA);
    const empB = await hr.createEmployee({ fullName: 'Target Emp B' }, makerA, mB);
    const t = await targets.create({ employeeId: empA.id, periodStart: '2026-01-01', periodEnd: '2026-03-31', targetValue: '1000' }, makerA, mA);
    expect(t.status).toBe('draft');
    await expect(targets.create({ employeeId: empA.id, periodStart: '2026-01-01', periodEnd: '2026-03-31', targetValue: '1000' }, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
    await targets.create({ employeeId: empB.id, periodStart: '2026-01-01', periodEnd: '2026-03-31', targetValue: '555' }, makerA, mB);
    expect((await targets.listTargets(undefined, mA)).map((x) => x.targetValue)).toEqual(['1000.00']);
    expect((await targets.listTargets(undefined, mB)).map((x) => x.targetValue)).toEqual(['555.00']);
    expect(await ambient.query(`SELECT to_regclass('public.targets') AS t`).then((r) => r[0].t)).toBeNull(); // ambient has no targets table at all in this proof DB
  });

  it('submit → approve round-trip applies the decision to the same Company\'s Target through the company-scope subscriber', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const [t] = await targets.listTargets(undefined, mA);
    const submitted = await targets.submitForApproval(t.id, makerA, mA);
    expect(submitted.status).toBe('pending_approval');
    await expect(targets.decide(submitted.approvalRequestId!, approverA, 'approved', null, mB)).rejects.toBeInstanceOf(NotFoundException); // not B's request
    await targets.decide(submitted.approvalRequestId!, approverA, 'approved', null, mA);
    const after = await mA.getRepository(Target).findOneOrFail({ where: { id: t.id } });
    expect(after.status).toBe('approved');
    expect((await targets.getApprovedTargetForDate(t.employeeId, '2026-02-01', mA))?.id).toBe(t.id);
    expect(await targets.getApprovedTargetForDate(t.employeeId, '2026-02-01', mB)).toBeNull();
    expect(await mB.getRepository(Target).count({ where: { status: 'approved' } })).toBe(0);
  });

  it('a rejected approval flips the Target to rejected in its own Company only', async () => {
    const mA = await mgr(h.companyAId);
    const [emp] = await hr.listEmployees(mA);
    const t = await targets.create({ employeeId: emp.id, periodStart: '2026-04-01', periodEnd: '2026-06-30', targetValue: '300' }, makerA, mA);
    const submitted = await targets.submitForApproval(t.id, makerA, mA);
    await targets.decide(submitted.approvalRequestId!, approverA, 'rejected', 'no', mA);
    expect((await mA.getRepository(Target).findOneOrFail({ where: { id: t.id } })).status).toBe('rejected');
  });
});
