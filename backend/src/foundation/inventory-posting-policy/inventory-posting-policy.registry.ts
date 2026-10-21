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
  /** Phase C-2: purchase discount (reduces cost), capitalised freight (adds cost) and expensed charges - decimal strings, absent/'0' when none. */
  discountAmount?: string;
  capitalizedFreight?: string;
  expensedCharges?: string;
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
  /**
   * Phase D-1 (owner decisions D7 / E3) - OPTIONAL pre-mutation gate of a Purchase Return: the `inventory` and `grni` control accounts must exist and, when the book cost of the stock that leaves differs
   * from the receipt cost (`expectedDifference` <> 0), the separately configured supplier-return cost-difference account must resolve. Throws (409) BEFORE any stock / valuation / outbox write.
   */
  assertPurchaseReturnPostable?(input: { expectedDifference: string; creditNet?: string; creditTax?: string }, manager?: EntityManager): Promise<void>;
  /**
   * C2 (ADR-INV-02) - OPTIONAL pre-mutation gate for an EXPLICIT business date: a fiscal year/period must cover it and be open. Throws (409) BEFORE any
   * stock / valuation / outbox write; the date is never silently moved into another period. Unbound / absent => no GL => no gate.
   */
  assertPostingDateOpen?(businessDate: string, manager?: EntityManager): Promise<void>;
  /**
   * C4 (ADR-INV-01) - OPTIONAL pre-mutation gate of an Opening Balance Batch: the `inventory` control account exists and the account its journal needs resolves (opening:
   * the configured opening-balance account; reversal: the same; correction: the configured opening-correction account, which must be EQUITY-side so a wrong opening
   * never distorts profit and loss). Throws (409) BEFORE any stock/valuation write. No fallback account.
   */
  assertOpeningBatchPostable?(kind: 'opening' | 'reversal' | 'correction', manager?: EntityManager): Promise<void>;
  /**
   * C2 (ADR-INV-10) - OPTIONAL read-only financial status of the events that reference an operational record (document, movement): what the response of an
   * in-request dispatch reports, so a document never claims "posted to GL" while its posting is pending or rejected.
   */
  financialStatusByReference?(referenceType: string, referenceId: string, manager?: EntityManager): Promise<FinancialPostingSummary>;
}

/** `none` = no financial event exists for the reference (e.g. a transfer posts no journal under Model A). */
export type FinancialPostingSummary = 'none' | 'posted' | 'pending' | 'rejected' | 'mixed';

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
