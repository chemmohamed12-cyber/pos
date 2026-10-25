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
import { PayrollException } from './infrastructure/payroll-exception.entity';
import { PayrollInputConsumption } from './infrastructure/payroll-input-consumption.entity';
import { PayrollPayoutBatch } from './infrastructure/payroll-payout-batch.entity';
import { PayrollPayoutItem } from './infrastructure/payroll-payout-item.entity';
import { PayrollRunStageActor } from './infrastructure/payroll-run-stage-actor.entity';
import { PayrollSetting } from './infrastructure/payroll-setting.entity';
import { PayrollService } from './application/payroll.service';
import { PayrollSodService } from './application/payroll-sod.service';
import { PayrollExceptionService } from './application/payroll-exception.service';
import { PayrollPayoutService } from './application/payroll-payout.service';
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
import { CommissionModule } from '../commission/commission.module';

import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';
/**
 * ADR-070 — `payroll`'s composition root, Phase 1. `HrModule` (Employee
 * identity, read-only), `AttendanceModule` (`listApprovedDaysByBatch`,
 * `ADR-070 §9`, read-only), and `CommissionModule`
 * (`listApprovedCommissionResults`, `ADR-070 §J`, read-only) are this
 * module's real cross-domain imports — declared in the manifest's
 * `depends_on` too. `AccountingModule` is deliberately NOT imported —
 * Payroll reaches Accounting only through the Transactional Outbox
 * (`payroll.run.posted`), never a code import (`ADR-070 §3`, mirrors
 * `manufacturing`'s own precedent).
 */
@Module({
  imports: [CompanyModule, DatabaseRegistryModule, 
    TypeOrmModule.forFeature([
      PayrollPeriod,
      PayrollCompensation,
      PayrollEarningLine,
      PayrollRun,
      PayrollRunLine,
      PayrollAttendanceDayClassification,
      PayrollDeductionLine,
      PayrollAdjustment,
      PayrollException,
      PayrollInputConsumption,
      PayrollPayoutBatch,
      PayrollPayoutItem,
      PayrollRunStageActor,
      PayrollSetting,
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
    CommissionModule,
  ],
  controllers: [PayrollController],
  providers: [PayrollService, PayrollSodService, PayrollExceptionService, PayrollPayoutService],
  exports: [PayrollService],
})
export class PayrollModule {}
