import { ModuleManifest } from '../module-manifest.type';

/**
 * ERP Foundation — F01 (Financial Core, ADR-032). `accounting` module
 * manifest — full double-entry Accounting (Chart of Accounts, General
 * Ledger, AR/AP), explicitly distinct from `finance`'s OPERATIONAL
 * treasury/AR (see `finance.manifest.ts`'s own doc-comment, which already
 * names this module by name as its intended future counterpart).
 *
 * `depends_on: ['finance']` is an ENTITLEMENT dependency (an Edition
 * cannot entitle `accounting` without also entitling `finance`), NOT a
 * code-import dependency — CTO decision, 2026-09-09
 * (`planning/financial-core/FINANCIAL_CORE_MASTER_PLAN.md` §7.2):
 * `inventory`/`logistics` are explicitly excluded from `depends_on` even
 * though `accounting` will eventually consume events originating from
 * them, because that reach is entirely through the existing domain-event/
 * integration-contract mechanism (`DAII_FINANCE_INTEGRATION_BOUNDARY.md`),
 * never a direct cross-domain import. As of F01, `accounting.module.ts`
 * imports NOTHING from `src/domains/finance`/`treasury`/`customer-finance`
 * — `validate:manifests`' C-8 check may WARN "declares depends_on
 * 'finance' but no concrete cross-module import was found" for exactly
 * this reason; that WARN is expected and accepted, not a defect (the
 * dependency is real at the entitlement level, verified once F03 actually
 * subscribes to `finance`'s published events).
 */
