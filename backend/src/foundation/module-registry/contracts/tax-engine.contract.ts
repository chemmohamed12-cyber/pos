/**
 * F10 (ADR-043 D1). Public contract `accounting` exposes for Tax
 * Definition + Calculation — `accounting` owns TaxCode and the rate/type/
 * inclusive-exclusive arithmetic; a subledger (starting with
 * `customer-finance`) calls this contract, never `TaxCode`/
 * `TaxEngineService` directly (no cross-domain class import, same rule
 * every other contract in this file enforces).
 *
 * Bound in its own small `TaxEngineModule` (`domains/accounting/tax-engine.module.ts`),
 * NOT in the main `AccountingModule` — `AccountingModule` already imports
 * `CustomerFinanceModule` (for `FINANCE_CUSTOMER_LEDGER_CONTRACT`), so
 * `CustomerFinanceModule` importing `AccountingModule` back for this
 * contract would create a real NestJS module cycle. `TaxEngineModule` has
 * no import of either module, so `CustomerFinanceModule` can depend on it
 * with zero cycle — an ordinary DI-graph resolution, not an ownership
 * change (D1's ownership split is unaffected; `TaxCode`/`TaxEngineService`
 * still live under `src/domains/accounting/`).
 *
 * V1 = invoice-level, not per-line (Blueprint §0 amendment) — `calculateForInvoice`
 * takes one base amount and one optional explicit tax code, not an array.
 * The method name says "ForInvoice" deliberately (not a generic
 * "calculate(entries[])") so a future per-line signature can be added
 * alongside it without a breaking change to this one.
 */
export interface TaxCalculationResult {
  /** The tax code actually used (explicit id if valid+active, else the resolved default, else null) — the caller freezes this onto its own document. */
  taxCodeId: string | null;
  /** 2-decimal string, matching `SalesInvoice.taxAmount`'s NUMERIC(14,2) precision. '0.00' when no tax code resolves — never a hard failure at calculation time (Blueprint §3 D3). */
  taxAmount: string;
}

export interface TaxEngineContract {
  /**
   * Calculation only (ADR-043 D1/D3) — never posts to the GL, never reads
   * or writes anything outside `accounting_tax_codes`. Resolution order:
   * (1) `explicitTaxCodeId` if it resolves to an active `TaxCode`; (2)
   * `accounting.default_tax_code` config if set and resolves to an active
   * `TaxCode`; (3) no tax code → `{taxCodeId: null, taxAmount: '0.00'}`.
   * `baseAmount` is treated as tax-EXCLUSIVE when the resolved code has
   * `isInclusive = false` (the common case), or tax-INCLUSIVE (the amount
   * already contains the tax) when `isInclusive = true`.
   */
  calculateForInvoice(baseAmount: string, explicitTaxCodeId?: string | null): Promise<TaxCalculationResult>;

  /**
   * Post-time only (ADR-043 D5) — the CURRENT `accountMappingRef` for an
   * already-resolved, already-frozen `taxCodeId`. This is an account-code
   * LOOKUP, not a tax-amount recalculation — resolving which GL account a
   * tax line posts to from the chart's current configuration is exactly
   * how `ar`/`bank`/revenue account codes already behave in
   * `handleInvoicePosted` (RBW §1.2); it does not violate D3's
   * "never recalculate the amount" rule. Returns null when `taxCodeId` is
   * null or the code has no `accountMappingRef` set — the caller's
   * existing `resolveControlAccount('tax_payable')` fallback (already
   * built, RBW §1.2) then applies unchanged.
   */
  resolveTaxAccountCode(taxCodeId: string | null): Promise<string | null>;
}
export const TAX_ENGINE_CONTRACT = Symbol('TAX_ENGINE_CONTRACT');
