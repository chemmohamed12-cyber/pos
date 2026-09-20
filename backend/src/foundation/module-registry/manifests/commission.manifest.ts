import { ModuleManifest } from '../module-manifest.type';

/**
 * ADR-071 §4 — `commission` module manifest. A genuinely new module code
 * (never previously reserved, confirmed `module-manifest.type.ts`), the
 * same situation `targets` is in — not a promotion.
 * `depends_on: ['hr', 'targets']` — `hr` for Sales-Rep-as-Employee
 * identity (read-only); `targets` for `getApprovedTargetForDate` (read-only,
 * `ADR-071 §9`). `crm`/`sales`/`customer-finance` are deliberately NOT
 * listed — Commission reaches those domains only by reading their tables
 * directly (the same "read another domain's table, no entity import"
 * precedent Payroll already established for `accounting_financial_events`),
 * never a code import, and only ever subscribes to their already-published
 * event topics (`finance.invoice.posted`, `collection.remitted`), never a
 * new event Commission invents.
 */
export const commissionManifest: ModuleManifest = {
  module_code: 'commission',
  manifest_version: '1.0.0',
  title_code: 'module.commission',
  business_domains: ['commission'],
  depends_on: ['hr', 'targets'],

  permission_nodes: [
    { node: 'commission', title_code: 'perm.commission' },

    { node: 'commission.policy', title_code: 'perm.commission.policy', parent: 'commission' },
    { node: 'commission.policy.view', title_code: 'perm.commission.policy.view', parent: 'commission.policy' },
    { node: 'commission.policy.create', title_code: 'perm.commission.policy.create', parent: 'commission.policy' },

    { node: 'commission.result', title_code: 'perm.commission.result', parent: 'commission' },
    { node: 'commission.result.view', title_code: 'perm.commission.result.view', parent: 'commission.result' },

    { node: 'commission.batch', title_code: 'perm.commission.batch', parent: 'commission' },
    { node: 'commission.batch.submit', title_code: 'perm.commission.batch.submit', parent: 'commission.batch' },
    { node: 'commission.batch.approve', title_code: 'perm.commission.batch.approve', parent: 'commission.batch' },

    { node: 'commission.adjustment', title_code: 'perm.commission.adjustment', parent: 'commission' },
    { node: 'commission.adjustment.create', title_code: 'perm.commission.adjustment.create', parent: 'commission.adjustment' },
  ],

  feature_codes: [{ code: 'commission.core', title_code: 'feat.commission.core', default: false, toggleable: true }],

  limit_keys: [],

  config_keys: [],

  migration_tag: 'commission',

  public_contract: {
    commands: ['CreateCommissionPolicy', 'SubmitCommissionApprovalBatch', 'DecideCommissionApprovalBatch', 'CreateCommissionAdjustment'],
    queries: ['ListCommissionPolicies', 'ListCommissionResults', 'ListApprovedCommissionResults'],
    events: [],
  },
};
