/**
 * F02 — Chart of Accounts (Blueprint §3.1, ADR-034 D4/D6). A control
 * account is one managed by a subledger — F02 only *marks* it; F03
 * enforces "no manual journal line to a control account" and F04/F05/F07
 * own the actual reconciliation.
 */
export type ControlFunction =
  | 'ar' // Accounts Receivable control — F04
  | 'ap' // Accounts Payable control — F05
  | 'bank' // Cash & Bank control — F06
  | 'inventory' // Inventory valuation control — F07/F08
  | 'tax_payable' // output/collected tax control — F10
  | 'tax_receivable' // input/paid tax control — F10
  | 'retained_earnings' // year-end net-income roll-forward target — F13
  | 'fx_gain_loss' // realised/unrealised FX — later separate increment
  | 'rounding' // currency-rounding differences — F03
  | 'fixed_asset' // Fixed Asset subledger control — F12 (ADR-045 D3). A single value marks BOTH a
  // category's cost account and its Accumulated Depreciation contra account (distinguished by
  // `isContra`, never by a second control-function value) — mirrors `bank` already spanning
  // multiple accounts under one function. NOT singleton: an installation may hold several
  // fixed-asset cost/contra pairs (one per category).
  | 'grni' // Goods Received Not Invoiced control — ADR-054/ADR-056. Marks the liability account
  // that sits between a Goods Receipt (Dr Inventory / Cr GRNI) and its Supplier Invoice (Dr GRNI /
  // Cr AP) — a receipt-based-recognition control account, same "F02 only marks it, the owning
  // domain's reconciliation enforces it" discipline as every other control function here. Not
  // singleton — mirrors `ap`/`ar`.
  | 'wip' // Work-in-Process control — ADR-061 (Manufacturing). Marks the asset account every
  // Manufacturing movement (Material Issue, Material Return, Finished Goods Output) reclassifies
  // Inventory into/out of — same "F02 only marks it, the owning domain's reconciliation enforces
  // it" discipline as `grni`. Not singleton — an installation may hold several WIP accounts (e.g.
  // split by warehouse or product line), same as `bank`/`grni`.
  | 'wages_payable'; // Payroll liability control — ADR-070 §16. Marks the account a
  // `payroll.run.posted` Financial Event credits (Dr Salaries & Wages Expense / Cr this account).
  // Same "F02 only marks it" discipline as `grni`/`wip`. Not singleton. Tax/social-insurance
  // control functions are deliberately NOT added here — ADR-067 §E ratified the boundary only,
  // not the rates; nothing exists to post yet.

export const CONTROL_FUNCTIONS: readonly ControlFunction[] = [
  'ar',
  'ap',
  'bank',
  'inventory',
  'tax_payable',
  'tax_receivable',
  'retained_earnings',
  'fx_gain_loss',
  'rounding',
  'fixed_asset',
  'grni',
  'wip',
  'wages_payable',
] as const;

/**
 * ADR-034 D4 — control functions of which EXACTLY ONE account may exist
 * per chart (enforced by a partial unique index + a service check). All
 * others may legitimately have several accounts (e.g. multiple bank
 * accounts, several AR control accounts split by business line).
 */
export const SINGLETON_CONTROL_FUNCTIONS: ReadonlySet<ControlFunction> = new Set<ControlFunction>(['retained_earnings']);

export function isControlFunction(value: unknown): value is ControlFunction {
  return typeof value === 'string' && (CONTROL_FUNCTIONS as readonly string[]).includes(value);
}

/**
 * F02 — Chart of Accounts (Blueprint §3.1). How an account's amounts
 * relate to currency, feeding F03's Monetary Amount Contract (F01 §3.7):
 * `functional_only` posts only in the base/functional currency;
 * `single_foreign` requires `restrictCurrencyCode`; `any` is unconstrained.
 */
export type AccountCurrencyMode = 'functional_only' | 'single_foreign' | 'any';

export const ACCOUNT_CURRENCY_MODES: readonly AccountCurrencyMode[] = ['functional_only', 'single_foreign', 'any'] as const;

export function isAccountCurrencyMode(value: unknown): value is AccountCurrencyMode {
  return typeof value === 'string' && (ACCOUNT_CURRENCY_MODES as readonly string[]).includes(value);
}

/** F02 — Chart of Accounts (Blueprint §3.2). Per-account dimension policy mode. */
export type DimensionRuleMode = 'required' | 'optional' | 'blocked';

export const DIMENSION_RULE_MODES: readonly DimensionRuleMode[] = ['required', 'optional', 'blocked'] as const;

export function isDimensionRuleMode(value: unknown): value is DimensionRuleMode {
  return typeof value === 'string' && (DIMENSION_RULE_MODES as readonly string[]).includes(value);
}
