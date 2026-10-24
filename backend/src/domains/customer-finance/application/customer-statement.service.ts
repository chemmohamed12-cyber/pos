import { createHash } from 'crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, EntityNotFoundError } from 'typeorm';
import { SALES_CUSTOMERS_CONTRACT, SalesCustomersContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { utcDayEndExclusiveSql } from '../../../foundation/localization/business-date';
import {
  Bilingual,
  ENTRY_TYPE_NAMES,
  ageInvoices,
  closingBalance,
  describeEntry,
  periodTotals,
  runningBalances,
  statementReference,
  toCents,
  fromCents,
  AgingResult,
} from '../domain/customer-statement-rules';
import { CustomerLedgerService } from './customer-ledger.service';

export interface StatementFilters {
  /** Inclusive calendar day (UTC), `YYYY-MM-DD`. Empty = from the first entry. */
  from?: string;
  /** Inclusive calendar day (UTC): the WHOLE day is included. Empty = up to now. */
  to?: string;
  entryType?: string;
  /** `posted` | `reversed` — a view filter; the official statement is unfiltered. */
  status?: string;
}

export interface StatementRow {
  entryId: string;
  entryNumber: string;
  date: string;
  dueDate: string | null;
  entryType: string;
  typeLabel: Bilingual;
  description: Bilingual;
  documentType: string | null;
  documentNumber: string | null;
  documentLink: string | null;
  debit: string;
  credit: string;
  /** Ledger running balance after this row (opening balance + every earlier row of the period, filtered or not). */
  balance: string;
  status: 'posted' | 'reversed';
  isReversalLeg: boolean;
  /** True when the row is cancelled out by a correction: itself reversed, a reversal leg, or part of a payment that was reversed through its document. */
  nettedOut: boolean;
  flags: string[];
}

export interface CustomerStatement {
  reference: string;
  referenceNote: Bilingual;
  generatedAt: string;
  customer: { id: string; code: string; name: string; phone: string | null; address: string | null; governorate: string | null; taxRegistrationNumber: string | null; creditLimit: string | null; paymentTermsDays: number | null };
  period: { from: string | null; to: string | null };
  currency: { code: string; note: Bilingual };
  filters: { entryType: string | null; status: string | null };
  /** True only when no view filter (type/status) is applied — only then are the totals the full official figures. */
  isComplete: boolean;
  openingBalance: string;
  rows: StatementRow[];
  totals: { debit: string; credit: string };
  /** Same period totals but without reversed rows and reversal legs (what actually happened, net of corrections). */
  totalsExcludingReversals: { debit: string; credit: string };
  filteredTotals: { debit: string; credit: string } | null;
  closingBalance: string;
  reversedCount: number;
  reconciliation: { ledgerBalanceAtPeriodEnd: string; matches: boolean };
  warnings: Array<{ code: string; ar: string; en: string; entryNumbers: string[] }>;
}

interface RawEntry {
  id: string;
  entryNumber: string;
  entryType: string;
  direction: 'debit' | 'credit';
  amount: string;
  entryDate: Date;
  status: 'posted' | 'reversed';
  reason: string | null;
  reference: string | null;
  invoiceId: string | null;
  salesOrderId: string | null;
  paymentId: string | null;
  shipmentId: string | null;
  reversalOfEntryId: string | null;
  invoiceNumber: string | null;
  invoiceDueDate: Date | null;
  paymentNumber: string | null;
  orderNumber: string | null;
  waybillNumber: string | null;
  treasuryStatus: string | null;
  paymentReversed: boolean | null;
}

@Injectable()
export class CustomerStatementService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
    private readonly ledger: CustomerLedgerService,
  ) {}

  private em(manager?: EntityManager): EntityManager | DataSource {
    return manager ?? this.dataSource;
  }

  /** `YYYY-MM-DD` or null; anything else is a 400-class input error surfaced by the caller as an empty period (never interpolated into SQL). */
  private day(v?: string): string | null {
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  }

  /** The customer's own scope check, with a missing / out-of-scope / other-company customer reported as a plain 404 (never a 500). */
  private async assertCustomer(customerId: string, actorUserId: string, manager?: EntityManager) {
    try {
      return await this.customers.getCustomer(customerId, actorUserId, manager);
    } catch (e) {
      if (e instanceof EntityNotFoundError) throw new NotFoundException(`Customer "${customerId}" not found.`);
      throw e;
    }
  }

  async getStatement(customerId: string, actorUserId: string, filters: StatementFilters, manager?: EntityManager): Promise<CustomerStatement> {
    const customer = await this.assertCustomer(customerId, actorUserId, manager); // scope check — 404 outside the caller's reach
    const runner = this.em(manager);
    const from = this.day(filters.from);
    const to = this.day(filters.to);
    const generatedAt = new Date().toISOString();

    const profile = (await runner.query(
      `SELECT "phone", "address", "governorate", "taxRegistrationNumber", "creditLimit"::text AS "creditLimit", "paymentTermsDays" FROM "customers" WHERE "id" = $1`,
      [customerId],
    )) as Array<{ phone: string | null; address: string | null; governorate: string | null; taxRegistrationNumber: string | null; creditLimit: string | null; paymentTermsDays: number | null }>;
    const p = profile[0];

    // Opening balance = the ledger formula over EVERYTHING before the period start (all entry types, reversals included — same rule as getCustomerBalance).
    const opening = from
      ? ((await runner.query(
          `SELECT COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END), 0)::numeric(14,2)::text AS b
             FROM "customer_ledger_entries" WHERE "customerId" = $1 AND "entryDate" < (($2::date)::timestamp AT TIME ZONE 'UTC')`,
          [customerId, from],
        )) as Array<{ b: string }>)[0].b
      : '0.00';

    const params: unknown[] = [customerId];
    const where: string[] = [`e."customerId" = $1`];
    if (from) {
      params.push(from);
      where.push(`e."entryDate" >= (($${params.length}::date)::timestamp AT TIME ZONE 'UTC')`);
    }
    if (to) {
      params.push(to);
      where.push(`e."entryDate" < ${utcDayEndExclusiveSql(`$${params.length}`)}`);
    }
    const raw = (await runner.query(
      `SELECT e."id", e."entryNumber", e."entryType", e."direction", e."amount"::text AS "amount", e."entryDate", e."status", e."reason", e."reference",
              e."invoiceId", e."salesOrderId", e."paymentId", e."shipmentId", e."reversalOfEntryId",
              inv."invoiceNumber", inv."dueDate" AS "invoiceDueDate", p."paymentNumber", so."orderNumber", sh."waybillNumber", tt."status" AS "treasuryStatus",
              EXISTS (SELECT 1 FROM "customer_payment_reversals" r WHERE r."paymentId" = e."paymentId") AS "paymentReversed"
         FROM "customer_ledger_entries" e
         LEFT JOIN "sales_invoices" inv ON inv."id" = e."invoiceId"
         LEFT JOIN "customer_payments" p ON p."id" = e."paymentId"
         LEFT JOIN "sales_orders" so ON so."id" = e."salesOrderId"
         LEFT JOIN "shipments" sh ON sh."id" = e."shipmentId"
         LEFT JOIN "treasury_transactions" tt ON tt."id" = e."treasuryTransactionId"
        WHERE ${where.join(' AND ')}
        ORDER BY e."entryDate" ASC, e."createdAt" ASC, e."entryNumber" ASC`,
      params,
    )) as RawEntry[];

    const balances = runningBalances(opening, raw.map((r) => ({ direction: r.direction, amount: r.amount })));
    const all: StatementRow[] = raw.map((r, i) => {
      const doc = this.documentOf(r);
      const flags: string[] = [];
      // a payment whose Treasury movement was reversed while the document side (ledger/invoice/GL) was not: shown, never hidden (repair: POST /payments/:id/complete-reversal)
      if (r.paymentId && r.treasuryStatus === 'reversed' && !r.paymentReversed && r.entryType !== 'payment_reversal') flags.push('cash_reversed_not_in_ledger');
      return {
        entryId: r.id,
        entryNumber: r.entryNumber,
        date: new Date(r.entryDate).toISOString(),
        dueDate: r.entryType === 'sales_invoice' && r.invoiceDueDate ? new Date(r.invoiceDueDate).toISOString().slice(0, 10) : null,
        entryType: r.entryType,
        typeLabel: ENTRY_TYPE_NAMES[r.entryType] ?? { ar: 'غير محدد', en: r.entryType },
        description: describeEntry(r, { invoiceNumber: r.invoiceNumber, paymentNumber: r.paymentNumber, orderNumber: r.orderNumber, waybillNumber: r.waybillNumber }),
        documentType: doc.type,
        documentNumber: doc.number,
        documentLink: doc.link,
        debit: r.direction === 'debit' ? r.amount : '0.00',
        credit: r.direction === 'credit' ? r.amount : '0.00',
        balance: balances[i],
        status: r.status,
        isReversalLeg: !!r.reversalOfEntryId || r.entryType === 'payment_reversal',
        nettedOut: r.status === 'reversed' || !!r.reversalOfEntryId || r.entryType === 'payment_reversal' || (!!r.paymentId && !!r.paymentReversed),
        flags,
      };
    });

    const totals = periodTotals(raw.map((r) => ({ direction: r.direction, amount: r.amount })));
    const net = all.filter((r) => !r.nettedOut);
    const totalsExcludingReversals = periodTotals(net.map((r) => ({ direction: r.debit !== '0.00' ? ('debit' as const) : ('credit' as const), amount: r.debit !== '0.00' ? r.debit : r.credit })));
    const typeFilter = filters.entryType && ENTRY_TYPE_NAMES[filters.entryType] ? filters.entryType : null;
    const statusFilter = filters.status === 'posted' || filters.status === 'reversed' ? filters.status : null;
    const rows = all.filter((r) => (!typeFilter || r.entryType === typeFilter) && (!statusFilter || r.status === statusFilter));
    const isComplete = !typeFilter && !statusFilter;
    const filteredTotals = isComplete ? null : periodTotals(rows.map((r) => ({ direction: r.debit !== '0.00' ? ('debit' as const) : ('credit' as const), amount: r.debit !== '0.00' ? r.debit : r.credit })));
    const closing = closingBalance(opening, totals);

    // independent cross-check: the engine's own balance as of the period end
    const endBalance = (await runner.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END), 0)::numeric(14,2)::text AS b
         FROM "customer_ledger_entries" WHERE "customerId" = $1 ${to ? `AND "entryDate" < ${utcDayEndExclusiveSql('$2')}` : ''}`,
      to ? [customerId, to] : [customerId],
    )) as Array<{ b: string }>;

    const warnings: CustomerStatement['warnings'] = [];
    const flagged = all.filter((r) => r.flags.includes('cash_reversed_not_in_ledger'));
    if (flagged.length) {
      warnings.push({
        code: 'cash_reversed_not_in_ledger',
        ar: 'حركة الخزينة لهذه الدفعة معكوسة بينما حساب العميل لم يُعكس — يلزم إكمال العكس عبر مستند الدفعة.',
        en: 'The Treasury movement of this payment was reversed but the customer ledger was not — complete the reversal through the payment document.',
        entryNumbers: flagged.map((r) => r.entryNumber),
      });
    }

    const digest = createHash('sha256')
      .update(JSON.stringify({ customerId, from, to, opening, closing, rows: all.map((r) => [r.entryNumber, r.debit, r.credit, r.balance, r.status]) }))
      .digest('hex');

    return {
      reference: statementReference(customer.code, from, to, generatedAt, digest),
      referenceNote: {
        ar: 'مرجع مُولَّد لهذه النسخة من الكشف، وليس رقم مستند صادر من سجل إصدارات محفوظ.',
        en: 'A reference generated for this copy of the statement — not a number from a stored register of issued documents.',
      },
      generatedAt,
      customer: {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        phone: p?.phone ?? null,
        address: p?.address ?? null,
        governorate: p?.governorate ?? null,
        taxRegistrationNumber: p?.taxRegistrationNumber ?? null,
        creditLimit: p?.creditLimit ?? null,
        paymentTermsDays: p?.paymentTermsDays ?? customer.paymentTermsDays ?? null,
      },
      period: { from, to },
      currency: {
        code: 'EGP',
        note: { ar: 'عملة الشركة الأساسية — لا يُجمع بين عملات مختلفة في هذا الكشف.', en: 'Company base currency — no mixed currencies are summed in this statement.' },
      },
      filters: { entryType: typeFilter, status: statusFilter },
      isComplete,
      openingBalance: opening,
      rows,
      totals,
      totalsExcludingReversals,
      filteredTotals,
      closingBalance: closing,
      reversedCount: all.filter((r) => r.status === 'reversed').length,
      reconciliation: { ledgerBalanceAtPeriodEnd: endBalance[0].b, matches: endBalance[0].b === closing },
      warnings,
    };
  }

  private documentOf(r: RawEntry): { type: string | null; number: string | null; link: string | null } {
    if (r.entryType === 'sales_invoice' && r.invoiceNumber) return { type: 'sales_invoice', number: r.invoiceNumber, link: `/invoices/${r.invoiceId}` };
    if (r.paymentNumber) return { type: 'payment', number: r.paymentNumber, link: r.invoiceId ? `/invoices/${r.invoiceId}` : '/payments' };
    if (r.invoiceNumber) return { type: 'sales_invoice', number: r.invoiceNumber, link: `/invoices/${r.invoiceId}` };
    if (r.waybillNumber) return { type: 'shipment', number: r.waybillNumber, link: '/shipments' };
    if (r.orderNumber) return { type: 'sales_order', number: r.orderNumber, link: `/sales-orders/${r.salesOrderId}` };
    if (r.reference) return { type: 'reference', number: r.reference, link: null };
    return { type: null, number: null, link: null };
  }

  /** The side panel: one entry with its source documents, the Treasury movement, the reversal chain and the creator. */
  async getEntryDetails(entryId: string, actorUserId: string, manager?: EntityManager) {
    const runner = this.em(manager);
    const found = (await runner.query(`SELECT "customerId" FROM "customer_ledger_entries" WHERE "id" = $1`, [entryId])) as Array<{ customerId: string }>;
    if (found.length === 0) throw new NotFoundException(`Ledger entry "${entryId}" not found.`);
    await this.assertCustomer(found[0].customerId, actorUserId, manager); // scope
    const r = (await runner.query(
      `SELECT e.*, e."amount"::text AS "amountText", inv."invoiceNumber", inv."dueDate" AS "invoiceDueDate", p."paymentNumber", so."orderNumber", sh."waybillNumber",
              tt."transactionNumber" AS "treasuryNumber", tt."status" AS "treasuryStatus", u."fullName" AS "createdByName",
              EXISTS (SELECT 1 FROM "customer_payment_reversals" pr WHERE pr."paymentId" = e."paymentId") AS "paymentReversed"
         FROM "customer_ledger_entries" e
         LEFT JOIN "sales_invoices" inv ON inv."id" = e."invoiceId"
         LEFT JOIN "customer_payments" p ON p."id" = e."paymentId"
         LEFT JOIN "sales_orders" so ON so."id" = e."salesOrderId"
         LEFT JOIN "shipments" sh ON sh."id" = e."shipmentId"
         LEFT JOIN "treasury_transactions" tt ON tt."id" = e."treasuryTransactionId"
         LEFT JOIN "users" u ON u."id" = e."createdByUserId"
        WHERE e."id" = $1`,
      [entryId],
    )) as Array<RawEntry & { amountText: string; treasuryNumber: string | null; createdByName: string | null; createdAt: Date; createdByUserId: string; treasuryTransactionId: string | null }>;
    const e = r[0];
    const chain = (await runner.query(
      `SELECT "id", "entryNumber", "entryType", "direction", "amount"::text AS "amount", "status", "entryDate", "reason"
         FROM "customer_ledger_entries" WHERE "reversalOfEntryId" = $1 OR "id" = $2 OR ($3::uuid IS NOT NULL AND "paymentId" = $3::uuid AND "entryType" = 'payment_reversal' AND "id" <> $1)
        ORDER BY "entryDate", "createdAt"`,
      [entryId, e.reversalOfEntryId, e.paymentId],
    )) as Array<{ id: string; entryNumber: string; entryType: string; direction: string; amount: string; status: string; entryDate: Date; reason: string | null }>;
    const doc = this.documentOf(e);
    return {
      entryId: e.id,
      entryNumber: e.entryNumber,
      date: new Date(e.entryDate).toISOString(),
      entryType: e.entryType,
      typeLabel: ENTRY_TYPE_NAMES[e.entryType] ?? { ar: 'غير محدد', en: e.entryType },
      description: describeEntry(e, { invoiceNumber: e.invoiceNumber, paymentNumber: e.paymentNumber, orderNumber: e.orderNumber, waybillNumber: e.waybillNumber }),
      direction: e.direction,
      amount: e.amountText,
      status: e.status,
      recordedReason: e.reason,
      document: doc,
      invoice: e.invoiceNumber ? { number: e.invoiceNumber, id: e.invoiceId, dueDate: e.invoiceDueDate ? new Date(e.invoiceDueDate).toISOString().slice(0, 10) : null, link: `/invoices/${e.invoiceId}` } : null,
      payment: e.paymentNumber ? { number: e.paymentNumber, id: e.paymentId, reversed: !!e.paymentReversed } : null,
      treasury: e.treasuryNumber ? { number: e.treasuryNumber, status: e.treasuryStatus } : null,
      createdBy: e.createdByName ?? null,
      createdAt: new Date(e.createdAt).toISOString(),
      technicalId: e.id,
      flags: e.paymentId && e.treasuryStatus === 'reversed' && !e.paymentReversed && e.entryType !== 'payment_reversal' ? ['cash_reversed_not_in_ledger'] : [],
      related: chain.map((c) => ({ id: c.id, entryNumber: c.entryNumber, entryType: c.entryType, typeLabel: ENTRY_TYPE_NAMES[c.entryType] ?? { ar: 'غير محدد', en: c.entryType }, direction: c.direction, amount: c.amount, status: c.status, date: new Date(c.entryDate).toISOString() })),
    };
  }

  /**
   * The dashboard figures, each with ONE definition (see `definitions`). Everything derives from the Customer Ledger and the invoices' remaining balance —
   * nothing is stored. Set-based (no per-invoice round trips).
   */
  async getAccountSummary(customerId: string, actorUserId: string, opts: { asOf?: string; from?: string; to?: string }, manager?: EntityManager) {
    await this.assertCustomer(customerId, actorUserId, manager);
    const runner = this.em(manager);
    const asOf = this.day(opts.asOf) ?? new Date().toISOString().slice(0, 10);
    const from = this.day(opts.from);
    const to = this.day(opts.to) ?? asOf;

    const balance = await this.ledger.getCustomerBalance(customerId, manager);
    const creditLimit = (await runner.query(`SELECT "creditLimit"::text AS v FROM "customers" WHERE "id" = $1`, [customerId])) as Array<{ v: string | null }>;
    const limit = creditLimit[0]?.v ?? null;

    const open = (await runner.query(
      `SELECT inv."id", inv."invoiceNumber", ((inv."dueDate" AT TIME ZONE 'UTC')::date)::text AS "dueDate",
              ((inv."totalAmount" + inv."taxAmount") - COALESCE(app.total, 0))::numeric(14,2)::text AS "remaining"
         FROM "sales_invoices" inv
         JOIN "process_instances" pi ON pi."entityId"::text = inv."id"::text AND pi."definitionKey" = 'sales_invoice_lifecycle' AND pi."entityType" = 'sales_invoice'
         LEFT JOIN (
           SELECT "invoiceId", SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END) AS total
             FROM "customer_ledger_entries" WHERE "invoiceId" IS NOT NULL AND "entryType" <> 'sales_invoice' GROUP BY "invoiceId"
         ) app ON app."invoiceId" = inv."id"
        WHERE inv."customerId" = $1 AND pi."currentState" NOT IN ('void', 'draft')
          AND ((inv."totalAmount" + inv."taxAmount") - COALESCE(app.total, 0)) > 0`,
      [customerId],
    )) as Array<{ id: string; invoiceNumber: string; dueDate: string | null; remaining: string }>;
    const aging: AgingResult = ageInvoices(open, asOf);

    // invoices whose applied credits exceed their value (customer paid / was credited more than the invoice): shown, never netted away
    const over = (await runner.query(
      `SELECT count(*)::int AS n, COALESCE(SUM(-(((inv."totalAmount" + inv."taxAmount") - COALESCE(app.total, 0)))), 0)::numeric(14,2)::text AS amount
         FROM "sales_invoices" inv
         JOIN "process_instances" pi ON pi."entityId"::text = inv."id"::text AND pi."definitionKey" = 'sales_invoice_lifecycle' AND pi."entityType" = 'sales_invoice'
         LEFT JOIN (
           SELECT "invoiceId", SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END) AS total
             FROM "customer_ledger_entries" WHERE "invoiceId" IS NOT NULL AND "entryType" <> 'sales_invoice' GROUP BY "invoiceId"
         ) app ON app."invoiceId" = inv."id"
        WHERE inv."customerId" = $1 AND pi."currentState" NOT IN ('void', 'draft') AND ((inv."totalAmount" + inv."taxAmount") - COALESCE(app.total, 0)) < 0`,
      [customerId],
    )) as Array<{ n: number; amount: string }>;

    const unapplied = (await runner.query(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE -"amount" END), 0)::numeric(14,2)::text AS v
         FROM "customer_ledger_entries" WHERE "customerId" = $1 AND "invoiceId" IS NULL`,
      [customerId],
    )) as Array<{ v: string }>;
    const unappliedCredit = toCents(unapplied[0].v) > 0 ? unapplied[0].v : '0.00';

    const pParams: unknown[] = [customerId, to];
    let pWhere = `"customerId" = $1 AND "entryDate" < ${utcDayEndExclusiveSql('$2')}`;
    if (from) {
      pParams.push(from);
      pWhere += ` AND "entryDate" >= (($3::date)::timestamp AT TIME ZONE 'UTC')`;
    }
    const sums = (await runner.query(
      `SELECT
         COALESCE(SUM(CASE WHEN "entryType" IN ('sales_invoice','debit_note') AND "direction" = 'debit' AND "reversalOfEntryId" IS NULL AND "status" = 'posted' THEN "amount" END), 0)::numeric(14,2)::text AS invoiced,
         COALESCE(SUM(CASE WHEN "entryType" IN ('payment','deposit','cod_collection') AND "direction" = 'credit' AND "reversalOfEntryId" IS NULL THEN "amount"
                           WHEN "entryType" = 'payment_reversal' AND "direction" = 'debit' THEN -"amount" END), 0)::numeric(14,2)::text AS collected,
         COALESCE(SUM(CASE WHEN "entryType" = 'return_credit_note' AND "direction" = 'credit' AND "reason" IN ('Sales return credit','Shipment return credit') THEN "amount" END), 0)::numeric(14,2)::text AS returns
       FROM "customer_ledger_entries" WHERE ${pWhere}`,
      pParams,
    )) as Array<{ invoiced: string; collected: string; returns: string }>;

    const last = (await runner.query(
      `SELECT
         (SELECT "entryDate" FROM "customer_ledger_entries" WHERE "customerId" = $1 AND "entryType" = 'sales_invoice' AND "reversalOfEntryId" IS NULL ORDER BY "entryDate" DESC LIMIT 1) AS "lastInvoice",
         (SELECT "entryDate" FROM "customer_ledger_entries" WHERE "customerId" = $1 AND "entryType" IN ('payment','deposit','cod_collection') AND "direction" = 'credit' ORDER BY "entryDate" DESC LIMIT 1) AS "lastPayment"`,
      [customerId],
    )) as Array<{ lastInvoice: Date | null; lastPayment: Date | null }>;
    const upcoming = open.map((o) => o.dueDate).filter((d): d is string => !!d && d >= asOf).sort();

    const availableCredit = limit !== null ? fromCents(toCents(limit) - toCents(balance)) : null;
    const overdueNet = toCents(aging.overdue) - toCents(unappliedCredit);
    return {
      asOf,
      period: { from, to },
      currency: 'EGP',
      balance,
      creditLimit: limit,
      availableCredit,
      openInvoices: open.length,
      totalOpen: aging.totalOpen,
      overdue: aging.overdue,
      overdueNetOfUnappliedCredit: fromCents(Math.max(0, overdueNet)),
      notYetDue: aging.notYetDue,
      unappliedCredit,
      customerCreditBalance: toCents(balance) < 0 ? fromCents(-toCents(balance)) : '0.00',
      overApplied: { invoices: over[0].n, amount: over[0].amount },
      aging: aging.bands,
      invoicedInPeriod: sums[0].invoiced,
      collectedInPeriod: sums[0].collected,
      returnsInPeriod: sums[0].returns,
      lastInvoiceDate: last[0].lastInvoice ? new Date(last[0].lastInvoice).toISOString() : null,
      lastPaymentDate: last[0].lastPayment ? new Date(last[0].lastPayment).toISOString() : null,
      nextDueDate: upcoming[0] ?? null,
      alerts: {
        overCreditLimit: limit !== null && toCents(balance) > toCents(limit),
        hasOverdue: toCents(aging.overdue) > 0,
        hasOverApplied: over[0].n > 0,
      },
      definitions: DEFINITIONS,
    };
  }
}

