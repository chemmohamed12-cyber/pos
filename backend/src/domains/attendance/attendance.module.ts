import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttendanceConnector } from './infrastructure/attendance-connector.entity';
import { AttendanceEmployeeMapping } from './infrastructure/attendance-employee-mapping.entity';
import { AttendanceImportBatch } from './infrastructure/attendance-import-batch.entity';
import { AttendanceRawRecord } from './infrastructure/attendance-raw-record.entity';
import { AttendanceDay } from './infrastructure/attendance-day.entity';
import { AttendanceApprovalBatch } from './infrastructure/attendance-approval-batch.entity';
import { AttendanceCorrectionRequest } from './infrastructure/attendance-correction-request.entity';
import { AttendanceService } from './application/attendance.service';
import { AttendanceController } from './interface/attendance.controller';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { EventsModule } from '../../foundation/events/events.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { ApprovalEngineModule } from '../../foundation/approval-engine/approval-engine.module';
import { ExcelModule } from '../../foundation/excel/excel.module';
import { HrModule } from '../hr/hr.module';

/**
 * ADR-065 — `attendance`'s composition root, Phase 1. `HrModule` is this
 * module's one real cross-domain import (`HrService.isApprovedLeaveDate`,
 * ratified `ADR-063 §3: B`) — declared in the manifest's `depends_on`
 * too. No other `src/domains/*` sibling is imported.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AttendanceConnector,
      AttendanceEmployeeMapping,
      AttendanceImportBatch,
      AttendanceRawRecord,
      AttendanceDay,
      AttendanceApprovalBatch,
      AttendanceCorrectionRequest,
    ]),
    AuthenticationModule,
    EventsModule,
    PermissionModule,
    AuditModule,
    ApprovalEngineModule,
    ExcelModule,
    HrModule,
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
