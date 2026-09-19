import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, IsNull, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { AttendanceConnector } from '../infrastructure/attendance-connector.entity';
import { AttendanceEmployeeMapping } from '../infrastructure/attendance-employee-mapping.entity';
import { AttendanceImportBatch } from '../infrastructure/attendance-import-batch.entity';
import { AttendanceRawRecord } from '../infrastructure/attendance-raw-record.entity';
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

    const approvalRequest = await this.approvals.submit({
      requestTypeCode: APPROVAL_BATCH_TYPE,
      resourceType: 'attendance_approval_batch',
      resourceId: batch.id,
      requestedAction: 'approve',
      payload: { periodStart, periodEnd, dayCount: inRange.length },
      makerUserId: actorUserId,
    });
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
