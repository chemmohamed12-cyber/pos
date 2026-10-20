import { ModuleManifest } from '../module-manifest.type';

/**
 * ERP Foundation — P1. `finance` module manifest.
 * OPERATIONAL finance only — treasury accounts/ledger + customer AR
 * (invoices, payments, ledger, aging). Full double-entry Accounting is the
 * future reserved `accounting` module, NOT this.
 *
 * `depends_on: ['sales', 'accounting']` — the ACTUAL non-spec code graph (C-8):
 *   - customer-finance/application/customer-ledger.service.ts imports CustomersService + Customer entity (crm)
 *   - customer-finance/application/invoices.service.ts imports SalesOrdersService, CustomersService
 *   - customer-finance/application/payments.service.ts imports CustomersService
 * `crm` and `sales-orders` live in `sales`, hence the edge. This is the
 * `sales ↔ finance` cycle (F-MOD-2). Decoupled in P4 (finance is step 4).
 *
 * `accounting` (F10, ADR-043 D1): `customer-finance.module.ts` imports
 * `domains/accounting/tax-engine.module.ts` for `TAX_ENGINE_CONTRACT` — a
 * deliberately small, separate module (not `AccountingModule` itself,
 * which already imports `CustomerFinanceModule` for
 * `FINANCE_CUSTOMER_LEDGER_CONTRACT`, ADR-036 — importing `AccountingModule`
 * back here would be a real NestJS cycle). This makes `accounting ↔
 * finance` a second, ENTITLEMENT-level two-node cycle alongside `sales ↔
 * finance` above — same class of transitional coupling F-MOD-2 already
 * tracks and tolerates (C-7b WARN, not an ERROR) until dependency
 * inversion resolves it for good.
 */
