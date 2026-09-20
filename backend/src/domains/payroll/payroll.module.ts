import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PayrollPeriod } from './infrastructure/payroll-period.entity';
import { PayrollCompensation } from './infrastructure/payroll-compensation.entity';
import { PayrollEarningLine } from './infrastructure/payroll-earning-line.entity';
import { PayrollRun } from './infrastructure/payroll-run.entity';
import { PayrollRunLine } from './infrastructure/payroll-run-line.entity';
import { PayrollAttendanceDayClassification } from './infrastructure/payroll-attendance-day-classification.entity';
import { PayrollDeductionLine } from './infrastructure/payroll-deduction-line.entity';
import { PayrollAdjustment } from './infrastructure/payroll-adjustment.entity';
import { PayrollService } from './application/payroll.service';
import { PayrollController } from './interface/payroll.controller';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { EventsModule } from '../../foundation/events/events.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { ApprovalEngineModule } from '../../foundation/approval-engine/approval-engine.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { HrModule } from '../hr/hr.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { TreasuryModule } from '../treasury/treasury.module';

/**
 * ADR-070 — `payroll`'s composition root, Phase 1. `HrModule` (Employee
 * identity, read-only) and `AttendanceModule` (`listApprovedDaysByBatch`,
 * `ADR-070 §9`, read-only) are this module's real cross-domain imports —
 * declared in the manifest's `depends_on` too. `AccountingModule` is
 * deliberately NOT imported — Payroll reaches Accounting only through the
 * Transactional Outbox (`payroll.run.posted`), never a code import
 * (`ADR-070 §3`, mirrors `manufacturing`'s own precedent).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PayrollPeriod,
      PayrollCompensation,
      PayrollEarningLine,
      PayrollRun,
      PayrollRunLine,
      PayrollAttendanceDayClassification,
      PayrollDeductionLine,
      PayrollAdjustment,
    ]),
    AuthenticationModule,
    EventsModule,
    PermissionModule,
    AuditModule,
    ApprovalEngineModule,
    ProcessEngineModule,
    NumberingModule,
    HrModule,
    AttendanceModule,
    TreasuryModule,
  ],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}
