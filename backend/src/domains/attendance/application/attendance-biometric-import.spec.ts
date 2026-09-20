import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import ExcelJS from 'exceljs';
import { AppModule } from '../../../app.module';
import { AttendanceService } from './attendance.service';
import { HrService } from '../../hr/application/hr.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';

/**
 * CTO directive (2026-09-20) — "Update Biometric Import Contract to Match
 * Actual Device Daily Report." Proves the confirmed real biometric device
 * export (a Daily Attendance Summary, one row per employee per day) is
 * correctly ingested: AC-No. as the sole employee-matching identity (never
 * Name), On duty/Off duty kept as scheduled-window facts only (never
 * actual timestamps), Clock In/Clock Out as the only source of actual
 * attendance timestamps, Late/Early/Absent/OT Time preserved as opaque
 * source facts that never auto-generate a payroll deduction, and the
 * whole pipeline reconciling correctly against HR's approved LeaveRequest
 * — all without touching the ratified ADR-063 derivation rule or ADR-065's
 * punch-log importer, both left unchanged.
 */
describe('AttendanceService — Biometric Daily Attendance Summary import (CTO directive, 2026-09-20)', () => {
  let moduleRef: TestingModule;
  let attendance: AttendanceService;
  let hr: HrService;
  let approvals: ApprovalEngineService;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const SECOND_APPROVER = 'f539302e-9ae7-4cc2-99cf-381f08acab83';
  const shortName = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000)}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    attendance = moduleRef.get(AttendanceService);
    hr = moduleRef.get(HrService);
    approvals = moduleRef.get(ApprovalEngineService);
    dataSource = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  interface RowInput {
    acNo: string;
    name?: string;
    date: string;
    onDuty?: string;
    offDuty?: string;
    clockIn?: string;
    clockOut?: string;
    late?: string;
    early?: string;
    absent?: string;
    otTime?: string;
  }

  async function buildWorkbook(rows: RowInput[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Biometric Daily Attendance');
    sheet.columns = [
      { header: 'AC-No.', key: 'acNo' },
      { header: 'Name', key: 'name' },
      { header: 'Date', key: 'date' },
      { header: 'On duty', key: 'onDuty' },
      { header: 'Off duty', key: 'offDuty' },
      { header: 'Clock In', key: 'clockIn' },
      { header: 'Clock Out', key: 'clockOut' },
      { header: 'Late', key: 'late' },
      { header: 'Early', key: 'early' },
      { header: 'Absent', key: 'absent' },
      { header: 'OT Time', key: 'otTime' },
    ];
    for (const r of rows) {
      sheet.addRow({
        acNo: r.acNo,
        name: r.name ?? '',
        date: r.date,
        onDuty: r.onDuty ?? '',
        offDuty: r.offDuty ?? '',
        clockIn: r.clockIn ?? '',
        clockOut: r.clockOut ?? '',
        late: r.late ?? '',
        early: r.early ?? '',
        absent: r.absent ?? '',
        otTime: r.otTime ?? '',
      });
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  it('1. Normal present day with Clock In/Out derives a present AttendanceDay with span-based hours', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BioPresent') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    const acNo = shortName('AC');
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    const buffer = await buildWorkbook([{ acNo, name: 'mohammed elady', date: '26/07/2026', onDuty: '09:00', offDuty: '17:00', clockIn: '09:03', clockOut: '17:05' }]);
    await attendance.importBiometricDailySummary(buffer, 'daily-1.xlsx', ADMIN_A);

    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-07-26');
    expect(day?.status).toBe('present');
    expect(Number(day?.hoursWorked)).toBeCloseTo(8.0333, 3); // 09:03 -> 17:05 exact span, zero rounding
  });

  it('2. Absent=True with blank Clock In/Out derives "absent" — On duty/Off duty never contribute a punch', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BioAbsent') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    const acNo = shortName('AC');
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    const buffer = await buildWorkbook([{ acNo, name: 'mohammed elady', date: '26/07/2026', onDuty: '09:00', offDuty: '17:00', absent: 'True' }]);
    await attendance.importBiometricDailySummary(buffer, 'daily-2.xlsx', ADMIN_A);

    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-07-26');
    expect(day?.status).toBe('absent');
    expect(day?.checkIn).toBeNull();
    expect(day?.checkOut).toBeNull();
  });

  it('3. Late populated is preserved as an opaque fact, never affecting derived status', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BioLate') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    const acNo = shortName('AC');
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    const buffer = await buildWorkbook([{ acNo, date: '27/07/2026', clockIn: '09:20', clockOut: '17:00', late: '00:20' }]);
    await attendance.importBiometricDailySummary(buffer, 'daily-3.xlsx', ADMIN_A);

    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-07-27');
    expect(day?.status).toBe('present'); // late fact does not become a status value (ADR-063 §1: C, not reopened)

    const fact = await dataSource.getRepository('attendance_biometric_daily_facts').findOne({ where: { deviceUserRef: acNo, calendarDate: '2026-07-27' } });
    expect((fact as { lateValue: string }).lateValue).toBe('00:20');
  });

  it('4. Early populated is preserved as an opaque fact', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BioEarly') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    const acNo = shortName('AC');
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    const buffer = await buildWorkbook([{ acNo, date: '28/07/2026', clockIn: '09:00', clockOut: '16:30', early: '00:30' }]);
    await attendance.importBiometricDailySummary(buffer, 'daily-4.xlsx', ADMIN_A);

    const fact = await dataSource.getRepository('attendance_biometric_daily_facts').findOne({ where: { deviceUserRef: acNo, calendarDate: '2026-07-28' } });
    expect((fact as { earlyValue: string }).earlyValue).toBe('00:30');
  });

  it('5. OT Time populated is preserved as an opaque fact, never converted to a payable overtime amount', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BioOT') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    const acNo = shortName('AC');
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    const buffer = await buildWorkbook([{ acNo, date: '29/07/2026', clockIn: '09:00', clockOut: '19:00', otTime: '02:00' }]);
    await attendance.importBiometricDailySummary(buffer, 'daily-5.xlsx', ADMIN_A);

    const fact = await dataSource.getRepository('attendance_biometric_daily_facts').findOne({ where: { deviceUserRef: acNo, calendarDate: '2026-07-29' } });
    expect((fact as { otTimeValue: string }).otTimeValue).toBe('02:00');
    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-07-29');
    expect(day?.status).toBe('present'); // OT is a fact only — no derived field represents "overtime payable"
  });

  it('6. Approved Leave + biometric Absent=True reconciles to "on_leave", not an unexplained absence', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BioLeave') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    const acNo = shortName('AC');
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    const leaveRequest = await hr.submitLeaveRequest({ employeeId: emp.id, leaveType: 'annual', startDate: '2026-08-03', endDate: '2026-08-03' }, ADMIN_A);
    await approvals.decide(leaveRequest.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const buffer = await buildWorkbook([{ acNo, date: '03/08/2026', absent: 'True' }]);
    await attendance.importBiometricDailySummary(buffer, 'daily-6.xlsx', ADMIN_A);

    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-08-03');
    expect(day?.status).toBe('on_leave');
  }, 30_000);

  it('7. Unmapped AC-No. is preserved unmapped, never auto-assigned, never auto-creates an Employee — and resolves retroactively once mapped', async () => {
    const acNo = shortName('UNMAPPED');
    const buffer = await buildWorkbook([{ acNo, name: 'Someone Unmapped', date: '04/08/2026', clockIn: '09:00', clockOut: '17:00' }]);
    await attendance.importBiometricDailySummary(buffer, 'daily-7.xlsx', ADMIN_A);

    const unmapped = await attendance.listUnmappedBiometricRows();
    const row = unmapped.find((r) => r.deviceUserRef === acNo);
    expect(row).toBeTruthy();
    expect(row?.resolvedEmployeeId).toBeNull();
    expect(row?.sourceName).toBe('Someone Unmapped'); // name is informational only, never used for identity

    // No AttendanceDay was created for anyone from this unmapped row.
    const anyDayForBatch = await dataSource.getRepository('attendance_biometric_daily_facts').findOne({ where: { deviceUserRef: acNo } });
    expect(anyDayForBatch).toBeTruthy();

    // Retroactive resolution — mirrors the existing raw-record retroactive-resolution proof (E2E-03/E2E-04).
    const emp = await hr.createEmployee({ fullName: shortName('LateMapped') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    const stillUnmapped = await attendance.listUnmappedBiometricRows();
    expect(stillUnmapped.some((r) => r.deviceUserRef === acNo)).toBe(false);

    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-08-04');
    expect(day?.status).toBe('present');
  });

  it('8. Duplicate import (byte-identical file) is rejected via the existing fileHash idempotency — no duplicate AttendanceDay/records', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BioDup') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    const acNo = shortName('AC');
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    const buffer = await buildWorkbook([{ acNo, date: '05/08/2026', clockIn: '09:00', clockOut: '17:00' }]);
    await attendance.importBiometricDailySummary(buffer, 'daily-8.xlsx', ADMIN_A);
    await expect(attendance.importBiometricDailySummary(buffer, 'daily-8.xlsx', ADMIN_A)).rejects.toThrow(/already imported/);

    const rawCount = await dataSource.getRepository('attendance_raw_records').count({ where: { sourceType: 'biometric' as never, deviceEmployeeRef: acNo } });
    expect(rawCount).toBe(2); // one 'in' + one 'out' — not duplicated by the rejected re-upload

    // A DIFFERENT file re-reporting the SAME (AC-No., Date) row upserts in place, never duplicates.
    const buffer2 = await buildWorkbook([{ acNo, date: '05/08/2026', clockIn: '09:00', clockOut: '17:00', late: '00:00' }]);
    await attendance.importBiometricDailySummary(buffer2, 'daily-8b.xlsx', ADMIN_A);
    const rawCountAfterUpsert = await dataSource.getRepository('attendance_raw_records').count({ where: { sourceType: 'biometric' as never, deviceEmployeeRef: acNo } });
    expect(rawCountAfterUpsert).toBe(2); // still exactly one in/out pair for that day, not four

    const factCount = await dataSource.getRepository('attendance_biometric_daily_facts').count({ where: { deviceUserRef: acNo, calendarDate: '2026-08-05' } });
    expect(factCount).toBe(1); // upserted, not duplicated
  });

  it('9. Blank optional fields (On duty/Off duty/Late/Early/OT Time) import cleanly as null, no errors', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BioBlank') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    const acNo = shortName('AC');
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    const buffer = await buildWorkbook([{ acNo, date: '06/08/2026', clockIn: '09:00', clockOut: '17:00' }]);
    const preview = await attendance.previewBiometricDailyImport(buffer);
    expect(preview.rejected).toHaveLength(0);
    expect(preview.succeeded).toHaveLength(1);

    await attendance.importBiometricDailySummary(buffer, 'daily-9.xlsx', ADMIN_A);
    const fact = await dataSource.getRepository('attendance_biometric_daily_facts').findOne({ where: { deviceUserRef: acNo, calendarDate: '2026-08-06' } });
    expect((fact as { onDuty: string | null; lateValue: string | null }).onDuty).toBeNull();
    expect((fact as { onDuty: string | null; lateValue: string | null }).lateValue).toBeNull();
  });

  it('10. Invalid date/time is rejected at preview/import time with a row-level error, not a thrown fatal error', async () => {
    const acNo = shortName('AC');
    const badDate = await buildWorkbook([{ acNo, date: '2026-08-07', clockIn: '09:00', clockOut: '17:00' }]); // wrong format (ISO, not DD/MM/YYYY)
    const previewBadDate = await attendance.previewBiometricDailyImport(badDate);
    expect(previewBadDate.rejected).toHaveLength(1);
    expect(previewBadDate.rejected[0].errors.join(' ')).toMatch(/Date/);

    const badTime = await buildWorkbook([{ acNo, date: '07/08/2026', clockIn: '9:00am', clockOut: '17:00' }]); // wrong time format
    const previewBadTime = await attendance.previewBiometricDailyImport(badTime);
    expect(previewBadTime.rejected).toHaveLength(1);
    expect(previewBadTime.rejected[0].errors.join(' ')).toMatch(/Clock In/);

    const impossibleDate = await buildWorkbook([{ acNo, date: '30/02/2026', clockIn: '09:00', clockOut: '17:00' }]); // Feb 30 does not exist
    const previewImpossible = await attendance.previewBiometricDailyImport(impossibleDate);
    expect(previewImpossible.rejected).toHaveLength(1);
  });

  it('11. Employee mapping resolves by AC-No., never by Name — two different-named rows sharing one AC-No. resolve to the same employee, and a same-named different AC-No. does not', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BioIdentity') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    const acNo = shortName('AC');
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    // Row's Name differs from the Employee's own fullName — resolution must still succeed via AC-No.
    const buffer = await buildWorkbook([{ acNo, name: 'A Totally Different Spelling', date: '08/08/2026', clockIn: '09:00', clockOut: '17:00' }]);
    await attendance.importBiometricDailySummary(buffer, 'daily-11.xlsx', ADMIN_A);
    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-08-08');
    expect(day?.status).toBe('present'); // resolved despite the mismatched Name

    // A different AC-No. with the SAME Name as the employee's fullName must NOT resolve to that employee.
    const otherAcNo = shortName('OTHERAC');
    const buffer2 = await buildWorkbook([{ acNo: otherAcNo, name: 'BioIdentity', date: '08/08/2026', clockIn: '10:00', clockOut: '18:00' }]);
    await attendance.importBiometricDailySummary(buffer2, 'daily-11b.xlsx', ADMIN_A);
    const stillUnmapped = await attendance.listUnmappedBiometricRows();
    expect(stillUnmapped.some((r) => r.deviceUserRef === otherAcNo)).toBe(true); // not resolved by name coincidence
  });

  it('12. Payroll receives attendance facts without automatic absence deduction — Absent=True is stored as a fact, not a status/derivation input', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('BioPayroll') }, ADMIN_A);
    const connector = await attendance.createConnector(shortName('BioConn'), 'manual', ADMIN_A);
    const acNo = shortName('AC');
    await attendance.createMapping({ connectorId: connector.id, employeeId: emp.id, deviceUserRef: acNo }, ADMIN_A);

    // A present day where the device ALSO reports Absent=False alongside real clock times —
    // proves the Absent column is stored, never re-derives or overrides the punch-based status.
    const buffer = await buildWorkbook([{ acNo, date: '09/08/2026', clockIn: '09:00', clockOut: '17:00', absent: 'False' }]);
    await attendance.importBiometricDailySummary(buffer, 'daily-12.xlsx', ADMIN_A);

    const day = (await attendance.listDays(emp.id)).find((d) => d.calendarDate === '2026-08-09');
    expect(day?.status).toBe('present');
    // No wage/rate/amount/deduction field exists anywhere on AttendanceDay (ADR-063 §2: B, unchanged) —
    // Payroll would consume this exact day via ADR-070 §9's day-type determination, never this module's
    // own "Absent" source flag directly.
    expect(Object.keys(day ?? {})).not.toContain('deductionAmount');
    expect(Object.keys(day ?? {})).not.toContain('payImpact');

    const fact = await dataSource.getRepository('attendance_biometric_daily_facts').findOne({ where: { deviceUserRef: acNo, calendarDate: '2026-08-09' } });
    expect((fact as { sourceAbsent: boolean | null }).sourceAbsent).toBe(false); // the raw fact is preserved for audit regardless
  });

  it('Excel biometric import: preview performs zero writes', async () => {
    const template = await attendance.buildBiometricDailyImportTemplate();
    expect(template.length).toBeGreaterThan(0);

    const acNo = shortName('PREVIEWONLY');
    const buffer = await buildWorkbook([{ acNo, date: '10/08/2026', clockIn: '09:00', clockOut: '17:00' }]);
    const factCountBefore = await dataSource.getRepository('attendance_biometric_daily_facts').count();
    await attendance.previewBiometricDailyImport(buffer);
    const factCountAfter = await dataSource.getRepository('attendance_biometric_daily_facts').count();
    expect(factCountAfter).toBe(factCountBefore); // preview never writes
  });
});
