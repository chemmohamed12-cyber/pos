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
  | 'payment_application' // CUS-01
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
  /**
   * D2 (2026-10-04, CTO-approved): the pre-mutation gate for any financial posting made FROM a Treasury
   * account. Resolves the account's own GL mapping or rejects (409) when it is unmapped — callers invoke it
   * BEFORE any treasury/ledger write, inside their own transaction, so an unmapped account produces zero side
   * effects. No fallback to any control account, ever.
   */
  requireGlMappedAccount(accountId: string, manager?: EntityManager): Promise<{ glAccountCode: string }>;

  /** Only `.id` of the created transaction is ever read by callers — narrowed from the concrete `Promise<TreasuryTransaction>`. */
  /**
   * Area 21 Operational Company Scoping Retrofit (2026-09-28): `manager?` added — the concrete
   * `TreasuryService.createDepositTransaction` gained it during `deposits.controller.ts`'s own retrofit.
   */
  createDepositTransaction(
    depositId: string,
    salesOrderId: string,
    customerId: string,
    amount: string,
    treasuryAccountId: string,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ id: string }>;

  /**
   * P4 Tranche-2 (shipment domain) — only `.id` of the created account is
   * ever read. Area 21 Operational Company Scoping Retrofit (2026-09-27):
   * `manager?` added — the concrete `TreasuryService.createAccount`
   * gained it during `treasury.controller.ts`'s own retrofit.
   */
  createAccount(code: string, name: string, accountTypeId: string, actorUserId: string, manager?: EntityManager, orgUnitId?: string | null): Promise<{ id: string }>;

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

  /**
   * OP-Procurement/AP Blueprint §8, CTO ratification Decision 1 (Option A,
   * approved 2026-09-18) — the payable-side counterpart to `cashIn`, for
   * `procurement`'s `SupplierPaymentService` to reach Treasury through
   * this contract instead of importing the concrete `TreasuryService`.
   * Only `.id` of the created transaction is ever read by callers.
   */
  cashOutForSupplier(
    accountId: string,
    amount: string,
    supplierId: string | null,
    supplierInvoiceId: string | null,
    reference: string | null,
    reason: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ id: string }>;

  /**
   * ADR-070 §9 — the payroll-side counterpart to `cashOutForSupplier`,
   * for `payroll`'s `PayrollService.disburse()` to reach Treasury through
   * this contract instead of importing the concrete `TreasuryService`.
   * Only `.id` of the created transaction is ever read by callers.
   */
  cashOutForEmployee(
    accountId: string,
    amount: string,
    employeeId: string | null,
    payrollRunId: string | null,
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

  /** Real return is already a primitive `Promise<string>` — no narrowing needed. Area 21: `manager?` added — concrete already had it. */
  getAccountBalance(accountId: string, manager?: EntityManager): Promise<string>;

  /** Only `.code` of each type is ever read by callers. Area 21: `manager?` added — concrete `TreasuryService.listAccountTypes` gained it during `treasury.controller.ts`'s own retrofit. */
  listAccountTypes(manager?: EntityManager): Promise<TreasuryAccountTypeView[]>;

  /**
   * F06 / F06-H1 (ADR-038 D9) — every Treasury account's derived operational
   * balance + its GL-account mapping, as of an optional date (inclusive of
   * the whole calendar day). F06's Cash/Bank↔GL reconciliation reads this
   * instead of touching `treasury_*` tables.
   *
   * Multi-Company Area 9 (2026-09-22) — `manager?` added so a
   * company-scoped caller (`ClosingSnapshotService`) can run this against
   * that Company's own connection instead of the ambient one. Falls back
   * to the ambient connection when omitted, unchanged for every existing
   * caller.
   */
  getAllTreasuryBalances(asOfDate?: string, manager?: EntityManager): Promise<{
    balances: Array<{ treasuryAccountId: string; code: string; name: string; glAccountCode: string | null; balance: string }>;
  }>;

  /** F06 — one Treasury account's operational ledger rows (for the Cash/Bank position statement). */
  listTreasuryLedger(
    treasuryAccountId: string,
    filter?: { from?: string; to?: string },
    manager?: EntityManager,
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
  getCreditSummary(customerId: string, manager?: EntityManager): Promise<{ balance: string; creditLimit: string | null; availableCredit: string | null; overdueAmount: string }>;
  /** P4 Tranche-2 (reports domain) — narrowed from the real `Promise<CustomerLedgerEntry[]>`. */
  listLedger(customerId: string, filters?: { entryType?: string; from?: string; to?: string }, manager?: EntityManager): Promise<CustomerLedgerEntryViewContract[]>;
  /** F04 / F04-H1 (ADR-036 D11) — every customer's derived AR balance + the grand total, as of an optional date. F04's AR↔GL reconciliation reads this instead of touching customer-finance tables. Multi-Company Area 9 (2026-09-22) — `manager?` added, same reason as `getAllTreasuryBalances` above. */
  getAllCustomerBalances(asOfDate?: string, manager?: EntityManager): Promise<{ balances: Array<{ customerId: string; balance: string }>; total: string }>;
}
export const FINANCE_CUSTOMER_LEDGER_CONTRACT = Symbol('FINANCE_CUSTOMER_LEDGER_CONTRACT');

/**
 * D4 (2026-10-05) — the ORIGINAL invoice value a return reverses. `totalNet` is tax-exclusive (the invoice's own `totalAmount`),
 * `taxAmount` is the invoice-level tax frozen at draft. Lines carry the net after discount (`lineTotal`).
 */
export interface InvoiceReturnBasis {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  salesOrderId: string;
  state: 'posted' | 'partially_paid' | 'paid';
  totalNet: string;
  taxAmount: string;
  lines: Array<{ salesOrderLineId: string | null; quantity: number; lineTotal: string }>;
}

export interface FinanceInvoiceContract {
  /**
   * D4 — the order's invoice that actually created Revenue/AR (state posted / partially_paid / paid), read through the
   * CALLER's manager (Company context). `null` when the order has no invoice, or only a draft/void one — a return of such a
   * sale has no Revenue/AR/tax to reverse.
   */
  getReturnBasis(salesOrderId: string, manager?: EntityManager): Promise<InvoiceReturnBasis | null>;
  /**
   * Only `.id` of the found invoice is ever read — narrowed from `Promise<SalesInvoice | null>`.
   * Area 21 Operational Company Scoping Retrofit (2026-09-28): `manager?` added — the concrete
   * `InvoiceService.findOpenInvoiceForOrder` gained it during `delivery.controller.ts`'s own retrofit.
   */
  findOpenInvoiceForOrder(salesOrderId: string, manager?: EntityManager): Promise<{ id: string } | null>;
  /** Area 21: `manager?` added — concrete already had it. */
  getStatus(invoiceId: string, manager?: EntityManager): Promise<string>;
  /** Return value never read at the one call site — kept as the real `Promise<string>` return (the resulting status), same `implements`-compatibility reasoning as `postEntry` above. Area 21: `manager?` added — concrete already had it. */
  recomputeStatus(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<string>;
  /** P4 Tranche-2 (returns domain) — narrowed from the real `Promise<SalesInvoice & {state, remaining, lines}>` to the 3 fields actually read. Area 21: `manager?` added — concrete `InvoiceService.getInvoice` gained it (§23.1). */
  getInvoice(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<{ state: string; customerId: string; salesOrderId: string }>;
}
export const FINANCE_INVOICE_CONTRACT = Symbol('FINANCE_INVOICE_CONTRACT');
