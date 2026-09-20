import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, In, IsNull, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { AttendanceConnector } from '../infrastructure/attendance-connector.entity';
import { AttendanceEmployeeMapping } from '../infrastructure/attendance-employee-mapping.entity';
import { AttendanceImportBatch } from '../infrastructure/attendance-import-batch.entity';
import { AttendanceRawRecord } from '../infrastructure/attendance-raw-record.entity';
import { AttendanceBiometricDailyFact } from '../infrastructure/attendance-biometric-daily-fact.entity';
import { AttendanceDay } from '../infrastructure/attendance-day.entity';
import { AttendanceApprovalBatch } from '../infrastructure/attendance-approval-batch.entity';
import { AttendanceCorrectionRequest } from '../infrastructure/attendance-correction-request.entity';
import { AttendanceDayStatus, AttendancePunchType, AttendanceSourceType } from '../domain/attendance-day-status';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ExcelService, ColumnSpec, ImportSummary } from '../../../foundation/excel/excel.service';
import { HrService } from '../../hr/application/hr.service';

const APPROVAL_BATCH_TYPE = 'attendance.approval_batch';
const APPROVAL_BATCH_APPROVER_NODE = 'attendance.approval.approve';
const CORRECTION_TYPE = 'attendance.correction';
const CORRECTION_APPROVER_NODE = 'attendance.approval.approve';
// ADR-046 D7's own convention — actions applied by an internal subscriber
// reacting to an approved FA-01 request, not by a live user.
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export interface ManualPunchInput {
  employeeId: string;
  punchTimestamp: string;
  punchType: AttendancePunchType;
}

export interface CreateMappingInput {
  connectorId: string;
  employeeId: string;
  deviceUserRef: string;
}

export interface AttendanceImportRow {
  deviceUserRef: string;
  punchTimestamp: string;
  punchType: string;
}

const IMPORT_COLUMNS: ColumnSpec[] = [
  { key: 'deviceUserRef', header: 'Device/Employee Ref', width: 24, example: 'EMP-2026-000001' },
  { key: 'punchTimestamp', header: 'Punch Timestamp (ISO)', width: 24, example: '2026-10-01T08:00:00Z' },
  { key: 'punchType', header: 'Punch Type (in/out/unknown)', width: 20, example: 'in' },
];

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Biometric Daily Attendance Summary — CTO directive (2026-09-20). The
// confirmed real device export: one row per employee per day, AC-No. as
// the authoritative identity (never Name), scheduled duty window + actual
// Clock In/Out kept strictly separate, Late/Early/Absent/OT Time carried
// as opaque source facts only.
// ---------------------------------------------------------------------------

export interface BiometricDailyImportRow {
  acNo: string;
  name: string;
  date: string;
  onDuty: string;
  offDuty: string;
  clockIn: string;
  clockOut: string;
  late: string;
  early: string;
  absent: string;
  otTime: string;
}

const BIOMETRIC_DAILY_COLUMNS: ColumnSpec[] = [
  { key: 'acNo', header: 'AC-No.', width: 14, example: '2024' },
  { key: 'name', header: 'Name', width: 28, example: 'mohammed elady' },
  { key: 'date', header: 'Date', width: 14, example: '26/07/2026' },
  { key: 'onDuty', header: 'On duty', width: 10, example: '09:00' },
  { key: 'offDuty', header: 'Off duty', width: 10, example: '17:00' },
  { key: 'clockIn', header: 'Clock In', width: 10, example: '' },
  { key: 'clockOut', header: 'Clock Out', width: 10, example: '' },
  { key: 'late', header: 'Late', width: 10, example: '' },
  { key: 'early', header: 'Early', width: 10, example: '' },
  { key: 'absent', header: 'Absent', width: 10, example: 'True' },
  { key: 'otTime', header: 'OT Time', width: 10, example: '' },
];

/** Strict `DD/MM/YYYY` parse, rejecting anything `Date.parse` would otherwise silently misread (locale ambiguity) or roll over (e.g. 30/02). Returns an ISO `YYYY-MM-DD` or `null`. */
function parseDdMmYyyy(value: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null; // rejects e.g. 30/02/2026
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Strict `HH:mm` (24h) validation — returns the trimmed value unchanged, or `null` if invalid. Blank is valid (optional field) and returns `''`. */
function parseHHmm(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(trimmed) ? trimmed : null;
}

/** Combines this row's `calendarDate` with an `HH:mm` string into the same "wall-clock digits as literal UTC" convention every other timestamp in this service already uses (e.g. `deriveDay`'s own day-boundary construction). */
function combineDateAndTime(calendarDate: string, hhmm: string): Date {
  return new Date(`${calendarDate}T${hhmm}:00.000Z`);
}

/** Normalizes the source "Absent" column: 'true'/'false' (any case) to a boolean; blank to `null`; anything else is a validation error the caller surfaces. */
function parseAbsentFlag(value: string): { ok: true; value: boolean | null } | { ok: false } {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed === 'true') return { ok: true, value: true };
  if (trimmed === 'false') return { ok: true, value: false };
  return { ok: false };
}

