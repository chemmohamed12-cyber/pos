/**
 * ERP Foundation — P4 Tranche-2. Public contract FINANCE exposes to
 * SALES's `deposit-control` business domain — breaks the
 * `deposit-control → treasury / customer-finance` edge of the
 * `sales ↔ finance` cycle (F-MOD-2) via dependency inversion (ADR-024 §4,
 * same pattern as sales.contract.ts / inventory.contract.ts for the other
 * two edges). The REVERSE edge of this same cycle
 * (customer-finance → crm / sales-orders, i.e. `finance depends_on: sales`
 * per finance.manifest.ts) is closed by `sales.contract.ts`'s
 * `SalesCustomersContract`/`SalesOrdersReadContract` instead — not this
 * file, which only carries what FINANCE exposes.
 *
 * Three separate tokens (treasury / customer-ledger / invoice) mirror the
 * three separate concrete services `deposits.service.ts` actually calls —
 * each bound in its OWN owning module (treasury.module.ts /
 * customer-finance.module.ts) via `useExisting`, not bundled into one
 * god-contract.
 *
 * `CustomerLedgerEntryType`/`LedgerDirection` (below) and `postEntry`'s /
 * `recomputeStatus`'s return types are deliberately NOT imported from
 * `domains/customer-finance/**` — `npm run lint`'s `no-restricted-imports`
 * blocks any import, type-only included, from another domain's
 * `domain/application/infrastructure` folders (P4 Task 2 verification
 * finding; see `sales.contract.ts`'s correction note for the full
 * story). Literal unions are redeclared locally (structurally identical,
 * zero behavior change); `postEntry` returns `Promise<unknown>` rather
 * than the real `CustomerLedgerEntry` entity type, since no caller reads
 * the resolved value and `unknown` avoids both the entity-type leak and
 * TS's `implements`-vs-`void` incompatibility (same reasoning as
 * `inventory.contract.ts`). `recomputeStatus` keeps `Promise<string>` —
 * a primitive, nothing to import.
 */

import { EntityManager } from 'typeorm';

export type CustomerLedgerEntryTypeContract =
  | 'sales_invoice'
  | 'deposit'
  | 'payment'
  | 'cod_collection'
  | 'return_credit_note'
  | 'debit_note'
  | 'adjustment'
  | 'opening_balance'
  | 'refund';

export type LedgerDirectionContract = 'debit' | 'credit';

export interface TreasuryAccountTypeView {
  id: string;
  code: string;
}

export interface FinanceTreasuryContract {
  /** Only `.id` of the created transaction is ever read by callers — narrowed from the concrete `Promise<TreasuryTransaction>`. */
  createDepositTransaction(
    depositId: string,
    salesOrderId: string,
    customerId: string,
    amount: string,
    treasuryAccountId: string,
    actorUserId: string,
  ): Promise<{ id: string }>;

  /** P4 Tranche-2 (shipment domain) — only `.id` of the created account is ever read. */
  createAccount(code: string, name: string, accountTypeId: string, actorUserId: string): Promise<{ id: string }>;

  /**
   * P4 Tranche-2 (delivery domain) — only `.id` of the created transaction is ever read.
   * F09-H3 (ADR-042 D3c) — additive optional trailing `manager?`, mirroring ADR-041 D18a's
   * identical extension of `JournalEntryService.createEntry`/`postEntry`: when supplied, the leg is
   * written inside the CALLER's transaction instead of opening a new one — lets
   * `DeliveryService.remitCollection` make its Treasury leg + Collection status + AR ledger +
   * Outbox publish one atomic unit. Omitted, behavior is byte-identical to before this parameter
   * existed.
   */
  cashIn(
    accountId: string,
    amount: string,
    customerId: string | null,
    salesOrderId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ id: string }>;

  /** P4 Tranche-2 (delivery domain) — only `out.id` of the pair is ever read. F09-H3 (ADR-042 D3c) — see `cashIn`'s own doc comment for the additive `manager?` parameter. */
  transfer(
    sourceAccountId: string,
    destinationAccountId: string,
    amount: string,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ out: { id: string } }>;

  /** Real return is already a primitive `Promise<string>` — no narrowing needed. */
  getAccountBalance(accountId: string): Promise<string>;

  /** Only `.code` of each type is ever read by callers. */
  listAccountTypes(): Promise<TreasuryAccountTypeView[]>;

