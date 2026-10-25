import { PayrollAdjustment } from './infrastructure/payroll-adjustment.entity';
import { PayrollAttendanceDayClassification } from './infrastructure/payroll-attendance-day-classification.entity';
import { PayrollCompensation } from './infrastructure/payroll-compensation.entity';
import { PayrollDeductionLine } from './infrastructure/payroll-deduction-line.entity';
import { PayrollEarningLine } from './infrastructure/payroll-earning-line.entity';
import { PayrollException } from './infrastructure/payroll-exception.entity';
import { PayrollInputConsumption } from './infrastructure/payroll-input-consumption.entity';
import { PayrollPayoutBatch } from './infrastructure/payroll-payout-batch.entity';
import { PayrollPayoutItem } from './infrastructure/payroll-payout-item.entity';
import { PayrollPeriod } from './infrastructure/payroll-period.entity';
import { PayrollRunLine } from './infrastructure/payroll-run-line.entity';
import { PayrollRunStageActor } from './infrastructure/payroll-run-stage-actor.entity';
import { PayrollRun } from './infrastructure/payroll-run.entity';
import { PayrollSetting } from './infrastructure/payroll-setting.entity';

/**
 * ADR-074 (Hybrid B). payroll's own Company-connection-capable entities — added 2026-10-05 (Area 21, CTO-authorized);
 * gap-closure entities (stage actors, exceptions, input consumptions, payouts, settings) added 2026-10-25.
 */
export const PAYROLL_COMPANY_ENTITIES = [
  PayrollAdjustment,
  PayrollAttendanceDayClassification,
  PayrollCompensation,
  PayrollDeductionLine,
  PayrollEarningLine,
  PayrollException,
  PayrollInputConsumption,
  PayrollPayoutBatch,
  PayrollPayoutItem,
  PayrollPeriod,
  PayrollRunLine,
  PayrollRunStageActor,
  PayrollRun,
  PayrollSetting,
];
