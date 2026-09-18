import { ModuleManifest } from '../module-manifest.type';

/**
 * ERP Foundation — P1. `reporting` module manifest.
 * O-6 RESOLVED (CTO, 2026-09-06): reporting is a GATED module — it can be
 * sold or withheld as a commercial capability ("BI add-on"); disabling it
 * removes all reporting endpoints (404). Every current Edition includes it,
 * so today's behaviour is unchanged.
 *
 * `depends_on: ['sales', 'inventory', 'logistics', 'finance']` — the ACTUAL
 * non-spec code graph (C-8): `reports/application/*.service.ts` imports
 * SalesOrdersService, CustomersService, DepositsService, InventoryService,
 * FulfillmentService, ShipmentService, DeliveryService, ReturnsService,
 * CustomerLedgerService. Reporting is NEVER itself a dependency (O-MOD-1) —
 * it is a pure downstream consumer. In P4 these become read-only
 * public_contract queries; reporting stays a leaf of the dependency graph.
 */
export const reportingManifest: ModuleManifest = {
  module_code: 'reporting',
  manifest_version: '1.0.0',
  title_code: 'module.reporting',
  business_domains: ['reports'],
  depends_on: ['sales', 'inventory', 'logistics', 'finance'],

  permission_nodes: [
    { node: 'reporting', title_code: 'perm.reporting' },

    { node: 'reporting.sales', title_code: 'perm.reporting.sales', parent: 'reporting' },
    { node: 'reporting.sales.view', title_code: 'perm.reporting.sales.view', parent: 'reporting.sales' },
    { node: 'reporting.sales.export', title_code: 'perm.reporting.sales.export', parent: 'reporting.sales' },

    { node: 'reporting.inventory', title_code: 'perm.reporting.inventory', parent: 'reporting' },
    { node: 'reporting.inventory.view', title_code: 'perm.reporting.inventory.view', parent: 'reporting.inventory' },
    { node: 'reporting.inventory.export', title_code: 'perm.reporting.inventory.export', parent: 'reporting.inventory' },

    { node: 'reporting.logistics', title_code: 'perm.reporting.logistics', parent: 'reporting' },
    { node: 'reporting.logistics.view', title_code: 'perm.reporting.logistics.view', parent: 'reporting.logistics' },
    { node: 'reporting.logistics.export', title_code: 'perm.reporting.logistics.export', parent: 'reporting.logistics' },

    { node: 'reporting.finance', title_code: 'perm.reporting.finance', parent: 'reporting' },
    { node: 'reporting.finance.view', title_code: 'perm.reporting.finance.view', parent: 'reporting.finance' },
    { node: 'reporting.finance.export', title_code: 'perm.reporting.finance.export', parent: 'reporting.finance' },

    { node: 'reporting.customer_account', title_code: 'perm.reporting.customer_account', parent: 'reporting' },
    { node: 'reporting.customer_account.view', title_code: 'perm.reporting.customer_account.view', parent: 'reporting.customer_account' },
  ],

  feature_codes: [
    { code: 'reporting.sales_reports', title_code: 'feat.reporting.sales_reports', default: true, toggleable: true },
    { code: 'reporting.inventory_reports', title_code: 'feat.reporting.inventory_reports', default: true, toggleable: true },
    { code: 'reporting.logistics_reports', title_code: 'feat.reporting.logistics_reports', default: true, toggleable: true },
    { code: 'reporting.finance_reports', title_code: 'feat.reporting.finance_reports', default: true, toggleable: true },
    { code: 'reporting.excel_export', title_code: 'feat.reporting.excel_export', default: true, toggleable: true },
  ],

  limit_keys: [
    { key: 'reporting.exports_per_day', title_code: 'limit.reporting.exports_per_day', unit: 'per_day', default: null },
  ],

  config_keys: [
    {
      key: 'reporting.default_period_grouping',
      type: 'enum',
      allowed: ['day', 'month'],
      default: 'month',
      scope_levels: ['platform', 'edition', 'installation', 'user'],
    },
  ],

  migration_tag: 'reporting',

  public_contract: {
    commands: [],
    queries: ['GetCustomerAccountReport', 'GetSalesOrdersReport', 'GetSalesByPeriod', 'GetSalesByCustomer', 'GetSalesByRep', 'GetCustodyCodReport'],
    events: [],
  },
};
