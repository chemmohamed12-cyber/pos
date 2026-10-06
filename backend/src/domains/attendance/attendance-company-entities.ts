import { AttendanceApprovalBatch } from './infrastructure/attendance-approval-batch.entity';
import { AttendanceBiometricDailyFact } from './infrastructure/attendance-biometric-daily-fact.entity';
import { AttendanceConnector } from './infrastructure/attendance-connector.entity';
import { AttendanceCorrectionRequest } from './infrastructure/attendance-correction-request.entity';
import { AttendanceDay } from './infrastructure/attendance-day.entity';
import { AttendanceEmployeeMapping } from './infrastructure/attendance-employee-mapping.entity';
import { AttendanceImportBatch } from './infrastructure/attendance-import-batch.entity';
import { AttendanceRawRecord } from './infrastructure/attendance-raw-record.entity';

/**
 * ADR-074 (Hybrid B). attendance's own Company-connection-capable entities — added 2026-10-05 (Area 21, CTO-authorized).
 */
export const ATTENDANCE_COMPANY_ENTITIES = [AttendanceApprovalBatch, AttendanceBiometricDailyFact, AttendanceConnector, AttendanceCorrectionRequest, AttendanceDay, AttendanceEmployeeMapping, AttendanceImportBatch, AttendanceRawRecord];