export const financeManifest: ModuleManifest = {
  module_code: 'finance',
  // 1.1.0 — F04 / handoff F04-H1: the AR events `customer-finance` publishes for
  // the `accounting` module's Financial Event Engine are now real (previously
  // declared-only); + the `GetCustomerLedgerBalances` read query (ADR-036 D11).
  // 1.2.0 — F06 / handoff F06-H1 (ADR-038): the `treasury.cash.recorded` /
  // `treasury.transfer.completed` events `treasury` publishes for the `accounting`
  // module's Financial Event Engine are now REALLY published (via the Transactional
  // Outbox, gated on a Treasury account's `glAccountCode`) — previously
  // declared-only; + the `GetTreasuryBalancesByGlAccount` read query.
  // 1.3.0 — F10 / handoff F10-H3 (ADR-043 D1): +`accounting` to `depends_on` —
  // `customer-finance` now calls `TAX_ENGINE_CONTRACT` (a real, new C-8 code edge,
  // not just declared) for invoice tax calculation; +1 additive `SalesInvoice.taxCodeId`
  // column (no manifest-tracked surface change otherwise — `accounting` manifest tracks
  // its own new permission nodes/feature/tables separately).
  manifest_version: '1.3.0',
  title_code: 'module.finance',
  business_domains: ['treasury', 'customer-finance'],
  depends_on: ['sales', 'accounting'],

  permission_nodes: [
    { node: 'finance', title_code: 'perm.finance' },

    { node: 'finance.treasury', title_code: 'perm.finance.treasury', parent: 'finance' },
    { node: 'finance.treasury.view', title_code: 'perm.finance.treasury.view', parent: 'finance.treasury' },
    { node: 'finance.treasury.create', title_code: 'perm.finance.treasury.create', parent: 'finance.treasury' },
    { node: 'finance.treasury.edit', title_code: 'perm.finance.treasury.edit', parent: 'finance.treasury' },

    { node: 'finance.cash', title_code: 'perm.finance.cash', parent: 'finance' },
    { node: 'finance.cash.view', title_code: 'perm.finance.cash.view', parent: 'finance.cash' },
    { node: 'finance.cash.post', title_code: 'perm.finance.cash.post', parent: 'finance.cash' },
    { node: 'finance.cash.transfer', title_code: 'perm.finance.cash.transfer', parent: 'finance.cash' },
    { node: 'finance.cash.reverse', title_code: 'perm.finance.cash.reverse', parent: 'finance.cash' },

    // T2 (2026-10-20) — treasury-account administration split from money movement (both still inherit from `finance`, so no existing role gains or loses access)
    { node: 'finance.cash_account', title_code: 'perm.finance.cash_account', parent: 'finance' },
    { node: 'finance.cash_account.manage', title_code: 'perm.finance.cash_account.manage', parent: 'finance.cash_account' },
    { node: 'finance.cash_account.mapping', title_code: 'perm.finance.cash_account.mapping', parent: 'finance.cash_account' },
    { node: 'finance.cash_account.mapping.manage', title_code: 'perm.finance.cash_account.mapping.manage', parent: 'finance.cash_account.mapping' },

    // T3 — Treasury Documents: each stage of the lifecycle has its own node (prepare / submit / approve / execute / cancel / reverse); all inherit from `finance`.
    { node: 'finance.cash_document', title_code: 'perm.finance.cash_document', parent: 'finance' },
    { node: 'finance.cash_document.view', title_code: 'perm.finance.cash_document.view', parent: 'finance.cash_document' },
    { node: 'finance.cash_document.create', title_code: 'perm.finance.cash_document.create', parent: 'finance.cash_document' },
    { node: 'finance.cash_document.submit', title_code: 'perm.finance.cash_document.submit', parent: 'finance.cash_document' },
    { node: 'finance.cash_document.approve', title_code: 'perm.finance.cash_document.approve', parent: 'finance.cash_document' },
    { node: 'finance.cash_document.execute', title_code: 'perm.finance.cash_document.execute', parent: 'finance.cash_document' },
    { node: 'finance.cash_document.cancel', title_code: 'perm.finance.cash_document.cancel', parent: 'finance.cash_document' },
    { node: 'finance.cash_document.reverse', title_code: 'perm.finance.cash_document.reverse', parent: 'finance.cash_document' },

    { node: 'finance.invoice', title_code: 'perm.finance.invoice', parent: 'finance' },
    { node: 'finance.invoice.view', title_code: 'perm.finance.invoice.view', parent: 'finance.invoice' },
    { node: 'finance.invoice.create', title_code: 'perm.finance.invoice.create', parent: 'finance.invoice' },
    { node: 'finance.invoice.post', title_code: 'perm.finance.invoice.post', parent: 'finance.invoice' },
    { node: 'finance.invoice.cancel', title_code: 'perm.finance.invoice.cancel', parent: 'finance.invoice' },

    { node: 'finance.payment', title_code: 'perm.finance.payment', parent: 'finance' },
    { node: 'finance.payment.view', title_code: 'perm.finance.payment.view', parent: 'finance.payment' },
    { node: 'finance.payment.create', title_code: 'perm.finance.payment.create', parent: 'finance.payment' },
    { node: 'finance.payment.reverse', title_code: 'perm.finance.payment.reverse', parent: 'finance.payment' },

    { node: 'finance.ledger', title_code: 'perm.finance.ledger', parent: 'finance' },
    { node: 'finance.ledger.view', title_code: 'perm.finance.ledger.view', parent: 'finance.ledger' },
    { node: 'finance.ledger.export', title_code: 'perm.finance.ledger.export', parent: 'finance.ledger' },
  ],

  feature_codes: [
    { code: 'finance.treasury', title_code: 'feat.finance.treasury', default: true, toggleable: false },
    { code: 'finance.customer_ar', title_code: 'feat.finance.customer_ar', default: true, toggleable: false },
    { code: 'finance.invoicing', title_code: 'feat.finance.invoicing', default: true, toggleable: true },
    { code: 'finance.ar_aging', title_code: 'feat.finance.ar_aging', default: true, toggleable: true },
    { code: 'finance.multi_account', title_code: 'feat.finance.multi_account', default: true, toggleable: true },
  ],

  limit_keys: [
    { key: 'finance.max_treasury_accounts', title_code: 'limit.finance.max_treasury_accounts', unit: 'count', default: null },
    { key: 'finance.invoices_per_month', title_code: 'limit.finance.invoices_per_month', unit: 'per_month', default: null },
  ],

  config_keys: [
    {
      key: 'finance.invoice_number_prefix',
      type: 'string',
      default: 'INV',
      scope_levels: ['platform', 'edition', 'installation'],
    },
    // T3 - amounts at or below this limit skip the approval request. EMPTY (the default) = every Treasury Document needs a separate approver. The owner sets the number; none is assumed.
    { key: 'finance.treasury_document_auto_approve_limit', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    {
      key: 'finance.allow_negative_treasury_balance',
      type: 'bool',
      default: false,
      scope_levels: ['platform', 'edition', 'installation'],
    },
    {
      key: 'finance.auto_invoice_on_delivery',
      type: 'bool',
      default: false,
      scope_levels: ['platform', 'edition', 'installation'],
    },
  ],

  migration_tag: 'finance',

  public_contract: {
    commands: ['CreateTreasuryAccount', 'CashIn', 'CashOut', 'TransferCash', 'ReverseTransaction', 'CreateInvoice', 'PostInvoice', 'VoidInvoice', 'RecordPayment'],
    queries: [
      'ListTreasuryAccounts',
      'GetTreasuryLedger',
      'GetInvoice',
      'ListInvoicesBySalesOrder',
      'GetCustomerLedger',
      'GetCreditSummary',
      'GetArAging',
      'GetCustomerLedgerBalances',
      'GetTreasuryBalancesByGlAccount',
    ],
    // F04-H1: `finance.invoice.posted`/`.voided`, `finance.payment.recorded` really
    // published by `customer-finance` (InvoicesService / PaymentsService).
    // F06-H1: `treasury.cash.recorded` / `treasury.transfer.completed` really published
    // by `treasury` (TreasuryService, via the Transactional Outbox) — previously declared-only.
    events: ['treasury.cash.recorded', 'treasury.transfer.completed', 'finance.invoice.posted', 'finance.invoice.voided', 'finance.payment.recorded', 'finance.payment.reversed'],
  },
};