/**
 * ADR-065 — `attendance`'s application service, Phase 1. Implements the
 * ratified `ADR-063` decisions exactly (see `ADR-065 §0` for the full
 * mapping) — no late/shift/holiday/wage logic exists here by design.
 * `depends_on: ['hr']` (the manifest) is this file's one real cross-
 * domain import: `HrService.isApprovedLeaveDate` for `§3: B`.
 */
@Injectable()
export class AttendanceService implements OnModuleInit {
  constructor(
    @InjectRepository(AttendanceConnector) private readonly connectors: Repository<AttendanceConnector>,
    @InjectRepository(AttendanceEmployeeMapping) private readonly mappings: Repository<AttendanceEmployeeMapping>,
    @InjectRepository(AttendanceImportBatch) private readonly importBatches: Repository<AttendanceImportBatch>,
    @InjectRepository(AttendanceRawRecord) private readonly rawRecords: Repository<AttendanceRawRecord>,
    @InjectRepository(AttendanceBiometricDailyFact) private readonly biometricFacts: Repository<AttendanceBiometricDailyFact>,
    @InjectRepository(AttendanceDay) private readonly days: Repository<AttendanceDay>,
    @InjectRepository(AttendanceApprovalBatch) private readonly approvalBatches: Repository<AttendanceApprovalBatch>,
    @InjectRepository(AttendanceCorrectionRequest) private readonly correctionRequests: Repository<AttendanceCorrectionRequest>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly approvals: ApprovalEngineService,
    private readonly excel: ExcelService,
    private readonly hr: HrService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.approvals.registerRequestType(APPROVAL_BATCH_TYPE, 'action.attendance_submit_approval_batch');
    await this.approvals
      .upsertMatrixRule(
        { requestTypeCode: APPROVAL_BATCH_TYPE, minApprovers: 1, requiredPermissionNode: APPROVAL_BATCH_APPROVER_NODE, valueThreshold: null, orgUnitId: null },
        SYSTEM_ACTOR_ID,
      )
      .catch(() => undefined);

    await this.approvals.registerRequestType(CORRECTION_TYPE, 'action.attendance_correction');
    await this.approvals
      .upsertMatrixRule(
        { requestTypeCode: CORRECTION_TYPE, minApprovers: 1, requiredPermissionNode: CORRECTION_APPROVER_NODE, valueThreshold: null, orgUnitId: null },
        SYSTEM_ACTOR_ID,
      )
      .catch(() => undefined);

    this.events.subscribe('approval.request.approved', async (payload) => {
      await this.onApprovalApproved(payload as Record<string, unknown>);
    });
    this.events.subscribe('approval.request.rejected', async (payload) => {
      await this.onApprovalRejected(payload as Record<string, unknown>);
    });
  }

  // ---------------------------------------------------------------------------
  // Connectors — ADR-065 §3. Only `'manual'` is a real connector type in
  // this contract; the shape is ready for a future device adapter.
  // ---------------------------------------------------------------------------

