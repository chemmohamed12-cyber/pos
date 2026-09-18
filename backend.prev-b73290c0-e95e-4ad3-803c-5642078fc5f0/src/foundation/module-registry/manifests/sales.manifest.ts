import { ModuleManifest } from '../module-manifest.type';

/**
 * ERP Foundation — P1. `sales` module manifest.
 * Inert data (ADR-024 §4). Groups the commercial-transaction domains.
 *
 * `depends_on: ['inventory', 'finance']` — the ACTUAL non-spec code graph
 * (P1_BLUEPRINT.md §4.3), verified by CI check C-8:
 *   - sales-orders/application/sales-orders.service.ts imports InventoryService
 *   - sales-orders/application/preliminary-hold-expiry.scheduler.ts imports InventoryService
 *   - deposit-control/application/deposits.service.ts imports TreasuryService,
 *     CustomerLedgerService, InvoiceService
 * This module is part of the cyclic pair `sales ↔ inventory` and
 * `sales ↔ finance` (F-MOD-2). The raw imports are refactored to each
 * dependency's public_contract in P4 (decoupling order: inventory → sales /
 * sales-orders → logistics → finance → reporting; final order set by the P4
 * Blueprint). P1 declares only — it touches no import.
 */
export const salesManifest: ModuleManifest = {
  module_code: 'sales',
  manifest_version: '1.0.0',
  title_code: 'module.sales',
  business_domains: ['commerce', 'crm', 'sales', 'sales-orders', 'deposit-control'],
  depends_on: ['inventory', 'finance'],

  permission_nodes: [
    { node: 'sales', title_code: 'perm.sales' },

    { node: 'sales.catalog', title_code: 'perm.sales.catalog', parent: 'sales' },
    { node: 'sales.catalog.view', title_code: 'perm.sales.catalog.view', parent: 'sales.catalog' },
    { node: 'sales.catalog.create', title_code: 'perm.sales.catalog.create', parent: 'sales.catalog' },
    { node: 'sales.catalog.edit', title_code: 'perm.sales.catalog.edit', parent: 'sales.catalog' },
    { node: 'sales.catalog.export', title_code: 'perm.sales.catalog.export', parent: 'sales.catalog' },

    { node: 'sales.price_list', title_code: 'perm.sales.price_list', parent: 'sales' },
    { node: 'sales.price_list.view', title_code: 'perm.sales.price_list.view', parent: 'sales.price_list' },
    { node: 'sales.price_list.edit', title_code: 'perm.sales.price_list.edit', parent: 'sales.price_list' },

    { node: 'sales.customer', title_code: 'perm.sales.customer', parent: 'sales' },
    { node: 'sales.customer.view', title_code: 'perm.sales.customer.view', parent: 'sales.customer' },
    { node: 'sales.customer.create', title_code: 'perm.sales.customer.create', parent: 'sales.customer' },
    { node: 'sales.customer.edit', title_code: 'perm.sales.customer.edit', parent: 'sales.customer' },
    { node: 'sales.customer.assign', title_code: 'perm.sales.customer.assign', parent: 'sales.customer' },
    { node: 'sales.customer.export', title_code: 'perm.sales.customer.export', parent: 'sales.customer' },
    // P4 Tranche-2 (2026-09-06): 2 leaf nodes added — CRM's :id/status and
    // :id/financial-settings routes are admin-only (never granted to
    // sales_manager). Named as sibling mid-level nodes (not children of
    // sales.customer) so sales_manager's `sales.customer.edit` grant
    // cannot reach them via ancestor-walk — deliberate isolation, not an
    // oversight (grammar requires a closed-list verb as the last segment,
    // "status"/"financial_settings" aren't verbs, hence the reshape).
    { node: 'sales.customer_status.edit', title_code: 'perm.sales.customer_status.edit' },
    { node: 'sales.customer_financial.edit', title_code: 'perm.sales.customer_financial.edit' },

    { node: 'sales.rep', title_code: 'perm.sales.rep', parent: 'sales' },
    { node: 'sales.rep.view', title_code: 'perm.sales.rep.view', parent: 'sales.rep' },
    { node: 'sales.rep.assign', title_code: 'perm.sales.rep.assign', parent: 'sales.rep' },

    { node: 'sales.order', title_code: 'perm.sales.order', parent: 'sales' },
    { node: 'sales.order.view', title_code: 'perm.sales.order.view', parent: 'sales.order' },
    { node: 'sales.order.create', title_code: 'perm.sales.order.create', parent: 'sales.order' },
    { node: 'sales.order.edit', title_code: 'perm.sales.order.edit', parent: 'sales.order' },
    { node: 'sales.order.submit', title_code: 'perm.sales.order.submit', parent: 'sales.order' },
    { node: 'sales.order.approve', title_code: 'perm.sales.order.approve', parent: 'sales.order' },
    { node: 'sales.order.reject', title_code: 'perm.sales.order.reject', parent: 'sales.order' },
    { node: 'sales.order.release', title_code: 'perm.sales.order.release', parent: 'sales.order' },
    { node: 'sales.order.delete', title_code: 'perm.sales.order.delete', parent: 'sales.order' },

    { node: 'sales.deposit', title_code: 'perm.sales.deposit', parent: 'sales' },
    { node: 'sales.deposit.view', title_code: 'perm.sales.deposit.view', parent: 'sales.deposit' },
    { node: 'sales.deposit.submit', title_code: 'perm.sales.deposit.submit', parent: 'sales.deposit' },
    { node: 'sales.deposit.approve', title_code: 'perm.sales.deposit.approve', parent: 'sales.deposit' },
    { node: 'sales.deposit.reject', title_code: 'perm.sales.deposit.reject', parent: 'sales.deposit' },
  ],

  feature_codes: [
    { code: 'sales.catalog', title_code: 'feat.sales.catalog', default: true, toggleable: false },
    { code: 'sales.order', title_code: 'feat.sales.order', default: true, toggleable: false },
    { code: 'sales.customer', title_code: 'feat.sales.customer', default: true, toggleable: false },
    { code: 'sales.price_lists', title_code: 'feat.sales.price_lists', default: true, toggleable: true },
    { code: 'sales.deposit_control', title_code: 'feat.sales.deposit_control', default: true, toggleable: true },
    { code: 'sales.multi_currency', title_code: 'feat.sales.multi_currency', default: false, toggleable: true },
    { code: 'sales.excel_import', title_code: 'feat.sales.excel_import', default: true, toggleable: true },
  ],

  limit_keys: [
    { key: 'sales.max_reps', title_code: 'limit.sales.max_reps', unit: 'count', default: null },
    { key: 'sales.max_price_lists', title_code: 'limit.sales.max_price_lists', unit: 'count', default: null },
    { key: 'sales.max_products', title_code: 'limit.sales.max_products', unit: 'count', default: null },
    { key: 'sales.max_customers', title_code: 'limit.sales.max_customers', unit: 'count', default: null },
    { key: 'sales.orders_per_month', title_code: 'limit.sales.orders_per_month', unit: 'per_month', default: null },
  ],

  config_keys: [
    {
      key: 'sales.approval_chain_steps',
      type: 'enum',
      allowed: [1, 2],
      default: 1,
      scope_levels: ['platform', 'edition', 'installation'],
    },
    {
      key: 'sales.deposit_required',
      type: 'bool',
      default: true,
      scope_levels: ['platform', 'edition', 'installation'],
    },
    {
      key: 'sales.default_currency',
      type: 'string',
      default: 'EGP',
      scope_levels: ['platform', 'edition', 'installation'],
    },
  ],

  migration_tag: 'sales',

  public_contract: {
    commands: ['CreateProduct', 'SetPrice', 'CreateCustomer', 'AssignSalesRep', 'CreateOrder', 'ApproveOrder', 'ReleaseForFulfillment', 'SubmitDeposit', 'ApproveDeposit'],
    queries: ['GetProduct', 'ListCatalog', 'ResolvePrice', 'GetCustomer', 'ListCustomersByScope', 'GetSalesHierarchy', 'GetOrder', 'ListOrdersByScope', 'GetDepositStatus'],
    events: ['commerce.product.created', 'commerce.price.changed', 'crm.customer.created', 'crm.customer.assigned', 'sales.order.created', 'sales.order.approved', 'sales.order.released', 'deposit.submitted', 'deposit.verified'],
  },
};
