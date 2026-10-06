import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { PayrollService } from '../application/payroll.service';
import { HrService } from '../../hr/application/hr.service';
import { TargetService } from '../../targets/application/target.service';
import { AttendanceService } from '../../attendance/application/attendance.service';
import { CommissionService } from '../../commission/application/commission.service';
import { PayrollRun } from '../infrastructure/payroll-run.entity';
import { LimitService } from '../../../foundation/limit-engine/limit.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { ExcelService } from '../../../foundation/excel/excel.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

/**
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for `payroll.controller.ts`:
 * two real Company databases, real HR / Attendance / Commission / Approval / Process engines and the
 * company-scope approval subscriber. Periods, compensation, runs, lines and adjustments live — and a run
 * is approved and posted — only inside its own Company; the `payroll.run.posted` event lands in that
 * Company's own outbox.
 */
describe('PayrollService Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let hr: HrService;
  let payroll: PayrollService;
  let makerA: string;
  let approverA: string;
  const NODE = 'payroll.run.approve';

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'payroll_isolation', extraCompanyTags: ['hr', 'attendance', 'targets', 'commission', 'accounting', 'payroll'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const events = new EventBusService(inert, h.connections);
    const limits = new LimitService(ambient, { sync: async () => undefined } as never, audit);
    const process = new ProcessEngineService(ambient);
    const numbering = new NumberingService(ambient);
    const approvals = new ApprovalEngineService(
      ambient,
      process,
      audit,
      events,
      new PermissionService(inert, new AuthorizationService(inert, inert)),
      { get: () => 24 } as never,
    );
    hr = new HrService(ambient, limits, events, audit, new OrganizationService(ambient), numbering, approvals, h.users);
    const targets = new TargetService(ambient, audit, events, approvals, process, hr);
    const attendance = new AttendanceService(ambient, audit, events, approvals, new ExcelService(), hr);
    const commission = new CommissionService(ambient, audit, events, approvals, process, hr, targets);
    payroll = new PayrollService(ambient, audit, events, approvals, process, numbering, hr, attendance, commission, {} as never);
    await hr.onModuleInit();
    await targets.onModuleInit();
    await attendance.onModuleInit();
    await commission.onModuleInit();
    await payroll.onModuleInit();

    makerA = (await h.createUserWithAdminRoleIn('Payroll Maker A', h.companyAId)).id;
    approverA = (await h.createUserWithAdminRoleIn('Payroll Approver A', h.companyAId)).id;
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
  let periodA = '';
  let runA = '';
  let lineA = '';

  it('a period and a compensation exist only in their own Company; a foreign employee is not a valid reference', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    empA = (await hr.createEmployee({ fullName: 'Pay Emp A' }, makerA, mA)).id;
    const empB = (await hr.createEmployee({ fullName: 'Pay Emp B' }, makerA, mB)).id;
    periodA = (await payroll.createPeriod({ code: '2026-09', startDate: '2026-09-01', endDate: '2026-09-30' }, makerA, mA)).id;
    await payroll.createPeriod({ code: '2026-09-B', startDate: '2026-09-01', endDate: '2026-09-30' }, makerA, mB);
    await expect(payroll.createCompensation({ employeeId: empA, earnings: [{ componentCode: 'BASE', amount: '1000' }] }, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
    await payroll.createCompensation({ employeeId: empA, earnings: [{ componentCode: 'BASE', amount: '1000' }] }, makerA, mA);
    await payroll.createCompensation({ employeeId: empB, earnings: [{ componentCode: 'BASE', amount: '777' }] }, makerA, mB);
    expect((await payroll.listPeriods(mA)).map((p) => p.code)).toEqual(['2026-09']);
    expect((await payroll.listPeriods(mB)).map((p) => p.code)).toEqual(['2026-09-B']);
    expect((await payroll.listCompensations(undefined, mA)).length).toBe(1);
    expect((await payroll.listCompensations(empA, mB)).length).toBe(0);
  });

  it('calculate computes a run from the Company\'s own employees and compensation, numbered in that Company', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    await expect(payroll.calculate(periodA, makerA, mB)).rejects.toBeInstanceOf(NotFoundException); // A's period is unknown to B
    const run = await payroll.calculate(periodA, makerA, mA);
    runA = run.id;
    expect(run.status).toBe('calculated');
    expect(run.code).toMatch(/^PR/);
    const { lines } = await payroll.getRun(runA, mA);
    expect(lines.length).toBe(1);
    expect(lines[0].employeeId).toBe(empA);
    expect(lines[0].netPay).toBe('1000.00');
    lineA = lines[0].id;
    expect(await payroll.listRuns(mB)).toEqual([]);
    await expect(payroll.getRun(runA, mB)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('review → submit → approve posts the run inside its Company only, publishing payroll.run.posted to that Company\'s outbox', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    await payroll.review(runA, makerA, mA);
    const submitted = await payroll.submitForApproval(runA, makerA, mA);
    await expect(payroll.decide(submitted.approvalRequestId!, approverA, 'approved', null, mB)).rejects.toBeInstanceOf(NotFoundException);
    await payroll.decide(submitted.approvalRequestId!, approverA, 'approved', null, mA);
    const after = await mA.getRepository(PayrollRun).findOneOrFail({ where: { id: runA } });
    expect(after.status).toBe('posted');
    expect((await mA.query(`SELECT count(*)::int n FROM event_outbox WHERE topic = 'payroll.run.posted'`))[0].n).toBe(1);
    expect((await mB.query(`SELECT count(*)::int n FROM event_outbox WHERE topic = 'payroll.run.posted'`))[0].n).toBe(0);
    expect(await payroll.getFinancialEventStatus(runA, mB)).toBeNull();
    expect((await payroll.listReconciliationGaps(mA)).map((g) => g.payrollRunId)).toEqual([runA]); // posted, GL not confirmed — the detector sees it in its own Company
    expect(await payroll.listReconciliationGaps(mB)).toEqual([]);
  });

  it('adjustments reference only their own Company\'s run lines', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const input = { originalPayrollRunLineId: lineA, kind: 'adjustment' as const, reason: 'rounding', amountDelta: '-1.00' };
    await expect(payroll.createAdjustment(input, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
    const adj = await payroll.createAdjustment(input, makerA, mA);
    expect((await payroll.listAdjustments(undefined, mA)).map((a) => a.id)).toEqual([adj.id]);
    expect(await payroll.listAdjustments(undefined, mB)).toEqual([]);
  });

  it('Test F — nothing leaked into the other Company\'s payroll tables', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsB.query(`SELECT count(*)::int n FROM payroll_runs`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM payroll_run_lines`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM payroll_adjustments`))[0].n).toBe(0);
  });
});