  /**
   * F06 / F06-H1 (ADR-038 D9) — every Treasury account's derived operational
   * balance + its GL-account mapping, as of an optional date (inclusive of
   * the whole calendar day). F06's Cash/Bank↔GL reconciliation reads this
   * instead of touching `treasury_*` tables.
   */
  getAllTreasuryBalances(asOfDate?: string): Promise<{
    balances: Array<{ treasuryAccountId: string; code: string; name: string; glAccountCode: string | null; balance: string }>;
  }>;

  /** F06 — one Treasury account's operational ledger rows (for the Cash/Bank position statement). */
  listTreasuryLedger(
    treasuryAccountId: string,
    filter?: { from?: string; to?: string },
  ): Promise<TreasuryLedgerEntryView[]>;
}
export const FINANCE_TREASURY_CONTRACT = Symbol('FINANCE_TREASURY_CONTRACT');

/** F06 — a narrowed view of one `treasury_transactions` row (no entity-type leak). */
export interface TreasuryLedgerEntryView {
  transactionNumber: string;
  type: 'cash_in' | 'cash_out' | 'transfer_in' | 'transfer_out';
  amount: string;
  movementDate: string;
  reference: string | null;
  reason: string | null;
  status: 'posted' | 'reversed';
}

export interface PostLedgerEntryInputContract {
  customerId: string;
  entryType: CustomerLedgerEntryTypeContract;
  direction: LedgerDirectionContract;
  amount: string;
  salesOrderId?: string | null;
  invoiceId?: string | null;
  depositId?: string | null;
  paymentId?: string | null;
  returnCreditId?: string | null;
  shipmentId?: string | null;
  treasuryTransactionId?: string | null;
  reference?: string | null;
  reason?: string | null;
  createdByUserId: string;
}

export interface CustomerLedgerEntryViewContract {
  amount: string;
  direction: LedgerDirectionContract;
  status: 'posted' | 'reversed';
  entryType: CustomerLedgerEntryTypeContract;
  entryDate: Date;
  entryNumber: string;
  reason: string | null;
  salesOrderId: string | null;
  invoiceId: string | null;
}

export interface FinanceCustomerLedgerContract {
  /**
   * Return value never read at the one call site in deposit-control — see file-header note for why
   * this is `Promise<unknown>`, not `void` or the real entity type. F09-H3 (ADR-042 D3c) — additive
   * optional trailing `manager?`; the concrete `CustomerLedgerService.postEntry` already supported
   * this, only the CONTRACT interface was missing it — needed so `DeliveryService.remitCollection`
   * (a contract consumer) can thread its own transaction manager through.
   */
  postEntry(input: PostLedgerEntryInputContract, manager?: EntityManager): Promise<unknown>;
  /** P4 Tranche-2 (reports domain) — matches the real method's inline literal return type exactly. */
  getCreditSummary(customerId: string): Promise<{ balance: string; creditLimit: string | null; availableCredit: string | null; overdueAmount: string }>;
  /** P4 Tranche-2 (reports domain) — narrowed from the real `Promise<CustomerLedgerEntry[]>`. */
  listLedger(customerId: string, filters?: { entryType?: string; from?: string; to?: string }): Promise<CustomerLedgerEntryViewContract[]>;
  /** F04 / F04-H1 (ADR-036 D11) — every customer's derived AR balance + the grand total, as of an optional date. F04's AR↔GL reconciliation reads this instead of touching customer-finance tables. */
  getAllCustomerBalances(asOfDate?: string): Promise<{ balances: Array<{ customerId: string; balance: string }>; total: string }>;
}
export const FINANCE_CUSTOMER_LEDGER_CONTRACT = Symbol('FINANCE_CUSTOMER_LEDGER_CONTRACT');

export interface FinanceInvoiceContract {
  /** Only `.id` of the found invoice is ever read — narrowed from `Promise<SalesInvoice | null>`. */
  findOpenInvoiceForOrder(salesOrderId: string): Promise<{ id: string } | null>;
  getStatus(invoiceId: string): Promise<string>;
  /** Return value never read at the one call site — kept as the real `Promise<string>` return (the resulting status), same `implements`-compatibility reasoning as `postEntry` above. */
  recomputeStatus(invoiceId: string, actorUserId: string): Promise<string>;
  /** P4 Tranche-2 (returns domain) — narrowed from the real `Promise<SalesInvoice & {state, remaining, lines}>` to the 3 fields actually read. */
  getInvoice(invoiceId: string, actorUserId: string): Promise<{ state: string; customerId: string; salesOrderId: string }>;
}
export const FINANCE_INVOICE_CONTRACT = Symbol('FINANCE_INVOICE_CONTRACT');
