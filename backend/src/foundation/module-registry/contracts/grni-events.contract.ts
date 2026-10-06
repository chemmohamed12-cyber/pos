import type { EntityManager } from 'typeorm';

/**
 * ADR-054/ADR-056 (Month-End Closing, Phase 8). The GRNI (Goods Received
 * Not Invoiced) integration boundary a **future Procurement-side GRNI
 * posting implementation** will provide (Dr Inventory / Cr GRNI at
 * receipt, Dr GRNI / Cr AP at supplier invoice, per ADR-054). Defined here
 * in `foundation/module-registry/contracts/` — the one place both domains
 * may import from (`no-restricted-imports` blocks a direct cross-domain
 * import), the exact same pattern as `SUPPLIER_LEDGER_CONTRACT`
 * (`ap-events.contract.ts`) before ADR-048 bound it.
 *
 * **NOTHING in this file has a producer wired yet** — confirmed by direct
 * search (no "grni" reference anywhere in this codebase prior to this
 * phase). `GrniReconciliationService` injects `GRNI_LEDGER_CONTRACT`
 * `@Optional()` and reports `no_subledger_source` until a future
 * Procurement-side session binds an implementation — never a mock ledger
 * standing in for the real one (ADR-056's explicit instruction).
 */
export interface GrniBalanceEntry {
  goodsReceiptId: string;
  goodsReceiptNumber: string | null;
  purchaseOrderId: string | null;
  supplierId: string | null;
  /** Outstanding, uninvoiced received value for this receipt — traceability back to the originating receipt, per ADR-054 item 4. */
  balance: string;
}

export interface GrniLedgerContract {
  /** Σ of every outstanding (uninvoiced) goods-receipt balance as of the date, SQL NUMERIC. */
  /** Area 21 (2026-09-28): `manager?` added — the concrete `GrniLedgerService` gained it during `grni.controller.ts`'s own retrofit. */
  getAllGrniBalances(asOfDate?: string, manager?: EntityManager): Promise<{ balances: GrniBalanceEntry[]; total: string }>;
}

export const GRNI_LEDGER_CONTRACT = Symbol('GRNI_LEDGER_CONTRACT');