const DEFINITIONS: Record<string, Bilingual> = {
  balance: {
    ar: 'الرصيد الحالي = مجموع المدين − مجموع الدائن في دفتر العميل بكل الحركات (الموجب: العميل مدين لنا، السالب: رصيد دائن للعميل).',
    en: 'Current balance = Σ debit − Σ credit over the customer ledger (positive: the customer owes us; negative: the customer is in credit).',
  },
  invoicedInPeriod: { ar: 'المفوتَر في الفترة = مدين الفواتير وإشعارات المدين المرحّلة، دون قيود العكس.', en: 'Invoiced in period = posted invoice and debit-note debits, excluding reversal rows.' },
  collectedInPeriod: { ar: 'المحصَّل في الفترة = دائن الدفعات والعرابين والتحصيل عند التسليم، ناقص الدفعات المعكوسة. لا يشمل تسوية الدفعة على فاتورة (لا تغيّر الرصيد).', en: 'Collected in period = payment, deposit and COD credits minus reversed payments. Payment applications are excluded (they do not change the balance).' },
  returnsInPeriod: { ar: 'المرتجعات = دائن إشعارات المرتجع (مبيعات/شحن) دون تطبيق الرصيد على فاتورة.', en: 'Returns = sales/shipment return credits, excluding the later application of that credit to an invoice.' },
  overdue: { ar: 'المتأخر = المتبقي على الفواتير التي تجاوز استحقاقها تاريخ الكشف (اليوم الأول للتأخير هو اليوم التالي للاستحقاق).', en: 'Overdue = remaining on invoices past their due date at the as-of date (the first overdue day is the day after the due date).' },
  overdueNetOfUnappliedCredit: { ar: 'المتأخر بعد خصم الرصيد الدائن غير المطبّق للعميل (يُعرض منفصلًا ولا يُخفي المتأخر الإجمالي).', en: 'Overdue after the customer’s unapplied credit (shown separately; the gross overdue is never hidden).' },
  availableCredit: { ar: 'المتاح من الائتمان = حد الائتمان − الرصيد الحالي، ويظهر فقط عند تحديد حد ائتمان.', en: 'Available credit = credit limit − current balance; shown only when a limit is set.' },
  customerCreditBalance: { ar: 'رصيد دائن للعميل = قيمة الرصيد الحالي عندما يكون سالبًا (العميل دائن لدينا)، سواء كان مطبّقًا على فواتير أم لا.', en: 'Customer credit balance = the current balance when negative (we owe the customer), whether or not it is applied to invoices.' },
  overApplied: { ar: 'فواتير مطبّق عليها أكثر من قيمتها (دفعات/عرابين تتجاوز الفاتورة) — تُعرض ولا تُخفى.', en: 'Invoices with more applied than their value (payments/deposits exceeding the invoice) — shown, never hidden.' },
  unappliedCredit: { ar: 'الرصيد الدائن غير المطبّق = دائن غير مرتبط بفاتورة (عربون/دفعة على الحساب) ناقص ما طُبّق منه.', en: 'Unapplied credit = credits not linked to an invoice (deposit / on-account payment) minus what was applied.' },
  aging: { ar: 'الأعمار: 0–30، 31–60، 61–90، 90+ يومًا من تاريخ الاستحقاق؛ يوم الاستحقاق نفسه = 0 يوم تأخير.', en: 'Aging: 0–30, 31–60, 61–90, 90+ days past the due date; the due day itself is 0 days late.' },
};
