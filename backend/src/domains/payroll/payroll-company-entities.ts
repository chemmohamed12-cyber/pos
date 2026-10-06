import { PayrollAdjustment } from './infrastructure/payroll-adjustment.entity';
import { PayrollAttendanceDayClassification } from './infrastructure/payroll-attendance-day-classification.entity';
import { PayrollCompensation } from './infrastructure/payroll-compensation.entity';
import { PayrollDeductionLine } from './infrastructure/payroll-deduction-line.entity';
import { PayrollEarningLine } from './infrastructure/payroll-earning-line.entity';
import { PayrollPeriod } from './infrastructure/payroll-period.entity';
import { PayrollRunLine } from './infrastructure/payroll-run-line.entity';
import { PayrollRun } from './infrastructure/payroll-run.entity';

/**
 * ADR-074 (Hybrid B). payroll's own Company-connection-capable entities — added 2026-10-05 (Area 21, CTO-authorized).
 */
export const PAYROLL_COMPANY_ENTITIES = [PayrollAdjustment, PayrollAttendanceDayClassification, PayrollCompensation, PayrollDeductionLine, PayrollEarningLine, PayrollPeriod, PayrollRunLine, PayrollRun];