export const accountingManifest: ModuleManifest = {
  module_code: 'accounting',
  // 1.1.0 — F02 (Chart of Accounts, ADR-034): +6 permission nodes, +1 feature,
  //         +1 limit key, +1 config key, +3 events, +CoA commands/queries.
  // 1.2.0 — F03 (General Ledger + Financial Event Engine, ADR-035):
  //         +11 permission nodes (journal/ledger/financial_event), +1 feature,
  //         +2 config keys, +3 events, +GL commands/queries.
  // 1.3.0 — F04 (Accounts Receivable, ADR-036): +4 permission nodes (`accounting.ar.*`),
  //         +1 feature (`accounting.accounts_receivable`), +4 config keys, +2 events,
  //         +AR commands/queries. AR subledger stays in `customer-finance` (ADR-036 D1);
  //         F04 = AR→GL integration + reconciliation + FA-01 approval wiring + E-02.
  // 1.4.0 — F05 (Accounts Payable, ADR-037): +4 permission nodes (`accounting.ap.*`),
  //         +1 feature (`accounting.accounts_payable`), +5 config keys, +2 events,
  //         +4 commands / +3 queries. Mirrors F04 on the `ap` control function.
  // 1.5.0 — F06 (Cash & Bank, ADR-038): +4 permission nodes (`accounting.cash.*`),
  //         +1 feature (`accounting.cash_bank`), +3 config keys, +2 events,
  //         +4 commands / +3 queries. Activates F03's dormant `treasury.*` handlers
  //         (publishers wired in F06-H1 on the `finance` side) + a per-account
  //         Cash/Bank↔GL reconciliation + FA-01 for cash/bank adjustments.
  // 1.6.0 — F07 (Inventory Accounting, ADR-040): +4 permission nodes
  //         (`accounting.inventory.*`), +1 feature (`accounting.inventory_accounting`),
  //         +1 config key, +2 events, +4 commands / +2 queries. Registers F03's first
  //         real handler for the already-reserved `inventory.movement.recorded` topic
  //         (F07-H1 publisher in `InventoryService.recordMovement`, gated to
  //         `movementType === 'dispatch'` only) + FA-01 for inventory financial
  //         adjustments + a dormant (`no_valuation_source`) Inventory↔GL
  //         reconciliation — activates once F08 (Inventory Valuation) binds a real
  //         `InventoryValuationContract`. NO valuation method ships in F07.
  // 1.7.0 — F10 (Tax & Localization, ADR-043): +2 permission nodes
  //         (`accounting.tax_period.{view,create}`), +1 feature (`accounting.tax_engine`,
  //         default:true/toggleable:false — mirrors F04-F07's own precedent; output tax is
  //         not an optional add-on to invoicing once `accounting` is entitled). Extends
  //         the existing `accounting_tax_codes` table (type/jurisdictionCode/
  //         effectiveFrom/effectiveTo, all additive) and adds one new reporting-only
  //         table (`accounting_tax_periods`, D8 — no FK to/from JournalEntry/JournalLine).
  //         `accounting.default_tax_code` (declared since F01) is CONSUMED for the first
  //         time by `TaxEngineService`. V1 = invoice-level output tax only (Blueprint §0);
  //         input tax / AP remains blocked on a domain that does not exist (disclosed).
  //         The ONE cross-module (non-`accounting`) schema touch this phase makes is a
  //         single additive `SalesInvoice.taxCodeId` column in `customer-finance`
  //         (F10-H3, CTO-authorized scope) — not reflected in this manifest, which only
  //         tracks `accounting`'s own surface.
  // 1.8.0 — F11 (Cost Centers & Dimensions, ADR-044): +1 permission node
  //         (`accounting.dimension.edit`), +1 config key
  //         (`accounting.default_pl_dimension_type_code`), +4 commands
  //         (Update/DeactivateDimensionType, Update/DeactivateDimensionValue).
  //         `accounting.financial_dimensions` (declared since F01, `toggleable: true`)
  //         becomes a REAL feature gate for the first time — CRUD routes 404 and
  //         posting-time dimension-rule enforcement (`GLAccountService.assertPostable`)
  //         is skipped entirely when not entitled; NEVER gates reading historical
  //         `JournalLineDimension` data via any existing GL/ledger read path (ADR-044 D9).
  //         `accounting.require_dimension_on_pl_accounts` (declared since F02) is CONSUMED
  //         for the first time by `JournalEntryService.enforcePlAccountDimensionPolicy`,
  //         paired with the new type-code config key (ADR-044 D10) — posting-time policy
  //         only, never a `GLAccountDimensionRule` row auto-insert, never an invented
  //         dimension value. `GLAccountDimensionRule.defaultValueId` (declared since F02)
  //         is resolved AND persisted into `JournalLineDimension` at posting time for the
  //         first time (ADR-044 Mandatory Correction 1) — previously validated but never
  //         applied. No new table, no new column, NO NEW MIGRATION (D14, resolved by
  //         targeted verification: a new leaf permission node under an already-granted
  //         parent needs no new grant row; a new config key is picked up automatically by
  //         the existing config-registry boot/resync seeder). No Cost Center (or any)
  //         dimension type/value is seeded — the vocabulary stays 100% user-created.
  // 1.9.0 — F12 (Fixed Assets, ADR-045): +6 permission nodes (`accounting.fixed_asset.*`),
  //         +1 feature (`accounting.fixed_assets`, toggleable:true — a real gate, scoped to
  //         create/edit/depreciation-run/disposal-submit/disposal-decide only; register
  //         reads, depreciation-run listing, and reconciliation are NEVER gated — D4),
  //         +2 config keys (gain/loss-on-disposal account codes, resolved via the existing
  //         `resolveConfiguredPostableAccount` mechanism, no hard-coded fallback), +1 new
  //         `ControlFunction` value (`fixed_asset`, code-only, no manifest field — see
  //         `domain/control-function.ts`), +5 new tables (the first new accounting tables
  //         since F08 — `accounting_fixed_assets`/`_fixed_asset_category_account_mappings`/
  //         `_depreciation_runs`/`_depreciation_run_lines`/`_fixed_asset_disposals`), +1
  //         commands/queries. Depreciation posts directly (`systemPosting`, no approval,
  //         non-discretionary); Disposal is FA-01-gated (`alwaysGated:true,
  //         minApprovers:1`, independently set, not copied from AR/AP's `2`). Reversal of
  //         a disposal's journal entry is picked up via F12's OWN subscription to the
  //         already-existing `accounting.journal.reversed` event (F03/JournalEntryService
  //         itself is unmodified — zero new parameter, zero new call site). Category rides
  //         F11's `FinancialDimensionType`/`Value` mechanism (`asset_category`), not a new
  //         bespoke table. No Cost Center precedent broken: no seed data of any kind.
  // 1.10.0 — F13 (Financial Closing, ADR-046): +2 permission nodes (`accounting.fiscal_period.approve`,
  //          `accounting.fiscal_year.approve` — both FA-01 checker nodes; `close` is deliberately NOT
  //          a permission verb, per ADR-024, so no `.close` node exists anywhere), +1 event
  //          (`accounting.fiscal_year.status_changed` — symmetric with the period-level one F01
  //          declared but never published; both are now genuinely published, in the same transaction
  //          as their transition, D6), +1 command (`CloseFiscalPeriod`, split out of the generic
  //          `TransitionFiscalPeriod` action since `close` is now its own FA-01-gated submit route).
  //          `close`/`reopen` (period) and `close` (fiscal year) are now FA-01-gated (D4) — 3 new
  //          request-type codes (`accounting.fiscal_period.close`/`.reopen`,
  //          `accounting.fiscal_year.close`, all free-text `ApprovalRequestType.code` strings, a
  //          namespace separate from `permission_nodes`, `alwaysGated:true, minApprovers:1`).
  //          `assertOpenForPosting` (F01) now also accepts `'reopened'` periods (D2) and requires the
  //          covering `FiscalYear` be `'active'` (D3, a genuine, previously-unchecked gap fix) — F03
  //          and every one of F04-F12's posting call sites are unaffected (single call site,
  //          confirmed). Fiscal Year close requires every child period already `closed`, checked at
  //          submission AND revalidated under the Process Engine's own row-lock at decision time
  //          (D10). Year-end closing entries (net income → Retained Earnings) are explicitly OUT OF
  //          SCOPE for V1 (D1) — the `retained_earnings` `ControlFunction` slot stays reserved,
  //          unclaimed. No new feature gate, no new config key, no new table/migration. No frontend.
  // 1.11.0 — F14 (Financial Reporting, ADR-047): +2 permission nodes (`accounting.report.{view,export}`,
  //          mirrors `accounting.ledger`'s own shape), +4 queries (GetBalanceSheet/GetProfitAndLoss/
  //          GetCashFlowStatement/GetTaxPeriodSummary). A pure read model — `FinancialReportingService`
  //          adds new SQL aggregations over the SAME `accounting_journal_lines`/`accounting_gl_accounts`
  //          tables `LedgerService` already reads (D2's Architecture Rule: no new Reporting Ledger).
  //          Balance Sheet/P&L grouped by the 5 existing `GLAccountType` values into fixed sections
  //          (D1); Balance Sheet Equity = stored equity + an unbounded-since-inception computed net-
  //          income line, proven non-double-counting by construction even through a real closing entry
  //          (D3); Cash Flow via the indirect method, with Operating/Investing individually proven
  //          derivable from existing F12 entities and Financing honestly disclosed as unmodeled rather
  //          than invented (D5); a small, separately-scoped tax-period summary finally consumes F10's
  //          previously-dormant `accounting_tax_periods` table (D4). No new feature gate, no new config
  //          key, no new table/migration, no F01-F13 file touched.
  manifest_version: '1.11.0',
  title_code: 'module.accounting',
  business_domains: ['accounting'],
  depends_on: ['finance'],

  permission_nodes: [
    { node: 'accounting', title_code: 'perm.accounting' },

    { node: 'accounting.currency', title_code: 'perm.accounting.currency', parent: 'accounting' },
    { node: 'accounting.currency.view', title_code: 'perm.accounting.currency.view', parent: 'accounting.currency' },
    { node: 'accounting.currency.create', title_code: 'perm.accounting.currency.create', parent: 'accounting.currency' },
    { node: 'accounting.currency.edit', title_code: 'perm.accounting.currency.edit', parent: 'accounting.currency' },

    { node: 'accounting.exchange_rate', title_code: 'perm.accounting.exchange_rate', parent: 'accounting' },
    { node: 'accounting.exchange_rate.view', title_code: 'perm.accounting.exchange_rate.view', parent: 'accounting.exchange_rate' },
    { node: 'accounting.exchange_rate.create', title_code: 'perm.accounting.exchange_rate.create', parent: 'accounting.exchange_rate' },

    { node: 'accounting.fiscal_year', title_code: 'perm.accounting.fiscal_year', parent: 'accounting' },
    { node: 'accounting.fiscal_year.view', title_code: 'perm.accounting.fiscal_year.view', parent: 'accounting.fiscal_year' },
    { node: 'accounting.fiscal_year.create', title_code: 'perm.accounting.fiscal_year.create', parent: 'accounting.fiscal_year' },
    // F13 (ADR-046 D5) — the FA-01 checker node for the `accounting.fiscal_year.close` request type.
    { node: 'accounting.fiscal_year.approve', title_code: 'perm.accounting.fiscal_year.approve', parent: 'accounting.fiscal_year' },

    { node: 'accounting.fiscal_period', title_code: 'perm.accounting.fiscal_period', parent: 'accounting' },
    { node: 'accounting.fiscal_period.view', title_code: 'perm.accounting.fiscal_period.view', parent: 'accounting.fiscal_period' },
    { node: 'accounting.fiscal_period.edit', title_code: 'perm.accounting.fiscal_period.edit', parent: 'accounting.fiscal_period' },
    {
      node: 'accounting.fiscal_period.reopen',
      title_code: 'perm.accounting.fiscal_period.reopen',
      parent: 'accounting.fiscal_period',
    },
    // F13 (ADR-046 D5) — the FA-01 checker node, shared by both the `close` and `reopen` request types.
    {
      node: 'accounting.fiscal_period.approve',
      title_code: 'perm.accounting.fiscal_period.approve',
      parent: 'accounting.fiscal_period',
    },

    { node: 'accounting.tax_code', title_code: 'perm.accounting.tax_code', parent: 'accounting' },
    { node: 'accounting.tax_code.view', title_code: 'perm.accounting.tax_code.view', parent: 'accounting.tax_code' },
    { node: 'accounting.tax_code.create', title_code: 'perm.accounting.tax_code.create', parent: 'accounting.tax_code' },
    { node: 'accounting.tax_code.edit', title_code: 'perm.accounting.tax_code.edit', parent: 'accounting.tax_code' },

    // F10 (ADR-043 D8) — reporting-only, no `.edit`/`.approve` (a tax period is created once, never mutated).
    { node: 'accounting.tax_period', title_code: 'perm.accounting.tax_period', parent: 'accounting' },
    { node: 'accounting.tax_period.view', title_code: 'perm.accounting.tax_period.view', parent: 'accounting.tax_period' },
    { node: 'accounting.tax_period.create', title_code: 'perm.accounting.tax_period.create', parent: 'accounting.tax_period' },

    { node: 'accounting.dimension', title_code: 'perm.accounting.dimension', parent: 'accounting' },
    { node: 'accounting.dimension.view', title_code: 'perm.accounting.dimension.view', parent: 'accounting.dimension' },
    { node: 'accounting.dimension.create', title_code: 'perm.accounting.dimension.create', parent: 'accounting.dimension' },
    // F11 (ADR-044 D8) — update/deactivate; no `.delete` node (correction, not deletion).
    { node: 'accounting.dimension.edit', title_code: 'perm.accounting.dimension.edit', parent: 'accounting.dimension' },

    // F02 — Chart of Accounts (ADR-034). No `delete` node — an account is
    // deactivated, never removed (Blueprint §9). `assign` (control-function
    // assignment) is deliberately its own node so it can be gated harder
    // later without touching `edit`.
    { node: 'accounting.account', title_code: 'perm.accounting.account', parent: 'accounting' },
    { node: 'accounting.account.view', title_code: 'perm.accounting.account.view', parent: 'accounting.account' },
    { node: 'accounting.account.create', title_code: 'perm.accounting.account.create', parent: 'accounting.account' },
    { node: 'accounting.account.edit', title_code: 'perm.accounting.account.edit', parent: 'accounting.account' },
    { node: 'accounting.account.assign', title_code: 'perm.accounting.account.assign', parent: 'accounting.account' },
    // NB: the Blueprint §9 proposed a distinct `accounting.account.import`
    // node for the template import; `import` is NOT in ADR-024's closed
    // permission-verb list (`validate:manifests` C-5), so the template
    // import rides on `accounting.account.create` instead — it is, after
    // all, a bulk create. Disclosed deviation (Governance Rule 5).

    // F03 — General Ledger + Financial Event Engine (ADR-035). NB: `validate`
    // is not in ADR-024's closed verb list, so DRAFT->VALIDATED is `submit`.
    { node: 'accounting.journal', title_code: 'perm.accounting.journal', parent: 'accounting' },
    { node: 'accounting.journal.view', title_code: 'perm.accounting.journal.view', parent: 'accounting.journal' },
    { node: 'accounting.journal.create', title_code: 'perm.accounting.journal.create', parent: 'accounting.journal' },
    { node: 'accounting.journal.edit', title_code: 'perm.accounting.journal.edit', parent: 'accounting.journal' },
    { node: 'accounting.journal.submit', title_code: 'perm.accounting.journal.submit', parent: 'accounting.journal' },
    { node: 'accounting.journal.post', title_code: 'perm.accounting.journal.post', parent: 'accounting.journal' },
    { node: 'accounting.journal.reverse', title_code: 'perm.accounting.journal.reverse', parent: 'accounting.journal' },

    { node: 'accounting.ledger', title_code: 'perm.accounting.ledger', parent: 'accounting' },
    { node: 'accounting.ledger.view', title_code: 'perm.accounting.ledger.view', parent: 'accounting.ledger' },
    { node: 'accounting.ledger.export', title_code: 'perm.accounting.ledger.export', parent: 'accounting.ledger' },

    { node: 'accounting.financial_event', title_code: 'perm.accounting.financial_event', parent: 'accounting' },
    { node: 'accounting.financial_event.view', title_code: 'perm.accounting.financial_event.view', parent: 'accounting.financial_event' },

    // F04 — Accounts Receivable (ADR-036). NB: `reconcile` is not an ADR-024 verb —
    // a reconciliation run is a `create` (disclosed deviation, like F02's `.import`).
    // `write_off` is a `.adjust` + FA-01 approval. `approve` gates the FA-01 checker.
    { node: 'accounting.ar', title_code: 'perm.accounting.ar', parent: 'accounting' },
    { node: 'accounting.ar.view', title_code: 'perm.accounting.ar.view', parent: 'accounting.ar' },
    { node: 'accounting.ar.create', title_code: 'perm.accounting.ar.create', parent: 'accounting.ar' },
    { node: 'accounting.ar.adjust', title_code: 'perm.accounting.ar.adjust', parent: 'accounting.ar' },
    { node: 'accounting.ar.approve', title_code: 'perm.accounting.ar.approve', parent: 'accounting.ar' },

    // F05 — Accounts Payable (ADR-037). Mirror of `accounting.ar.*`. `reconcile`/`close`
    // ride `.create` (not ADR-024 verbs — a run is a create, disclosed like F02's `.import`).
    { node: 'accounting.ap', title_code: 'perm.accounting.ap', parent: 'accounting' },
    { node: 'accounting.ap.view', title_code: 'perm.accounting.ap.view', parent: 'accounting.ap' },
    { node: 'accounting.ap.create', title_code: 'perm.accounting.ap.create', parent: 'accounting.ap' },
    { node: 'accounting.ap.adjust', title_code: 'perm.accounting.ap.adjust', parent: 'accounting.ap' },
    { node: 'accounting.ap.approve', title_code: 'perm.accounting.ap.approve', parent: 'accounting.ap' },

    // F06 — Cash & Bank (ADR-038). Mirror of `accounting.ar.*`/`accounting.ap.*`.
    // `reconcile`/`close` ride `.create` (disclosed like F04/F05).
    { node: 'accounting.cash', title_code: 'perm.accounting.cash', parent: 'accounting' },
    { node: 'accounting.cash.view', title_code: 'perm.accounting.cash.view', parent: 'accounting.cash' },
    { node: 'accounting.cash.create', title_code: 'perm.accounting.cash.create', parent: 'accounting.cash' },
    { node: 'accounting.cash.adjust', title_code: 'perm.accounting.cash.adjust', parent: 'accounting.cash' },
    { node: 'accounting.cash.approve', title_code: 'perm.accounting.cash.approve', parent: 'accounting.cash' },

    // F07 — Inventory Accounting (ADR-040). Mirror of `accounting.ar.*`/`accounting.ap.*`/
    // `accounting.cash.*`. `reconcile`/`close` ride `.create` (disclosed like F04/F05/F06).
    { node: 'accounting.inventory', title_code: 'perm.accounting.inventory', parent: 'accounting' },
    { node: 'accounting.inventory.view', title_code: 'perm.accounting.inventory.view', parent: 'accounting.inventory' },
    { node: 'accounting.inventory.create', title_code: 'perm.accounting.inventory.create', parent: 'accounting.inventory' },
    { node: 'accounting.inventory.adjust', title_code: 'perm.accounting.inventory.adjust', parent: 'accounting.inventory' },
    { node: 'accounting.inventory.approve', title_code: 'perm.accounting.inventory.approve', parent: 'accounting.inventory' },

    // F12 — Fixed Assets (ADR-045). `dispose`/`depreciate` are not ADR-024 verbs —
    // disposal/write-off rides `.adjust` (the exact precedent AR/AP/Cash-bank write-offs
    // already established), triggering a Depreciation Run rides `.post` (already used by
    // `accounting.journal.post`).
    { node: 'accounting.fixed_asset', title_code: 'perm.accounting.fixed_asset', parent: 'accounting' },
    { node: 'accounting.fixed_asset.view', title_code: 'perm.accounting.fixed_asset.view', parent: 'accounting.fixed_asset' },
    { node: 'accounting.fixed_asset.create', title_code: 'perm.accounting.fixed_asset.create', parent: 'accounting.fixed_asset' },
    { node: 'accounting.fixed_asset.edit', title_code: 'perm.accounting.fixed_asset.edit', parent: 'accounting.fixed_asset' },
    { node: 'accounting.fixed_asset.adjust', title_code: 'perm.accounting.fixed_asset.adjust', parent: 'accounting.fixed_asset' },
    { node: 'accounting.fixed_asset.post', title_code: 'perm.accounting.fixed_asset.post', parent: 'accounting.fixed_asset' },
    { node: 'accounting.fixed_asset.approve', title_code: 'perm.accounting.fixed_asset.approve', parent: 'accounting.fixed_asset' },

    // F14 — Financial Reporting (ADR-047 D7). Mirrors `accounting.ledger`'s own `.view`/`.export`
    // shape exactly. Server-side enforced via the same `PermissionGuard` every other route uses.
    { node: 'accounting.report', title_code: 'perm.accounting.report', parent: 'accounting' },
    { node: 'accounting.report.view', title_code: 'perm.accounting.report.view', parent: 'accounting.report' },
    { node: 'accounting.report.export', title_code: 'perm.accounting.report.export', parent: 'accounting.report' },
  ],

  feature_codes: [
    { code: 'accounting.foundation', title_code: 'feat.accounting.foundation', default: true, toggleable: false },
    { code: 'accounting.multi_currency', title_code: 'feat.accounting.multi_currency', default: true, toggleable: true },
    { code: 'accounting.financial_dimensions', title_code: 'feat.accounting.financial_dimensions', default: true, toggleable: true },
    // F02 — present whenever `accounting` is entitled; F03+ hard-depend on it, so not a real toggle.
    { code: 'accounting.chart_of_accounts', title_code: 'feat.accounting.chart_of_accounts', default: true, toggleable: false },
    // F03 — present whenever `accounting` is entitled; F04+ hard-depend on it.
    { code: 'accounting.general_ledger', title_code: 'feat.accounting.general_ledger', default: true, toggleable: false },
    // F04 — AR→GL integration + reconciliation; F05+ mirror it.
    { code: 'accounting.accounts_receivable', title_code: 'feat.accounting.accounts_receivable', default: true, toggleable: false },
    // F05 — AP→GL integration + reconciliation. Part of the module, not a separate SKU.
    { code: 'accounting.accounts_payable', title_code: 'feat.accounting.accounts_payable', default: true, toggleable: false },
    // F06 — Treasury→GL integration + Cash/Bank reconciliation. Part of the module, not a separate SKU.
    { code: 'accounting.cash_bank', title_code: 'feat.accounting.cash_bank', default: true, toggleable: false },
    // F07 — Inventory→GL mapping mechanism + FA-01 inventory adjustments + dormant
    // reconciliation. Part of the module, not a separate SKU. NO valuation method (F08).
    { code: 'accounting.inventory_accounting', title_code: 'feat.accounting.inventory_accounting', default: true, toggleable: false },
    // F10 — Tax Engine (calculation + output-tax GL posting extension). Part of the
    // module, not a separate SKU (Blueprint §8) — output tax is not an optional
    // add-on to invoicing once `accounting` is entitled, same precedent as F04-F07.
    { code: 'accounting.tax_engine', title_code: 'feat.accounting.tax_engine', default: true, toggleable: false },
    // F12 (ADR-045 D4) — a REAL feature gate: governs create/edit/depreciation-run-trigger/
    // disposal-submit/disposal-decide ONLY. Register reads, depreciation-run listing, and
    // reconciliation are NEVER gated by this (master-data/read-only), and it never touches
    // an already-POSTED depreciation/disposal journal entry regardless of toggle state.
    { code: 'accounting.fixed_assets', title_code: 'feat.accounting.fixed_assets', default: true, toggleable: true },
  ],

  limit_keys: [
    { key: 'accounting.max_currencies', title_code: 'limit.accounting.max_currencies', unit: 'count', default: null },
    { key: 'accounting.max_active_fiscal_years', title_code: 'limit.accounting.max_active_fiscal_years', unit: 'count', default: 1 },
    { key: 'accounting.max_dimension_types', title_code: 'limit.accounting.max_dimension_types', unit: 'count', default: null },
    // F02 — an Edition/installation may cap chart size; null = uncapped (fail-open, LIMIT_INTEGRATION_CONTRACT.md).
    { key: 'accounting.max_gl_accounts', title_code: 'limit.accounting.max_gl_accounts', unit: 'count', default: null },
  ],

  config_keys: [
    {
      key: 'accounting.default_fiscal_year_period_length',
      type: 'enum',
      allowed: ['monthly', 'quarterly'],
      default: 'monthly',
      scope_levels: ['platform', 'edition', 'installation'],
    },
    // '' (empty string) = "no default tax code set" — the Configuration
    // Engine's `string` type has no distinct null representation
    // (`serialize(null, {type:'string'})` would coerce to the literal
    // text "null", not an absence), confirmed before choosing this
    // sentinel rather than the Blueprint's originally-stated `null`.
    {
      key: 'accounting.default_tax_code',
      type: 'string',
      default: '',
      scope_levels: ['platform', 'edition', 'installation'],
    },
    {
      key: 'accounting.base_currency_locked_after_first_year',
      type: 'bool',
      default: true,
      scope_levels: ['platform', 'edition', 'installation'],
    },
    // F02 — declared here; CONSUMED BY F11 (ADR-044 D10, `JournalEntryService.
    // enforcePlAccountDimensionPolicy`): when true, a revenue/expense account
    // with no explicit `GLAccountDimensionRule` for the type named by
    // `accounting.default_pl_dimension_type_code` (below) is treated as
    // `required` for that type, posting-time only — never a database rule-row
    // insert, never an invented dimension value, and an account's own explicit
    // rule for that type always takes precedence.
    {
      key: 'accounting.require_dimension_on_pl_accounts',
      type: 'bool',
      default: false,
      scope_levels: ['platform', 'edition', 'installation'],
    },
    // F11 (ADR-044 D10) — names WHICH dimension type the policy above means;
    // '' = unset = the policy has nothing to enforce even if the boolean above
    // is true (disclosed no-op, not a crash) — same empty-string-sentinel
    // pattern `accounting.default_tax_code` (F10) already established.
    {
      key: 'accounting.default_pl_dimension_type_code',
      type: 'string',
      default: '',
      scope_levels: ['platform', 'edition', 'installation'],
    },
    // F03 — the NumberingService prefix for journal entry numbers (document type 'accounting_journal_entry').
    {
      key: 'accounting.journal_number_prefix',
      type: 'string',
      default: 'JV',
      scope_levels: ['platform', 'edition', 'installation'],
    },
    // F03 — how many days a MANUAL/OPENING journal's businessDate may be backdated (0 = today or forward
    // only; the fiscal-period gate still applies regardless). Consumed by the posting gate.
    {
      key: 'accounting.allow_backdated_manual_journal_days',
      type: 'int',
      allowed: { min: 0, max: 3650 },
      default: 0,
      scope_levels: ['platform', 'edition', 'installation'],
    },
    // F04 — AR adjustment approval thresholds. '' = null = approval ALWAYS required
    // (CTO decision D-06). An installation lowers the bar by setting a value.
    { key: 'accounting.ar_credit_note_approval_threshold', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    { key: 'accounting.ar_adjustment_approval_threshold', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    // F04 — GL account code hints for AR adjustments ('' = use the handler default).
    { key: 'accounting.ar_write_off_expense_account_code', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    { key: 'accounting.ar_opening_balance_account_code', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    // F05 — AP adjustment approval thresholds. '' = null = approval ALWAYS required (CTO decision, ADR-037 D5 — every kind alwaysGated).
    { key: 'accounting.ap_credit_note_approval_threshold', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    { key: 'accounting.ap_adjustment_approval_threshold', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    // F05 — GL account code hints for AP adjustments ('' = use the handler default). ADR-037 D6: the write-off income account is configurable, not a hard-coded rule.
    { key: 'accounting.ap_write_off_income_account_code', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    { key: 'accounting.ap_opening_balance_account_code', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    { key: 'accounting.ap_expense_account_code', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    // F06 — Cash & Bank (ADR-038 Final Config Map — exactly these 3). All '' = fail-closed:
    // an unset/invalid clearing/opening account → the GL event is REJECTED (no hard-coded fallback);
    // an unset/non-numeric threshold → null → the adjustment is ALWAYS gated.
    { key: 'accounting.cash_movement_clearing_account_code', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    { key: 'accounting.cash_bank_adjustment_approval_threshold', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    { key: 'accounting.cash_bank_opening_balance_account_code', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    // F07 — Inventory Accounting (ADR-040 D5). The COGS account for the
    // `inventory.movement.recorded` handler. '' (unset) is fail-closed: the
    // GL event is REJECTED (`no_valuation_source`/account-resolution reasons) —
    // no hard-coded fallback, ever.
    { key: 'accounting.inventory_cogs_account_code', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    // F12 — Fixed Assets (ADR-045 D10). Resolved via the existing
    // `resolveConfiguredPostableAccount` mechanism at DISPOSAL POSTING TIME (never at
    // submission) — unset/unresolvable → the disposal is REJECTED, fail-closed. No
    // hard-coded fallback account anywhere in this domain.
    { key: 'accounting.fixed_asset_gain_on_disposal_account_code', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
    { key: 'accounting.fixed_asset_loss_on_disposal_account_code', type: 'string', default: '', scope_levels: ['platform', 'edition', 'installation'] },
  ],

  migration_tag: 'accounting',

  public_contract: {
    commands: [
      'CreateCurrency',
      'SetBaseCurrency',
      'DeactivateCurrency',
      'RecordExchangeRate',
      'CreateFiscalYear',
      'ActivateFiscalYear',
      'CloseFiscalYear',
      'TransitionFiscalPeriod',
      'CloseFiscalPeriod',
      'ReopenFiscalPeriod',
      'CreateTaxCode',
      'UpdateTaxCode',
      'CreateTaxPeriod',
      'CreateDimensionType',
      'UpdateDimensionType',
      'DeactivateDimensionType',
      'CreateDimensionValue',
      'UpdateDimensionValue',
      'DeactivateDimensionValue',
      // F02 — Chart of Accounts
      'CreateGLAccount',
      'UpdateGLAccount',
      'ReparentGLAccount',
      'AssignAccountControlFunction',
      'ReplaceAccountDimensionRules',
      'ImportAccountTemplate',
      // F03 — General Ledger + Financial Event Engine
      'CreateJournalEntry',
      'UpdateJournalEntry',
      'SubmitJournalEntry',
      'PostJournalEntry',
      'ReverseJournalEntry',
      'RedriveFinancialEvent',
      // F04 — Accounts Receivable
      'RunArReconciliation',
      'CloseArReconciliation',
      'SubmitArAdjustment',
      'DecideArAdjustment',
      // F05 — Accounts Payable
      'RunApReconciliation',
      'CloseApReconciliation',
      'SubmitApAdjustment',
      'DecideApAdjustment',
      // F06 — Cash & Bank
      'RunCashBankReconciliation',
      'CloseCashBankReconciliation',
      'SubmitCashBankAdjustment',
      'DecideCashBankAdjustment',
      // F07 — Inventory Accounting
      'RunInventoryReconciliation',
      'CloseInventoryReconciliation',
      'SubmitInventoryAdjustment',
      'DecideInventoryAdjustment',
      // F12 — Fixed Assets
      'CreateFixedAsset',
      'UpdateFixedAsset',
      'LinkFixedAssetAcquisition',
      'RunDepreciation',
      'SubmitFixedAssetDisposal',
      'DecideFixedAssetDisposal',
    ],
    queries: [
      'ListCurrencies',
      'GetBaseCurrency',
      'ListExchangeRates',
      'GetRateOnOrBefore',
      'ListFiscalYears',
      'ListFiscalPeriods',
      'ListTaxCodes',
      'ListTaxPeriods',
      'ListDimensionTypes',
      'ListDimensionValues',
      // F02 — Chart of Accounts
      'ListGLAccounts',
      'GetGLAccountTree',
      'GetGLAccount',
      'ListAccountDimensionRules',
      'ListAccountTemplates',
      // F03 — General Ledger + Financial Event Engine
      'ListJournalEntries',
      'GetJournalEntry',
      'GetLedger',
      'GetTrialBalance',
      'ListFinancialEvents',
      'GetFinancialEvent',
      // F04 — Accounts Receivable
      'ListArReconciliations',
      'GetArReconciliation',
      'GetCustomerArStatement',
      // F05 — Accounts Payable
      'ListApReconciliations',
      'GetApReconciliation',
      'GetApStatement',
      // F06 — Cash & Bank
      'ListCashBankReconciliations',
      'GetCashBankReconciliation',
      'GetCashBankPositionStatement',
      // F07 — Inventory Accounting
      'ListInventoryReconciliations',
      'GetInventoryReconciliation',
      // F12 — Fixed Assets
      'ListFixedAssets',
      'GetFixedAsset',
      'ListDepreciationRuns',
      'GetDepreciationRunLines',
      'ListFixedAssetDisposals',
      'GetFixedAssetReconciliation',
      // F14 — Financial Reporting (ADR-047)
      'GetBalanceSheet',
      'GetProfitAndLoss',
      'GetCashFlowStatement',
      'GetTaxPeriodSummary',
    ],
    events: [
      'accounting.fiscal_period.status_changed',
      // F13 (ADR-046 D6) — new, symmetric event; F01 only declared the period-level one.
      'accounting.fiscal_year.status_changed',
      'accounting.exchange_rate.recorded',
      // F02 — Chart of Accounts
      'accounting.gl_account.created',
      'accounting.gl_account.updated',
      'accounting.gl_account.deactivated',
      // F03 — General Ledger + Financial Event Engine
      'accounting.journal.posted',
      'accounting.journal.reversed',
      'accounting.financial_event.rejected',
      // F04 — Accounts Receivable
      'accounting.ar.reconciliation_run',
      'accounting.ar.adjustment_posted',
      // F05 — Accounts Payable
      'accounting.ap.reconciliation_run',
      'accounting.ap.adjustment_posted',
      // F06 — Cash & Bank
      'accounting.cash.reconciliation_run',
      'accounting.cash.adjustment_posted',
      // F07 — Inventory Accounting
      'accounting.inventory.reconciliation_run',
      'accounting.inventory.adjustment_posted',
      // F12 — Fixed Assets
      'accounting.fixed_asset.depreciation_run',
      'accounting.fixed_asset.disposal_posted',
    ],
  },
};
