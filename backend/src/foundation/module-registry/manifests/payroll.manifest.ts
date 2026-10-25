import { ModuleManifest } from '../module-manifest.type';

/**
 * ADR-070 — `payroll` module manifest, promoted from `ReservedModuleCode`
 * (ADR-070 §2, the same mechanism `hr`/`accounting`/`procurement`/
 * `manufacturing` already went through).
 *
 * `depends_on: ['hr', 'attendance', 'finance', 'commission']` — `hr` for
 * `Employee` identity (read-only); `attendance` for
 * `listApprovedDaysByBatch` (read-only, `ADR-070 §9`); `finance` for the
 * Treasury contract token disbursement uses (`FINANCE_TREASURY_CONTRACT`,
 * same dependency-inversion pattern `procurement`'s own manifest already
 * documents); `commission` for `listApprovedCommissionResults`
 * (read-only, `ADR-070 §J`/`ADR-071 §9`). `accounting` is deliberately NOT
 * listed — Payroll reaches Accounting only via the Transactional Outbox
 * event bus (`payroll.run.posted`), never a code import, the same
 * precedent `manufacturing`'s own manifest already established.
 */
export const payrollManifest: ModuleManifest = {
  module_code: 'payroll',
  manifest_version: '1.0.0',
  title_code: 'module.payroll',
  business_domains: ['payroll'],
  depends_on: ['hr', 'attendance', 'finance', 'commission'],

  permission_nodes: [
    { node: 'payroll', title_code: 'perm.payroll' },

    { node: 'payroll.compensation', title_code: 'perm.payroll.compensation', parent: 'payroll' },
    { node: 'payroll.compensation.view', title_code: 'perm.payroll.compensation.view', parent: 'payroll.compensation' },
    { node: 'payroll.compensation.create', title_code: 'perm.payroll.compensation.create', parent: 'payroll.compensation' },

    { node: 'payroll.period', title_code: 'perm.payroll.period', parent: 'payroll' },
    { node: 'payroll.period.view', title_code: 'perm.payroll.period.view', parent: 'payroll.period' },
    { node: 'payroll.period.create', title_code: 'perm.payroll.period.create', parent: 'payroll.period' },
    { node: 'payroll.period.close', title_code: 'perm.payroll.period.close', parent: 'payroll.period' },

    { node: 'payroll.run', title_code: 'perm.payroll.run', parent: 'payroll' },
    { node: 'payroll.run.view', title_code: 'perm.payroll.run.view', parent: 'payroll.run' },
    { node: 'payroll.run.create', title_code: 'perm.payroll.run.create', parent: 'payroll.run' },
    { node: 'payroll.run.calculate', title_code: 'perm.payroll.run.calculate', parent: 'payroll.run' },
    { node: 'payroll.run.review', title_code: 'perm.payroll.run.review', parent: 'payroll.run' },
    { node: 'payroll.run.submit', title_code: 'perm.payroll.run.submit', parent: 'payroll.run' },
    { node: 'payroll.run.approve', title_code: 'perm.payroll.run.approve', parent: 'payroll.run' },
    { node: 'payroll.run.disburse', title_code: 'perm.payroll.run.disburse', parent: 'payroll.run' },

    { node: 'payroll.exception', title_code: 'perm.payroll.exception', parent: 'payroll' },
    { node: 'payroll.exception.acknowledge', title_code: 'perm.payroll.exception.acknowledge', parent: 'payroll.exception' },

    { node: 'payroll.settings', title_code: 'perm.payroll.settings', parent: 'payroll' },
    { node: 'payroll.settings.view', title_code: 'perm.payroll.settings.view', parent: 'payroll.settings' },
    { node: 'payroll.settings.manage', title_code: 'perm.payroll.settings.manage', parent: 'payroll.settings' },

    { node: 'payroll.adjustment', title_code: 'perm.payroll.adjustment', parent: 'payroll' },
    { node: 'payroll.adjustment.create', title_code: 'perm.payroll.adjustment.create', parent: 'payroll.adjustment' },

    { node: 'payroll.deduction', title_code: 'perm.payroll.deduction', parent: 'payroll' },
    { node: 'payroll.deduction.create', title_code: 'perm.payroll.deduction.create', parent: 'payroll.deduction' },
  ],

  feature_codes: [{ code: 'payroll.core', title_code: 'feat.payroll.core', default: false, toggleable: true }],

  limit_keys: [],

  config_keys: [],

  migration_tag: 'payroll',

  public_contract: {
    commands: [
      'CreatePayrollPeriod',
      'CreatePayrollCompensation',
      'CalculatePayrollRun',
      'CalculatePayrollSupplementaryRun',
      'ClosePayrollPeriod',
      'AcknowledgePayrollException',
      'CreatePayrollPayoutBatch',
      'ExecutePayrollPayoutBatch',
      'ReviewPayrollRun',
      'SubmitPayrollRunApproval',
      'DecidePayrollRunApproval',
      'CreatePayrollAdjustment',
    ],
    queries: ['ListPayrollPeriods', 'ListPayrollCompensations', 'ListPayrollRuns', 'GetPayrollRun', 'ListPayrollReconciliationGaps'],
    events: ['payroll.run.posted', 'payroll.payout.settled'],
  },
};
