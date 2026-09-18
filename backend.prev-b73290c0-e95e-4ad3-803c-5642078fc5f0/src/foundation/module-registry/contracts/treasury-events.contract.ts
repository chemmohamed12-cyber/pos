/**
 * F06 — Cash & Bank (ADR-038 D1/D2/D4/D6). The Treasury↔GL event
 * boundary. Defined here in `foundation/module-registry/contracts/` — the
 * one place `finance`/`treasury` (the publisher, F06-H1) and `accounting`
 * (the consumer — F03's already-built `handleCashRecorded` /
 * `handleTransferCompleted`) may both import from
 * (`no-restricted-imports` blocks a direct cross-domain import).
 *
 * Unlike F04/F05, the two routine topics below **do get a real publisher
 * in F06** (F06-H1, wired into `TreasuryService` via the Transactional
 * Outbox). The `BankStatementContract` at the bottom is the F05-style
 * dormant stub for the future **OP-CASH** phase (cashier sessions +
 * external bank-statement import/auto-match).
 *
 * Every payload carries an explicit `idempotencyKey` — the publisher
 * builds it; the F03 derived fallback is not acceptable for a
 * post → reverse sequence on the same source id.
 */

// ---------------------------------------------------------------------------
// Routine Treasury → GL events (F06-H1 publisher; F03 handlers already exist)
// ---------------------------------------------------------------------------

/** Common envelope on every Treasury event. */
export interface TreasuryEventBase {
  /** REQUIRED, unique per real occurrence — e.g. `treasury:txn:<id>:recorded`. */
  idempotencyKey: string;
  /** ISO date — drives fiscal-period resolution in F03's posting gate. */
  businessDate: string;
  orgUnitId: string | null;
  /** ISO 4217 transaction currency (EGP-only in V1 — ADR-038 D11). */
  currency: string;
  sourceEntityType: 'treasury_transaction';
  sourceEntityId: string;
  /** Generic external-document reference at emission time (E-02) — never bank/ETA-named. */
  externalDocument: { type: string; id: string; status: string | null; secondaryId: string | null } | null;
  payloadVersion: number;
}

/**
 * `treasury.cash.recorded` — a single-account cash movement (a direct
 * `cash_in` / `cash_out` from the Treasury UI, or the opposite-direction
 * leg of a reversal). Consumed by F03 `handleCashRecorded` → Dr/Cr the
 * `bank` GL account vs `counterAccountCode` (or, when absent, the
 * configured clearing account — ADR-038 D3).
 */
export interface CashRecordedEvent extends TreasuryEventBase {
  /** the Treasury account's mapped GL account code (`treasury_accounts.glAccountCode`). */
  accountCode: string;
  /** positive amount, EGP. */
  amount: string;
  direction: 'in' | 'out';
  /** explicit GL counter account code, or null → F03 falls back to the clearing-account config. */
  counterAccountCode: string | null;
  treasuryTransactionId: string;
  /** set when this event is the offsetting leg of a reversal (ADR-038 D6). */
  reversalOf: string | null;
  reference: string | null;
  reason: string | null;
}

/**
 * `treasury.transfer.completed` — an inter-account transfer (both legs).
 * Consumed by F03 `handleTransferCompleted` → Dr to-account / Cr
 * from-account. Both accounts must be GL-mapped for the event to be
 * published at all.
 */
export interface TransferCompletedEvent extends TreasuryEventBase {
  amount: string;
  fromAccountCode: string;
  toAccountCode: string;
  transferGroupId: string;
  outTransactionId: string;
  inTransactionId: string;
  /** set when this event is the offsetting leg of a reversal (ADR-038 D6). */
  reversalOf: string | null;
  reference: string | null;
}

export const TREASURY_EVENT_TOPICS = {
  cashRecorded: 'treasury.cash.recorded',
  transferCompleted: 'treasury.transfer.completed',
} as const;

/** The Treasury topics with a real publisher wired in F06 V1 (F06-H1). */
export const TREASURY_EVENT_TOPICS_V1: readonly string[] = [
  TREASURY_EVENT_TOPICS.cashRecorded,
  TREASURY_EVENT_TOPICS.transferCompleted,
] as const;

/**
 * F06's own internal event type for an approved cash/bank adjustment —
 * emitted (via `FinancialEventService.ingest`) by F06's FA-01 approval
 * subscriber and consumed by F06's own handler → the F03 posting gate →
 * GL. Not cross-domain (`sourceDomain: 'accounting'`).
 */
export const CASH_BANK_ADJUSTMENT_APPROVED_EVENT = 'accounting.cash.adjustment.approved';

// ---------------------------------------------------------------------------
// Bank-statement contract (for the future OP-CASH domain to provide) — dormant
// ---------------------------------------------------------------------------

/**
 * `CashBankReconciliationService` MAY inject this `@Optional()`. **Unbound
 * today** (ADR-038 D2) — F06's reconciliation compares the Treasury
 * operational ledger against the `bank` GL balance (an internal book
 * reconciliation). The future OP-CASH domain binds an implementation to
 * light up external bank-statement matching (statement line ↔ ledger /
 * GL), with zero F06 change.
 */
export interface BankStatementContract {
  /** Imported statement lines for a Treasury/GL account, as of a date. */
  listStatementLines(
    treasuryAccountId: string,
    filter?: { from?: string; to?: string; matched?: boolean },
  ): Promise<Array<{ id: string; valueDate: string; amount: string; direction: 'debit' | 'credit'; reference: string | null; matched: boolean }>>;
  /** The closing balance of the latest imported statement for a Treasury/GL account. */
  getLatestStatementClosingBalance(treasuryAccountId: string, asOfDate?: string): Promise<{ closingBalance: string; statementDate: string } | null>;
}

export const BANK_STATEMENT_CONTRACT = Symbol('BANK_STATEMENT_CONTRACT');
