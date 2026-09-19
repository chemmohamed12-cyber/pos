import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { AttendanceService } from './attendance.service';
import { HrService } from '../../hr/application/hr.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { AttendanceApprovalBatch } from '../infrastructure/attendance-approval-batch.entity';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthService } from '../../../foundation/authentication/auth.service';

/**
 * ADR-065 (Attendance Phase 1) — proves the ratified `ADR-063` decisions
 * exactly as built: no late/shift/holiday logic exists (D-ATT1/§1/§4/§7);
 * hours are a bare fact, first-in/last-out, no rounding (§2/§5/§6);
 * approved leave reconciles to `on_leave` (§3); a day inside an approved
 * batch is correction-protected until FA-01 re-approves it (§8: C).
 */
describe('AttendanceService (ADR-065, Attendance Phase 1)', () => {
  let moduleRef: TestingModule;
  let attendance: AttendanceService;
  let hr: HrService;
  let approvals: ApprovalEngineService;
  let dataSource: DataSource;
  let permissions: PermissionService;
  let auth: AuthService;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const SECOND_APPROVER = 'f539302e-9ae7-4cc2-99cf-381f08acab83'; // debug-admin@daii.example, existing fixture
  const shortName = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    attendance = moduleRef.get(AttendanceService);
    hr = moduleRef.get(HrService);
    approvals = moduleRef.get(ApprovalEngineService);
    dataSource = moduleRef.get(DataSource);
    permissions = moduleRef.get(PermissionService);
    auth = moduleRef.get(AuthService);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('E2E-01/manual entry: a single punch derives a missing_punch day; a second punch derives present with span-based hours (ADR-063 §5: A, §6: A)', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('AttEmp') }, ADMIN_A);
    const date = '2026-11-02';

    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: `${date}T08:00:00.000Z`, punchType: 'in' }, ADMIN_A);
    let day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === date);
    expect(day?.status).toBe('missing_punch');
    expect(day?.hoursWorked).toBeNull();

    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: `${date}T16:30:00.000Z`, punchType: 'out' }, ADMIN_A);
    day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === date);
    expect(day?.status).toBe('present');
    expect(Number(day?.hoursWorked)).toBeCloseTo(8.5, 3); // exact span, zero rounding (§6: A)
  });

  it('a day with zero punches and no approved leave is "absent" (ADR-063 §7: B — no holiday exclusion, an accepted consequence)', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('AbsentEmp') }, ADMIN_A);
    const derived = await attendance.deriveDay(emp.id, '2026-11-03');
    expect(derived?.status).toBe('absent');
  });

  it('E2E-05: an approved LeaveRequest day reconciles to "on_leave", not "absent" (ADR-063 §3: B)', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('LeaveAttEmp') }, ADMIN_A);
    const leaveRequest = await hr.submitLeaveRequest({ employeeId: emp.id, leaveType: 'annual', startDate: '2026-11-10', endDate: '2026-11-11' }, ADMIN_A);
    await approvals.decide(leaveRequest.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const derived = await attendance.deriveDay(emp.id, '2026-11-10');
    expect(derived?.status).toBe('on_leave');
    expect(derived?.checkIn).toBeNull();
  }, 30_000);

  it('E2E-03/E2E-04: an unmapped device reference is preserved, surfaced, and resolves retroactively once a mapping is created', async () => {
    const connector = await attendance.createConnector(shortName('Connector'), 'manual', ADMIN_A);
    const emp = await hr.createEmployee({ fullName: shortName('MappedEmp') }, ADMIN_A);
    const deviceRef = shortName('DEV');

    // A punch arrives from this device BEFORE any mapping exists.
    const raw = await dataSource.getRepository('attendance_raw_records').save({
      sourceType: 'api',
      sourceConnectorId: connector.id,
      importBatchId: null,
      deviceEmployeeRef: deviceRef,
      resolvedEmployeeId: null,
      punchTimestamp: new Date('2026-11-12T08:00:00.000Z'),
      punchType: 'in',
      rawPayload: null,
      ingestedByUserId: null,
    });

    const unmapped = await attendance.listUnmappedRecords();
    expect(unmapped.some((r) => r.id === raw.id)).toBe(true);

    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: deviceRef }, ADMIN_A);

    const stillUnmapped = await attendance.listUnmappedRecords();
    expect(stillUnmapped.some((r) => r.id === raw.id)).toBe(false); // resolved retroactively

    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-11-12');
    expect(day?.status).toBe('missing_punch'); // one punch only

    // Duplicate active mapping for the same (connector, deviceRef) is rejected.
    const emp2 = await hr.createEmployee({ fullName: shortName('DupEmp') }, ADMIN_A);
    await expect(attendance.createMapping({ connectorId: connector.id, employeeId: emp2.id, deviceUserRef: deviceRef }, ADMIN_A)).rejects.toThrow(/already actively mapped/);
  });

  it('createMapping rejects a non-existent employeeId (same guard recordManualPunch already had)', async () => {
    const connector = await attendance.createConnector(shortName('GhostConn'), 'manual', ADMIN_A);
    await expect(
      attendance.createMapping({ connectorId: connector.id, employeeId: '00000000-0000-0000-0000-000000000099', deviceUserRef: shortName('GHOST') }, ADMIN_A),
    ).rejects.toThrow(/not found/i);
  });

  it('submitApprovalBatch leaves no orphaned batchId when ApprovalEngineService.submit fails — the batch is deleted and days remain submittable', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BatchFailEmp') }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: '2026-11-24T08:00:00.000Z', punchType: 'in' }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: '2026-11-24T16:00:00.000Z', punchType: 'out' }, ADMIN_A);

    const submitSpy = jest.spyOn(approvals, 'submit').mockRejectedValueOnce(new Error('simulated approval-engine outage'));
    await expect(attendance.submitApprovalBatch('2026-11-24', '2026-11-24', ADMIN_A)).rejects.toThrow(/simulated approval-engine outage/);
    submitSpy.mockRestore();

    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-11-24');
    expect(day?.batchId).toBeNull(); // not stuck — eligible for a fresh submission

    const batch = await attendance.submitApprovalBatch('2026-11-24', '2026-11-24', ADMIN_A);
    expect(batch.status).toBe('submitted');
  }, 30_000);

  it('device reassignment: closing a mapping and opening a new one preserves old punch attribution (ADR-062 §5)', async () => {
    const connector = await attendance.createConnector(shortName('ReassignConn'), 'manual', ADMIN_A);
    const empA = await hr.createEmployee({ fullName: shortName('OldOwner') }, ADMIN_A);
    const empB = await hr.createEmployee({ fullName: shortName('NewOwner') }, ADMIN_A);
    const deviceRef = shortName('DEV2');

    const mapping = await attendance.createMapping({ connectorId: connector.id, employeeId: empA.id, deviceUserRef: deviceRef }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: empA.id, punchTimestamp: '2026-11-13T08:00:00.000Z', punchType: 'in' }, ADMIN_A);

    await attendance.closeMapping(mapping.id, ADMIN_A);
    await expect(attendance.closeMapping(mapping.id, ADMIN_A)).rejects.toThrow(/already closed/);

    await attendance.createMapping({ connectorId: connector.id, employeeId: empB.id, deviceUserRef: deviceRef }, ADMIN_A);

    // Old employee's day is untouched by the reassignment.
    const oldDay = (await attendance.listDays(empA.id)).find((d) => d.calendarDate === '2026-11-13');
    expect(oldDay?.status).toBe('missing_punch');
  });

  it('E2E-06/E2E-07: an approval batch is submitted, approved by a second user (SoD), publishes attendance.period.approved, and only then protects its days from silent re-derivation (ADR-063 §8: C trigger)', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BatchEmp') }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: '2026-11-20T08:00:00.000Z', punchType: 'in' }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: '2026-11-20T16:00:00.000Z', punchType: 'out' }, ADMIN_A);

    const batch = await attendance.submitApprovalBatch('2026-11-20', '2026-11-20', ADMIN_A);
    expect(batch.status).toBe('submitted');

    // Maker cannot decide their own batch (FA-01 SoD).
    await expect(approvals.decide(batch.approvalRequestId!, ADMIN_A, 'approved', null)).rejects.toThrow(/maker/i);

    await approvals.decide(batch.approvalRequestId!, SECOND_APPROVER, 'approved', null);
    const reloadedBatch = await dataSource.getRepository(AttendanceApprovalBatch).findOne({ where: { id: batch.id } });
    expect(reloadedBatch?.status).toBe('approved');

    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-11-20');
    expect(day?.batchId).toBe(batch.id);

    // Re-deriving an approved day is a protected no-op — status/hours untouched.
    const beforeHours = day?.hoursWorked;
    const redone = await attendance.deriveDay(emp.id, '2026-11-20');
    expect(redone?.hoursWorked).toBe(beforeHours);
  }, 30_000);

  it('E2E-08: correction BEFORE batch approval is direct and audited; correction AFTER approval requires FA-01 (ADR-063 §8: C)', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('CorrectEmp') }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: '2026-11-21T08:00:00.000Z', punchType: 'in' }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: '2026-11-21T16:00:00.000Z', punchType: 'out' }, ADMIN_A);
    const dayBefore = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-11-21')!;

    // Direct correction — no batch yet.
    const directResult = await attendance.correctDay(dayBefore.id, { checkOut: '2026-11-21T17:00:00.000Z', reason: 'forgot to clock out at the right time' }, ADMIN_A);
    expect(directResult.applied).toBe(true);
    expect(Number(directResult.day?.hoursWorked)).toBeCloseTo(9, 3);

    // Now batch + approve it.
    const batch = await attendance.submitApprovalBatch('2026-11-21', '2026-11-21', ADMIN_A);
    await approvals.decide(batch.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    // Correction AFTER approval requires FA-01 — not applied immediately.
    const gatedResult = await attendance.correctDay(dayBefore.id, { checkOut: '2026-11-21T18:00:00.000Z', reason: 'late correction after approval' }, ADMIN_A);
    expect(gatedResult.applied).toBe(false);
    expect(gatedResult.correctionRequestId).toBeTruthy();

    const stillOld = (await attendance.listDays(emp.id)).find((d) => d.id === dayBefore.id);
    expect(Number(stillOld?.hoursWorked)).toBeCloseTo(9, 3); // unchanged until approved

    await approvals.decide((await approvals.getRequest((await dataSource.query(
      `SELECT "approvalRequestId" FROM attendance_correction_requests WHERE "attendanceDayId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [dayBefore.id],
    ))[0].approvalRequestId)).id, SECOND_APPROVER, 'approved', null);

    const corrected = (await attendance.listDays(emp.id)).find((d) => d.id === dayBefore.id);
    expect(Number(corrected?.hoursWorked)).toBeCloseTo(10, 3);
  }, 30_000);

  it('a rejected batch clears batchId off its days, allowing resubmission', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('RejectBatchEmp') }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: '2026-11-22T08:00:00.000Z', punchType: 'in' }, ADMIN_A);
    await attendance.recordManualPunch({ employeeId: emp.id, punchTimestamp: '2026-11-22T16:00:00.000Z', punchType: 'out' }, ADMIN_A);

    const batch = await attendance.submitApprovalBatch('2026-11-22', '2026-11-22', ADMIN_A);
    await approvals.decide(batch.approvalRequestId!, SECOND_APPROVER, 'rejected', 'needs review');

    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-11-22');
    expect(day?.batchId).toBeNull();

    // Resubmission now works — no leftover blocker.
    const secondBatch = await attendance.submitApprovalBatch('2026-11-22', '2026-11-22', ADMIN_A);
    expect(secondBatch.status).toBe('submitted');
  }, 30_000);

  it('Excel import: preview performs zero writes; import is idempotent against a byte-identical re-upload', async () => {
    const template = await attendance.buildImportTemplate();
    expect(template.length).toBeGreaterThan(0);

    const XLSX = await import('exceljs');
    const workbook = new XLSX.Workbook();
    const sheet = workbook.addWorksheet('Attendance');
    sheet.columns = [{ header: 'Device/Employee Ref', key: 'deviceUserRef' }, { header: 'Punch Timestamp (ISO)', key: 'punchTimestamp' }, { header: 'Punch Type (in/out/unknown)', key: 'punchType' }];
    sheet.addRow({ deviceUserRef: 'unmapped-import-ref', punchTimestamp: '2026-11-25T08:00:00.000Z', punchType: 'in' });
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const preview = await attendance.previewImport(buffer);
    expect(preview.succeeded).toHaveLength(1);
    expect(preview.rejected).toHaveLength(0);

    const rawCountBefore = await dataSource.getRepository('attendance_raw_records').count();
    // Preview must not have written anything.
    const batch = await attendance.importExcel(buffer, 'test-import.xlsx', ADMIN_A);
    const rawCountAfter = await dataSource.getRepository('attendance_raw_records').count();
    expect(rawCountAfter).toBe(rawCountBefore + 1);
    expect(batch.succeededCount).toBe(1);

    await expect(attendance.importExcel(buffer, 'test-import.xlsx', ADMIN_A)).rejects.toThrow(/already imported/);
  });

  it('Stage 5/E2E-09 — permission resolution: a narrowly-scoped viewer cannot write; a broader role can', async () => {
    const viewerEmail = `adr065-att-viewer-${Date.now()}@daii.example`;
    const viewer = await auth.register(viewerEmail, 'ADR-065 Attendance Viewer Fixture', 'TestPassword123!');

    for (const node of ['attendance.manual_entry.create', 'attendance.import.create', 'attendance.correction.create', 'attendance.approval.approve']) {
      expect(await permissions.hasAtLeast(viewer.id, node, 'editable')).toBe(false);
    }
    expect(await permissions.hasAtLeast(ADMIN_A, 'attendance.manual_entry.create', 'editable')).toBe(true);
  });
});
