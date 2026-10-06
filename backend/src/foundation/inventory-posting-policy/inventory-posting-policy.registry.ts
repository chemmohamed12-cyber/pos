import { Global, Injectable, Module } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * D3-B (2026-10-04) — the pre-mutation gate for a MANUAL receipt. Implemented by `accounting` (it owns the
 * Reason Code → Offset GL Account configuration and the chart) and consumed by `inventory-warehouse` (it must
 * reject a bad receipt BEFORE any stock/valuation write). The two domains cannot import each other
 * (`AccountingModule` already depends on the inventory side, so the reverse import would be a cycle) — hence this
 * tiny foundation holder: accounting BINDS its implementation at module init, inventory reads it `@Optional()`.
 * Unbound ⇒ accounting is not installed ⇒ there is no GL to post to.
 */
/** D4 — what the returns domain tells the accounting pre-flight about a financial sale return. */
export interface SaleReturnPostableInput {
  /** The original POSTED invoice whose Revenue/AR/tax this return reverses, or `null` when the original sale created no Revenue/AR (inventory/COGS only). */
  invoiceId: string | null;
  /** The tax part that will be reversed (decimal string; '0' when none). */
  taxAmount: string;
}

/** D5 — what procurement tells the accounting pre-flight about a supplier invoice about to be posted. */
export interface SupplierInvoicePostableInput {
  /** Signed Purchase Price Variance (invoice net − receipt value), decimal string; '0' when none. */
  ppvBase: string;
  /** The explicit VAT amount (decimal string; '0' when none). */
  taxAmount: string;
}

export interface InventoryPostingPolicy {
  /**
   * Resolves a manual-receipt reason code to its configured offset GL account, or throws (409/400) when the reason
   * is unknown / has no configured account / its account is not an active, postable, non-control chart account.
   * Never falls back to any other account.
   */
  assertManualReceiptReason(reasonCode: string, manager?: EntityManager): Promise<{ glAccountCode: string }>;
  /** The reason codes that currently have a configured offset account (what the UI may offer). */
  listManualReceiptReasons(): string[];
  /**
   * D4 (2026-10-05) — the pre-mutation gate of a financial sale return: every GL account the return's journals will need
   * (Inventory control, configured COGS, and — when an original invoice is reversed — configured Sales Returns, AR control,
   * the original posted-invoice trail and, when tax is reversed, the original tax account) must resolve, or it throws
   * (409) BEFORE any stock/ledger write. No fallback account, ever.
   */
  assertSaleReturnPostable(input: SaleReturnPostableInput, manager?: EntityManager): Promise<void>;
  /**
   * D5 (2026-10-05) — the pre-mutation gate of posting a supplier invoice: the GRNI and AP control accounts must exist; when
   * there is a price variance the configured PPV account must be valid; when there is VAT exactly ONE active postable
   * `tax_receivable` account must resolve. Throws (409) BEFORE any ledger/state/outbox write. No fallback account.
   */
  assertSupplierInvoicePostable(input: SupplierInvoicePostableInput, manager?: EntityManager): Promise<void>;
}

@Injectable()
export class InventoryPostingPolicyRegistry {
  private policy: InventoryPostingPolicy | null = null;

  bind(policy: InventoryPostingPolicy): void {
    this.policy = policy;
  }

  get(): InventoryPostingPolicy | null {
    return this.policy;
  }
}

@Global()
@Module({
  providers: [InventoryPostingPolicyRegistry],
  exports: [InventoryPostingPolicyRegistry],
})
export class InventoryPostingPolicyModule {}