  async createConnector(name: string, connectorType: string, actorUserId: string): Promise<AttendanceConnector> {
    const saved = await this.connectors.save(this.connectors.create({ name, connectorType, status: 'connected', config: {} }));
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'attendance.connector.created',
      resource: 'attendance_connector',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { name, connectorType },
    });
    return saved;
  }

  async listConnectors(): Promise<AttendanceConnector[]> {
    return this.connectors.find({ order: { createdAt: 'ASC' } });
  }

  // ---------------------------------------------------------------------------
  // Employee / device mapping — ADR-065 §3, mirrors IntegrationProductMapping.
  // ---------------------------------------------------------------------------

  async createMapping(input: CreateMappingInput, actorUserId: string): Promise<AttendanceEmployeeMapping> {
    const connector = await this.connectors.findOne({ where: { id: input.connectorId } });
    if (!connector) throw new NotFoundException(`Attendance connector "${input.connectorId}" not found.`);
    await this.hr.getEmployee(input.employeeId); // throws NotFoundException if the employee does not exist — same guard as recordManualPunch

    const existingActive = await this.mappings.findOne({
      where: { connectorId: input.connectorId, deviceUserRef: input.deviceUserRef, effectiveTo: IsNull() },
    });
    if (existingActive) {
      throw new ConflictException(
        `Device reference "${input.deviceUserRef}" on connector "${input.connectorId}" is already actively mapped — close the existing mapping first.`,
      );
    }

    const saved = await this.mappings.save(
      this.mappings.create({ connectorId: input.connectorId, employeeId: input.employeeId, deviceUserRef: input.deviceUserRef, effectiveFrom: new Date(), effectiveTo: null }),
    );

    // ADR-062 §5 — resolve retroactively: any raw record already sitting
    // unmapped for this exact (connector, device ref) now resolves.
    await this.rawRecords.update(
      { sourceConnectorId: input.connectorId, deviceEmployeeRef: input.deviceUserRef, resolvedEmployeeId: IsNull() },
      { resolvedEmployeeId: input.employeeId },
    );
    const affected = await this.rawRecords.find({ where: { sourceConnectorId: input.connectorId, deviceEmployeeRef: input.deviceUserRef, resolvedEmployeeId: input.employeeId } });
    const affectedDates = new Set(affected.map((r) => toDateOnly(r.punchTimestamp)));
    for (const date of affectedDates) {
      await this.deriveDay(input.employeeId, date);
    }

    // Biometric daily-summary facts (CTO directive, 2026-09-20) resolve retroactively the same
    // way — matched by deviceUserRef alone, since these rows are connector-agnostic at import
    // time exactly like Excel-sourced raw records already are.
    const unresolvedFacts = await this.biometricFacts.find({ where: { deviceUserRef: input.deviceUserRef, resolvedEmployeeId: IsNull() } });
    for (const fact of unresolvedFacts) {
      fact.resolvedEmployeeId = input.employeeId;
      fact.sourceConnectorId = input.connectorId;
      const savedFact = await this.biometricFacts.save(fact);
      await this.applyBiometricFactToDay(savedFact);
    }

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'attendance.mapping.created',
      resource: 'attendance_employee_mapping',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { connectorId: input.connectorId, employeeId: input.employeeId, deviceUserRef: input.deviceUserRef },
    });
    return saved;
  }

  /** Closes an active mapping without deleting it — device reassignment (ADR-062 §5) never loses history. */
  async closeMapping(id: string, actorUserId: string): Promise<AttendanceEmployeeMapping> {
    const mapping = await this.mappings.findOne({ where: { id } });
    if (!mapping) throw new NotFoundException(`Mapping "${id}" not found.`);
    if (mapping.effectiveTo) throw new ConflictException(`Mapping "${id}" is already closed.`);
    mapping.effectiveTo = new Date();
    const saved = await this.mappings.save(mapping);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'attendance.mapping.closed',
      resource: 'attendance_employee_mapping',
      resourceId: id,
      result: 'success',
      correlationId: null,
      after: { effectiveTo: saved.effectiveTo },
    });
    return saved;
  }

  async listMappings(): Promise<AttendanceEmployeeMapping[]> {
    return this.mappings.find({ order: { createdAt: 'DESC' } });
  }

  // ---------------------------------------------------------------------------
  // Raw ingestion — manual entry + Excel import. ADR-065 §3/§6.
  // ---------------------------------------------------------------------------

  async recordManualPunch(input: ManualPunchInput, actorUserId: string): Promise<AttendanceRawRecord> {
    await this.hr.getEmployee(input.employeeId); // throws NotFoundException if the employee does not exist
    const saved = await this.rawRecords.save(
      this.rawRecords.create({
        sourceType: 'manual',
        sourceConnectorId: null,
        importBatchId: null,
        deviceEmployeeRef: input.employeeId,
        resolvedEmployeeId: input.employeeId,
        punchTimestamp: new Date(input.punchTimestamp),
        punchType: input.punchType,
        rawPayload: null,
        ingestedByUserId: actorUserId,
      }),
    );
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'attendance.manual_entry.created',
      resource: 'attendance_raw_record',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { employeeId: input.employeeId, punchTimestamp: input.punchTimestamp, punchType: input.punchType },
    });
    await this.deriveDay(input.employeeId, toDateOnly(saved.punchTimestamp));
    return saved;
  }

  buildImportTemplate(): Promise<Buffer> {
    return this.excel.buildTemplate('Attendance', IMPORT_COLUMNS);
  }

  /** Parses + validates only — no write. Same `ImportSummary<T>` shape a real import returns, per ADR-065 §6's Preview requirement. */
  async previewImport(buffer: Buffer): Promise<ImportSummary<AttendanceImportRow>> {
    const { rows, headerErrors } = await this.excel.parseWorkbook(buffer, IMPORT_COLUMNS);
    if (headerErrors.length > 0) return { totalRows: 0, succeeded: [], rejected: [], warnings: headerErrors };
    return this.validateRows(rows as unknown as AttendanceImportRow[]);
  }

  private validateRows(rows: AttendanceImportRow[]): ImportSummary<AttendanceImportRow> {
    const succeeded: AttendanceImportRow[] = [];
    const rejected: Array<{ row: number; errors: string[] }> = [];
    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const raw = rows[i];
      const errors: string[] = [];
      const deviceUserRef = raw.deviceUserRef?.trim();
      const punchTimestamp = raw.punchTimestamp?.trim();
      const punchType = raw.punchType?.trim().toLowerCase();
      if (!deviceUserRef) errors.push('Device/Employee Ref is required.');
      if (!punchTimestamp || Number.isNaN(Date.parse(punchTimestamp))) errors.push('Punch Timestamp must be a valid ISO date/time.');
      if (punchType && !['in', 'out', 'unknown'].includes(punchType)) errors.push('Punch Type must be "in", "out", "unknown", or left blank.');
      if (errors.length > 0) {
        rejected.push({ row: rowNumber, errors });
        continue;
      }
      succeeded.push({ deviceUserRef, punchTimestamp, punchType: punchType || 'unknown' });
    }
    return { totalRows: rows.length, succeeded, rejected, warnings: [] };
  }

  /** ADR-065 §6 — `fileHash` is the idempotency key; a byte-identical re-upload is rejected before any row is touched. */
  async importExcel(buffer: Buffer, fileName: string, actorUserId: string): Promise<AttendanceImportBatch> {
    const fileHash = createHash('sha256').update(buffer).digest('hex');
    const existing = await this.importBatches.findOne({ where: { fileHash } });
    if (existing) {
      throw new ConflictException(`This exact file was already imported as batch "${existing.id}" on ${existing.importedAt.toISOString()} — re-upload refused.`);
    }

    const { rows, headerErrors } = await this.excel.parseWorkbook(buffer, IMPORT_COLUMNS);
    if (headerErrors.length > 0) throw new ConflictException(`Import template headers are invalid: ${headerErrors.join('; ')}`);
    const summary = this.validateRows(rows as unknown as AttendanceImportRow[]);

    const batch = await this.importBatches.save(
      this.importBatches.create({
        fileHash,
        fileName,
        totalRows: summary.totalRows,
        succeededCount: summary.succeeded.length,
        rejectedCount: summary.rejected.length,
        importedByUserId: actorUserId,
      }),
    );

    const affected = new Map<string, Set<string>>();
    for (const row of summary.succeeded) {
      // Excel-sourced device refs resolve through the mapping the same way any other connector-sourced punch would —
      // this contract does not seed a real device connector, so an Excel row's ref is looked up against every active mapping.
      const mapping = await this.mappings.findOne({ where: { deviceUserRef: row.deviceUserRef, effectiveTo: IsNull() } });
      const punchTimestamp = new Date(row.punchTimestamp);
      const saved = await this.rawRecords.save(
        this.rawRecords.create({
          sourceType: 'excel_import',
          sourceConnectorId: mapping?.connectorId ?? null,
          importBatchId: batch.id,
          deviceEmployeeRef: row.deviceUserRef,
          resolvedEmployeeId: mapping?.employeeId ?? null,
          punchTimestamp,
          punchType: row.punchType as AttendancePunchType,
          rawPayload: row as unknown as Record<string, unknown>,
          ingestedByUserId: actorUserId,
        }),
      );
      if (saved.resolvedEmployeeId) {
        const set = affected.get(saved.resolvedEmployeeId) ?? new Set<string>();
        set.add(toDateOnly(punchTimestamp));
        affected.set(saved.resolvedEmployeeId, set);
      }
    }
    for (const [employeeId, dates] of affected) {
      for (const date of dates) await this.deriveDay(employeeId, date);
    }

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'attendance.import.completed',
      resource: 'attendance_import_batch',
      resourceId: batch.id,
      result: 'success',
      correlationId: null,
      after: { fileName, totalRows: summary.totalRows, succeededCount: summary.succeeded.length, rejectedCount: summary.rejected.length },
    });
    return batch;
  }

  async listUnmappedRecords(): Promise<AttendanceRawRecord[]> {
    return this.rawRecords.find({ where: { resolvedEmployeeId: IsNull() }, order: { punchTimestamp: 'DESC' }, take: 500 });
  }

  // ---------------------------------------------------------------------------
  // Biometric Daily Attendance Summary import — CTO directive (2026-09-20).
  // The confirmed real device export format: one row per employee per day.
  // AC-No. is the authoritative identity (never Name). On duty/Off duty are
  // scheduled-window facts only, never actual timestamps. Clock In/Clock Out
  // are converted into 0/1/2 punch records so the existing, ratified
  // `deriveDay` first-in/last-out rule (ADR-063 §5/§6) derives the day
  // exactly as it already does for every other source — unchanged, not
  // reopened. Late/Early/Absent/OT Time are preserved as opaque source
  // facts on `AttendanceBiometricDailyFact` for audit/display only; none of
  // them feed `deriveDay`, and `Absent = True` never directly produces a
  // payroll deduction (that boundary is Payroll's own, per ADR-067 §C).
  // ---------------------------------------------------------------------------

  buildBiometricDailyImportTemplate(): Promise<Buffer> {
    return this.excel.buildTemplate('Biometric Daily Attendance', BIOMETRIC_DAILY_COLUMNS);
  }

  /** Parses + validates only — no write. Same `ImportSummary<T>` shape every import in this service returns. */
  async previewBiometricDailyImport(buffer: Buffer): Promise<ImportSummary<BiometricDailyImportRow>> {
    const { rows, headerErrors } = await this.excel.parseWorkbook(buffer, BIOMETRIC_DAILY_COLUMNS);
    if (headerErrors.length > 0) return { totalRows: 0, succeeded: [], rejected: [], warnings: headerErrors };
    return this.validateBiometricDailyRows(rows as unknown as BiometricDailyImportRow[]);
  }

  private validateBiometricDailyRows(rows: BiometricDailyImportRow[]): ImportSummary<BiometricDailyImportRow> {
    const succeeded: BiometricDailyImportRow[] = [];
    const rejected: Array<{ row: number; errors: string[] }> = [];
    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const raw = rows[i];
      const errors: string[] = [];

      const acNo = raw.acNo?.trim();
      if (!acNo) errors.push('AC-No. is required.');

      const isoDate = raw.date?.trim() ? parseDdMmYyyy(raw.date.trim()) : null;
      if (!raw.date?.trim() || !isoDate) errors.push('Date must be a valid date in DD/MM/YYYY format.');

      const onDuty = parseHHmm(raw.onDuty ?? '');
      if (onDuty === null) errors.push('On duty must be a valid time in HH:mm format, or left blank.');
      const offDuty = parseHHmm(raw.offDuty ?? '');
      if (offDuty === null) errors.push('Off duty must be a valid time in HH:mm format, or left blank.');
      const clockIn = parseHHmm(raw.clockIn ?? '');
      if (clockIn === null) errors.push('Clock In must be a valid time in HH:mm format, or left blank.');
      const clockOut = parseHHmm(raw.clockOut ?? '');
      if (clockOut === null) errors.push('Clock Out must be a valid time in HH:mm format, or left blank.');

      const absentParsed = parseAbsentFlag(raw.absent ?? '');
      if (!absentParsed.ok) errors.push('Absent must be "True", "False", or left blank.');

      if (errors.length > 0) {
        rejected.push({ row: rowNumber, errors });
        continue;
      }

      succeeded.push({
        acNo: acNo!,
        name: raw.name?.trim() ?? '',
        date: isoDate!,
        onDuty: onDuty!,
        offDuty: offDuty!,
        clockIn: clockIn!,
        clockOut: clockOut!,
        late: raw.late?.trim() ?? '',
        early: raw.early?.trim() ?? '',
        absent: raw.absent?.trim() ?? '',
        otTime: raw.otTime?.trim() ?? '',
      });
    }
    return { totalRows: rows.length, succeeded, rejected, warnings: [] };
  }

  /** `fileHash` idempotency — same shape as `importExcel` (ADR-065 §6): a byte-identical re-upload is rejected before any row is touched. A different file that re-reports an already-imported (AC-No., Date) row upserts that one fact row in place (§9's row-level idempotency) rather than duplicating it. */
  async importBiometricDailySummary(buffer: Buffer, fileName: string, actorUserId: string): Promise<AttendanceImportBatch> {
    const fileHash = createHash('sha256').update(buffer).digest('hex');
    const existing = await this.importBatches.findOne({ where: { fileHash } });
    if (existing) {
      throw new ConflictException(`This exact file was already imported as batch "${existing.id}" on ${existing.importedAt.toISOString()} — re-upload refused.`);
    }

    const { rows, headerErrors } = await this.excel.parseWorkbook(buffer, BIOMETRIC_DAILY_COLUMNS);
    if (headerErrors.length > 0) throw new ConflictException(`Import template headers are invalid: ${headerErrors.join('; ')}`);
    const summary = this.validateBiometricDailyRows(rows as unknown as BiometricDailyImportRow[]);

    const batch = await this.importBatches.save(
      this.importBatches.create({
        fileHash,
        fileName,
        totalRows: summary.totalRows,
        succeededCount: summary.succeeded.length,
        rejectedCount: summary.rejected.length,
        importedByUserId: actorUserId,
      }),
    );

    for (const row of summary.succeeded) {
      await this.upsertBiometricDailyFact(row, batch.id, actorUserId);
    }

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'attendance.biometric_import.completed',
      resource: 'attendance_import_batch',
      resourceId: batch.id,
      result: 'success',
      correlationId: null,
      after: { fileName, totalRows: summary.totalRows, succeededCount: summary.succeeded.length, rejectedCount: summary.rejected.length },
    });
    return batch;
  }

  private async upsertBiometricDailyFact(row: BiometricDailyImportRow, importBatchId: string, actorUserId: string): Promise<void> {
    const absentParsed = parseAbsentFlag(row.absent);
    const sourceAbsent = absentParsed.ok ? absentParsed.value : null;

    // AC-No. is the authoritative identity — resolved connector-agnostically against any active
    // mapping, mirroring how Excel-sourced raw records already resolve (no device connector is
    // seeded for a file-based import). Never resolved by Name.
    const mapping = await this.mappings.findOne({ where: { deviceUserRef: row.acNo, effectiveTo: IsNull() } });

    let fact = await this.biometricFacts.findOne({ where: { deviceUserRef: row.acNo, calendarDate: row.date } });
    fact = fact ?? this.biometricFacts.create({ deviceUserRef: row.acNo, calendarDate: row.date });
    fact.importBatchId = importBatchId;
    fact.sourceName = row.name || null;
    fact.resolvedEmployeeId = mapping?.employeeId ?? null;
    fact.sourceConnectorId = mapping?.connectorId ?? null;
    fact.onDuty = row.onDuty || null;
    fact.offDuty = row.offDuty || null;
    fact.clockIn = row.clockIn || null;
    fact.clockOut = row.clockOut || null;
    fact.lateValue = row.late || null;
    fact.earlyValue = row.early || null;
    fact.otTimeValue = row.otTime || null;
    fact.sourceAbsent = sourceAbsent;
    fact.rawPayload = row as unknown as Record<string, unknown>;
    fact.ingestedByUserId = actorUserId;
    fact.updatedAt = new Date();
    const saved = await this.biometricFacts.save(fact);

    // Unmapped AC-No.: preserved (the fact row above), never auto-assigned to another employee,
    // never auto-creates an Employee. No punch records are produced until a mapping resolves it.
    if (saved.resolvedEmployeeId) {
      await this.applyBiometricFactToDay(saved);
    }
  }

  /** Converts one resolved biometric fact row into 0/1/2 punch records and re-derives that day — reused at import time and at retroactive-mapping time (createMapping). Idempotent: only THIS fact's own biometric-sourced punches for this employee/day are replaced, never another source's. */
  private async applyBiometricFactToDay(fact: AttendanceBiometricDailyFact): Promise<void> {
    const employeeId = fact.resolvedEmployeeId;
    if (!employeeId) return;

    const dayStart = new Date(`${fact.calendarDate}T00:00:00.000Z`);
    const dayEnd = new Date(`${fact.calendarDate}T23:59:59.999Z`);
    await this.rawRecords.delete({ sourceType: 'biometric', resolvedEmployeeId: employeeId, punchTimestamp: Between(dayStart, dayEnd) });

    const punches: Array<{ punchTimestamp: Date; punchType: AttendancePunchType }> = [];
    // Clock In/Clock Out are the ONLY source of actual attendance timestamps (directive §3) —
    // On duty/Off duty (the scheduled window) never contribute a punch. A blank Clock In/Out
    // remains blank: no punch time is ever inferred or manufactured.
    if (fact.clockIn) punches.push({ punchTimestamp: combineDateAndTime(fact.calendarDate, fact.clockIn), punchType: 'in' });
    if (fact.clockOut) punches.push({ punchTimestamp: combineDateAndTime(fact.calendarDate, fact.clockOut), punchType: 'out' });

    for (const p of punches) {
      await this.rawRecords.save(
        this.rawRecords.create({
          sourceType: 'biometric',
          sourceConnectorId: fact.sourceConnectorId,
          importBatchId: fact.importBatchId,
          deviceEmployeeRef: fact.deviceUserRef,
          resolvedEmployeeId: employeeId,
          punchTimestamp: p.punchTimestamp,
          punchType: p.punchType,
          rawPayload: fact.rawPayload,
          ingestedByUserId: fact.ingestedByUserId,
        }),
      );
    }

    // Zero punches (e.g. Absent = True with blank Clock In/Out) is a deliberate, expected case —
    // `deriveDay` already derives `status = 'absent'` from zero same-day punches, unchanged.
    await this.deriveDay(employeeId, fact.calendarDate);
  }

  async listUnmappedBiometricRows(): Promise<AttendanceBiometricDailyFact[]> {
    return this.biometricFacts.find({ where: { resolvedEmployeeId: IsNull() }, order: { calendarDate: 'DESC' }, take: 500 });
  }

  async listBiometricFacts(employeeId?: string): Promise<AttendanceBiometricDailyFact[]> {
    return this.biometricFacts.find({ where: employeeId ? { resolvedEmployeeId: employeeId } : {}, order: { calendarDate: 'DESC' }, take: 500 });
  }

  /** "Import history/status" — every `AttendanceImportBatch` that produced at least one biometric fact row. No new column on the shared batch table: derived from `AttendanceBiometricDailyFact.importBatchId`, which the punch-log Excel importer never populates. */
  async listBiometricImportBatches(): Promise<AttendanceImportBatch[]> {
    const rows = await this.biometricFacts.createQueryBuilder('f').select('DISTINCT f."importBatchId"', 'importBatchId').where('f."importBatchId" IS NOT NULL').getRawMany<{ importBatchId: string }>();
    const ids = rows.map((r) => r.importBatchId);
    if (ids.length === 0) return [];
    return this.importBatches.find({ where: { id: In(ids) }, order: { importedAt: 'DESC' } });
  }

  // ---------------------------------------------------------------------------
  // Processing — ADR-065 §5, implements the ratified derivation rule exactly.
  // ---------------------------------------------------------------------------

  /** Re-derives (or first-derives) one employee's one calendar day. A no-op if that day already belongs to an APPROVED batch (§8:C's own gate — never silently mutated outside the correction flow). */
  async deriveDay(employeeId: string, calendarDate: string): Promise<AttendanceDay | null> {
    const existing = await this.days.findOne({ where: { employeeId, calendarDate } });
    if (existing?.batchId) {
      const batch = await this.approvalBatches.findOne({ where: { id: existing.batchId } });
      if (batch?.status === 'approved') return existing; // protected — correction-only from here
    }

    const onLeave = await this.hr.isApprovedLeaveDate(employeeId, calendarDate);
    let status: AttendanceDayStatus;
    let checkIn: Date | null = null;
    let checkOut: Date | null = null;
    let hoursWorked: string | null = null;

    if (onLeave) {
      status = 'on_leave';
    } else {
      const dayStart = new Date(`${calendarDate}T00:00:00.000Z`);
      const dayEnd = new Date(`${calendarDate}T23:59:59.999Z`);
      const sameDay = await this.rawRecords.find({
        where: { resolvedEmployeeId: employeeId, punchTimestamp: Between(dayStart, dayEnd) },
        order: { punchTimestamp: 'ASC' },
      });
      if (sameDay.length === 0) {
        status = 'absent';
      } else if (sameDay.length === 1) {
        status = 'missing_punch';
        checkIn = sameDay[0].punchTimestamp;
      } else {
        checkIn = sameDay[0].punchTimestamp;
        checkOut = sameDay[sameDay.length - 1].punchTimestamp;
        status = 'present';
        hoursWorked = ((checkOut.getTime() - checkIn.getTime()) / 3_600_000).toFixed(4);
      }
    }

    const day = existing ?? this.days.create({ employeeId, calendarDate });
    day.status = status;
    day.checkIn = checkIn;
    day.checkOut = checkOut;
    day.hoursWorked = hoursWorked;
    return this.days.save(day);
  }

  async listDays(employeeId?: string): Promise<AttendanceDay[]> {
    return this.days.find({ where: employeeId ? { employeeId } : {}, order: { calendarDate: 'DESC' } });
  }

  // ---------------------------------------------------------------------------
  // Approval batches — ADR-065 §5, FA-01, zero new mechanism.
  // ---------------------------------------------------------------------------

  async submitApprovalBatch(periodStart: string, periodEnd: string, actorUserId: string): Promise<AttendanceApprovalBatch> {
    if (periodStart > periodEnd) throw new ConflictException('periodStart must be on or before periodEnd.');
    const inRange = await this.days.find({
      where: { calendarDate: Between(periodStart, periodEnd), batchId: IsNull() },
    });
    if (inRange.length === 0) {
      throw new ConflictException('No un-batched attendance days exist in this period.');
    }

    const batch = await this.approvalBatches.save(this.approvalBatches.create({ periodStart, periodEnd, status: 'draft', createdByUserId: actorUserId }));
    await this.days.update(inRange.map((d) => d.id), { batchId: batch.id });

    let approvalRequest: { id: string };
    try {
      approvalRequest = await this.approvals.submit({
        requestTypeCode: APPROVAL_BATCH_TYPE,
        resourceType: 'attendance_approval_batch',
        resourceId: batch.id,
        requestedAction: 'approve',
        payload: { periodStart, periodEnd, dayCount: inRange.length },
        makerUserId: actorUserId,
      });
    } catch (err) {
      // ApprovalEngineService.submit failed after the days were already stamped with this
      // batch's id — unlike a rejected batch (onApprovalRejected), nothing would otherwise
      // ever clear that batchId, permanently excluding these days from every future
      // submission attempt (they'd never again match `batchId: IsNull()`). Reverse the
      // stamp and drop the orphaned draft batch so the days remain submittable.
      await this.days.update(inRange.map((d) => d.id), { batchId: null as unknown as string });
      await this.approvalBatches.delete(batch.id);
      throw err;
    }
    batch.approvalRequestId = approvalRequest.id;
    batch.status = 'submitted';
    await this.approvalBatches.save(batch);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'attendance.approval_batch.submitted',
      resource: 'attendance_approval_batch',
      resourceId: batch.id,
      result: 'success',
      correlationId: approvalRequest.id,
      after: { periodStart, periodEnd, dayCount: inRange.length },
    });
    return batch;
  }

  async listApprovalBatches(): Promise<AttendanceApprovalBatch[]> {
    return this.approvalBatches.find({ order: { createdAt: 'DESC' } });
  }

  /** Pure pass-through to the generic engine — same shape as every other FA-01 consumer's own `decide`. */
  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string | null): Promise<unknown> {
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null);
  }

  // ---------------------------------------------------------------------------
  // Correction — ADR-065 §5, ratified ADR-063 §8: C (split by batch status).
  // ---------------------------------------------------------------------------

  async correctDay(
    dayId: string,
    input: { checkIn?: string | null; checkOut?: string | null; reason: string },
    actorUserId: string,
  ): Promise<{ applied: boolean; day?: AttendanceDay; correctionRequestId?: string }> {
    const day = await this.days.findOne({ where: { id: dayId } });
    if (!day) throw new NotFoundException(`Attendance day "${dayId}" not found.`);

    const batch = day.batchId ? await this.approvalBatches.findOne({ where: { id: day.batchId } }) : null;
    const requiresApproval = batch?.status === 'approved';

    const proposedCheckIn = input.checkIn !== undefined ? (input.checkIn ? new Date(input.checkIn) : null) : day.checkIn;
    const proposedCheckOut = input.checkOut !== undefined ? (input.checkOut ? new Date(input.checkOut) : null) : day.checkOut;

    if (!requiresApproval) {
      const before = { checkIn: day.checkIn, checkOut: day.checkOut, status: day.status, hoursWorked: day.hoursWorked };
      day.checkIn = proposedCheckIn;
      day.checkOut = proposedCheckOut;
      day.hoursWorked = proposedCheckIn && proposedCheckOut ? ((proposedCheckOut.getTime() - proposedCheckIn.getTime()) / 3_600_000).toFixed(4) : null;
      day.status = proposedCheckIn && proposedCheckOut ? 'present' : proposedCheckIn || proposedCheckOut ? 'missing_punch' : day.status;
      day.correctedByUserId = actorUserId;
      day.correctedAt = new Date();
      const saved = await this.days.save(day);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'attendance.day.corrected',
        resource: 'attendance_day',
        resourceId: dayId,
        result: 'success',
        correlationId: null,
        before,
        after: { checkIn: saved.checkIn, checkOut: saved.checkOut, status: saved.status, hoursWorked: saved.hoursWorked, reason: input.reason },
      });
      return { applied: true, day: saved };
    }

    // Batch already approved — ADR-063 §8: C requires FA-01 re-approval.
    const approvalRequest = await this.approvals.submit({
      requestTypeCode: CORRECTION_TYPE,
      resourceType: 'attendance_day',
      resourceId: dayId,
      requestedAction: 'approve',
      payload: {
        attendanceDayId: dayId,
        proposedCheckIn: proposedCheckIn?.toISOString() ?? null,
        proposedCheckOut: proposedCheckOut?.toISOString() ?? null,
        reason: input.reason,
      },
      makerUserId: actorUserId,
    });
    const correctionRequest = await this.correctionRequests.save(
      this.correctionRequests.create({
        attendanceDayId: dayId,
        approvalRequestId: approvalRequest.id,
        proposedCheckIn,
        proposedCheckOut,
        reason: input.reason,
        requestedByUserId: actorUserId,
      }),
    );
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'attendance.correction.requested',
      resource: 'attendance_day',
      resourceId: dayId,
      result: 'success',
      correlationId: approvalRequest.id,
      after: { proposedCheckIn: proposedCheckIn?.toISOString() ?? null, proposedCheckOut: proposedCheckOut?.toISOString() ?? null, reason: input.reason },
    });
    return { applied: false, correctionRequestId: correctionRequest.id };
  }

  // ---------------------------------------------------------------------------
  // FA-01 subscribers — ADR-046 D7 pattern, idempotent against duplicate delivery.
  // ---------------------------------------------------------------------------

  private async onApprovalApproved(payload: Record<string, unknown>): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    const resourceId = String(payload.resourceId ?? '');

    if (requestTypeCode === APPROVAL_BATCH_TYPE) {
      const batch = await this.approvalBatches.findOne({ where: { id: resourceId } });
      if (!batch || batch.status === 'approved') return; // not found, or already applied — benign no-op
      batch.status = 'approved';
      batch.decidedAt = new Date();
      await this.approvalBatches.save(batch);
      await this.events.publish(this.dataSource.manager, 'attendance.period.approved', {
        batchId: batch.id,
        periodStart: batch.periodStart,
        periodEnd: batch.periodEnd,
      });
      await this.audit.record({
        actorUserId: SYSTEM_ACTOR_ID,
        organizationId: null,
        action: 'attendance.approval_batch.approved',
        resource: 'attendance_approval_batch',
        resourceId: batch.id,
        result: 'success',
        correlationId: String(payload.approvalRequestId ?? ''),
      });
      return;
    }

    if (requestTypeCode === CORRECTION_TYPE) {
      const correctionRequest = await this.correctionRequests.findOne({ where: { approvalRequestId: String(payload.approvalRequestId ?? '') } });
      if (!correctionRequest) return;
      const day = await this.days.findOne({ where: { id: correctionRequest.attendanceDayId } });
      if (!day) return;
      const before = { checkIn: day.checkIn, checkOut: day.checkOut, status: day.status, hoursWorked: day.hoursWorked };
      day.checkIn = correctionRequest.proposedCheckIn;
      day.checkOut = correctionRequest.proposedCheckOut;
      day.hoursWorked =
        correctionRequest.proposedCheckIn && correctionRequest.proposedCheckOut
          ? ((correctionRequest.proposedCheckOut.getTime() - correctionRequest.proposedCheckIn.getTime()) / 3_600_000).toFixed(4)
          : null;
      day.status = correctionRequest.proposedCheckIn && correctionRequest.proposedCheckOut ? 'present' : correctionRequest.proposedCheckIn || correctionRequest.proposedCheckOut ? 'missing_punch' : day.status;
      day.correctedByUserId = correctionRequest.requestedByUserId;
      day.correctedAt = new Date();
      await this.days.save(day);
      await this.audit.record({
        actorUserId: SYSTEM_ACTOR_ID,
        organizationId: null,
        action: 'attendance.correction.applied',
        resource: 'attendance_day',
        resourceId: day.id,
        result: 'success',
        correlationId: correctionRequest.approvalRequestId,
        before,
        after: { checkIn: day.checkIn, checkOut: day.checkOut, status: day.status, hoursWorked: day.hoursWorked },
      });
    }
  }

  /** A rejected batch clears `batchId` off its days so they become eligible for a fresh submission — a safe, reversible, non-financial recovery, not a new policy. Rejected corrections need no action (the day is simply left as it was, matching this codebase's existing "no domain subscribes to rejected" convention for pure requests). */
  private async onApprovalRejected(payload: Record<string, unknown>): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== APPROVAL_BATCH_TYPE) return;
    const resourceId = String(payload.resourceId ?? '');
    const batch = await this.approvalBatches.findOne({ where: { id: resourceId } });
    if (!batch || batch.status === 'rejected') return;
    batch.status = 'rejected';
    batch.decidedAt = new Date();
    await this.approvalBatches.save(batch);
    await this.days.update({ batchId: batch.id }, { batchId: null as unknown as string });
  }
}
