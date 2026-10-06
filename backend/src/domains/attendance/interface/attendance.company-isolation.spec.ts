import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { AttendanceService } from '../application/attendance.service';
import { HrService } from '../../hr/application/hr.service';
import { AttendanceApprovalBatch } from '../infrastructure/attendance-approval-batch.entity';
import { AttendanceDay } from '../infrastructure/attendance-day.entity';
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
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for `attendance.controller.ts`:
 * two real Company databases, real HR + Approval engines and the company-scope approval subscriber.
 * Punches, derived days, approval batches and correction requests live — and are approved — only inside
 * their own Company.
 */
describe('AttendanceService Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let hr: HrService;
  let attendance: AttendanceService;
  let makerA: string;
  let approverA: string;
  const NODE = 'attendance.approval.approve';

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'attendance_isolation', extraCompanyTags: ['hr', 'attendance'] });
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
    attendance = new AttendanceService(ambient, audit, events, approvals, new ExcelService(), hr);
    await hr.onModuleInit();
    await attendance.onModuleInit();

    makerA = (await h.createUserWithAdminRoleIn('Att Maker A', h.companyAId)).id;
    approverA = (await h.createUserWithAdminRoleIn('Att Approver A', h.companyAId)).id;
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
  let empB = '';

  it('a punch for a Company\'s own employee derives a day in that Company only; a foreign employee is not a valid reference', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    empA = (await hr.createEmployee({ fullName: 'Att Emp A' }, makerA, mA)).id;
    empB = (await hr.createEmployee({ fullName: 'Att Emp B' }, makerA, mB)).id;
    await attendance.recordManualPunch({ employeeId: empA, punchTimestamp: '2026-09-01T08:00:00Z', punchType: 'in' }, makerA, mA);
    await attendance.recordManualPunch({ employeeId: empA, punchTimestamp: '2026-09-01T16:00:00Z', punchType: 'out' }, makerA, mA);
    await expect(attendance.recordManualPunch({ employeeId: empA, punchTimestamp: '2026-09-01T08:00:00Z', punchType: 'in' }, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
    await attendance.recordManualPunch({ employeeId: empB, punchTimestamp: '2026-09-01T09:00:00Z', punchType: 'in' }, makerA, mB);
    const daysA = await attendance.listDays(undefined, mA);
    expect(daysA.length).toBe(1);
    expect(daysA[0].status).toBe('present');
    expect(Number(daysA[0].hoursWorked)).toBeCloseTo(8, 2);
    const daysB = await attendance.listDays(undefined, mB);
    expect(daysB.length).toBe(1);
    expect(daysB[0].status).toBe('missing_punch'); // B only has an 'in' punch
  });

  it('connectors and device mappings are per Company (and resolve retroactively only inside their own Company)', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const conn = await attendance.createConnector('Front door', 'manual', makerA, mA);
    expect((await attendance.listConnectors(mA)).map((c) => c.id)).toEqual([conn.id]);
    expect(await attendance.listConnectors(mB)).toEqual([]);
    await expect(attendance.createMapping({ connectorId: conn.id, employeeId: empB, deviceUserRef: '77' }, makerA, mB)).rejects.toBeInstanceOf(NotFoundException); // A's connector is unknown to B
    const mapping = await attendance.createMapping({ connectorId: conn.id, employeeId: empA, deviceUserRef: '77' }, makerA, mA);
    expect((await attendance.listMappings(mA)).map((m) => m.id)).toEqual([mapping.id]);
    expect(await attendance.listMappings(mB)).toEqual([]);
  });

  it('approval batch: submit → decide → approved entirely inside the Company; the other Company cannot decide it', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const batch = await attendance.submitApprovalBatch('2026-09-01', '2026-09-30', makerA, mA);
    expect(batch.status).toBe('submitted');
    await expect(attendance.submitApprovalBatch('2026-09-01', '2026-09-30', makerA, mB)).resolves.toBeTruthy(); // B has its own, separate, un-batched day
    await expect(attendance.decide(batch.approvalRequestId!, approverA, 'approved', null, mB)).rejects.toBeInstanceOf(NotFoundException);
    await attendance.decide(batch.approvalRequestId!, approverA, 'approved', null, mA);
    const after = await mA.getRepository(AttendanceApprovalBatch).findOneOrFail({ where: { id: batch.id } });
    expect(after.status).toBe('approved');
    // B's batch is still only submitted — A's approval never touched it
    const bBatches = await attendance.listApprovalBatches(mB);
    expect(bBatches.length).toBe(1);
    expect(bBatches[0].status).toBe('submitted');
  });

  it('correcting a day in an approved batch needs re-approval, and the approval applies to the same Company\'s day', async () => {
    const mA = await mgr(h.companyAId);
    const [day] = await attendance.listDays(undefined, mA);
    const res = await attendance.correctDay(day.id, { checkIn: '2026-09-01T07:00:00Z', checkOut: '2026-09-01T15:00:00Z', reason: 'late scan' }, makerA, mA);
    expect(res.applied).toBe(false);
    expect(res.correctionRequestId).toBeTruthy();
    const pending = await mA.query(`SELECT "approvalRequestId" FROM attendance_correction_requests WHERE id = $1`, [res.correctionRequestId]);
    await attendance.decide(pending[0].approvalRequestId, approverA, 'approved', null, mA);
    const fixed = await mA.getRepository(AttendanceDay).findOneOrFail({ where: { id: day.id } });
    expect(new Date(fixed.checkIn as Date).toISOString()).toBe('2026-09-01T07:00:00.000Z');
  });

  it('Test F — nothing leaked into the other Company\'s attendance tables', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsB.query(`SELECT count(*)::int n FROM attendance_correction_requests`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM attendance_connectors`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM attendance_raw_records WHERE "resolvedEmployeeId" = $1`, [empA]))[0].n).toBe(0);
  });
});
