import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

export type PostingExceptionCause = 'UNMAPPED_ACCOUNT' | 'NO_EVENT' | 'REJECTED' | 'NOT_POSTED_YET';

export interface TreasuryPostingException {
  transactionId: string;
  transactionNumber: string;
  type: string;
  amount: string;
  movementDate: string;
  accountCode: string;
  glAccountCode: string | null;
  category: 'direct_cash' | 'transfer' | 'customer_payment' | 'supplier_payment' | 'deposit';
  expectedEventKey: string;
  eventId: string | null;
  eventStatus: string | null;
  cause: PostingExceptionCause;
  reason: string | null;
  ageDays: number;
}

export interface TreasuryPostingExceptionsResult {
  total: number;
  totalAmount: string;
  byCause: Record<string, { count: number; amount: string }>;
  rows: TreasuryPostingException[];
  /** Legs that by design have no bank-GL event at leg time (payroll disbursement, COD custody). Reported, never counted as exceptions. */
  deferredByPolicy: { payrollLegs: number; codCustodyLegs: number };
}

/**
 * Treasury integrity T1 (G-03 recovery) — a READ-ONLY, derived view of every Treasury movement whose expected Financial Event is missing, rejected or not yet
 * posted. It is the same logic as the investigation SQL (Q1), so what an operator sees here is what the data check measured. No schema, no writes: the
 * remedy for a REJECTED/RECEIVED event is the existing, idempotent `POST general-ledger/financial-events/:id/redrive` after the cause is fixed.
 *
 * Expected event keys mirror the idempotency keys the publishers use (see the investigation SQL header). Transfers count once per group (out leg).
 */
@Injectable()
export class TreasuryPostingExceptionsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(opts: { limit?: number } = {}, manager?: EntityManager): Promise<TreasuryPostingExceptionsResult> {
    const runner = manager ?? this.dataSource;
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    // The offsetting leg of a payment reversed through its owning document is covered by that document's `...:reversed` event (not by a per-leg event); those tables exist only
    // where the Finance / Procurement tags were migrated, so the joins are added only when present.
    const present: Array<{ cr: boolean; sr: boolean }> = await runner.query(`SELECT to_regclass('customer_payment_reversals') IS NOT NULL AS cr, to_regclass('supplier_payment_reversals') IS NOT NULL AS sr`);
    const hasCr = !!present[0]?.cr;
    const hasSr = !!present[0]?.sr;
    const sql = `
      WITH legs AS (
        SELECT t.id, t."transactionNumber", t.type, t.amount, t."movementDate", t."treasuryAccountId",
          CASE WHEN t."depositId" IS NOT NULL THEN 'deposit'
               WHEN cp.id IS NOT NULL OR ${hasCr ? 'cr.id IS NOT NULL' : 'false'} THEN 'customer_payment'
               WHEN sp.id IS NOT NULL OR ${hasSr ? 'sr.id IS NOT NULL' : 'false'} THEN 'supplier_payment'
               WHEN t."employeeId" IS NOT NULL OR t."payrollRunId" IS NOT NULL THEN 'payroll'
               WHEN t.reason = 'cod_collection_custody' THEN 'cod_custody'
               WHEN t."transferGroupId" IS NOT NULL THEN 'transfer'
               ELSE 'direct_cash' END AS category,
          CASE WHEN t."depositId" IS NOT NULL THEN 'deposit:' || t."depositId" || ':verified'
               WHEN cp.id IS NOT NULL THEN 'customer-finance:payment:' || cp.id || ':recorded'
               ${hasCr ? `WHEN cr.id IS NOT NULL THEN 'customer-finance:payment:' || cr."paymentId" || ':reversed'` : ''}
               WHEN sp.id IS NOT NULL THEN 'procurement:supplier_payment:' || sp.id || ':recorded'
               ${hasSr ? `WHEN sr.id IS NOT NULL THEN 'procurement:supplier_payment:' || sr."supplierPaymentId" || ':reversed'` : ''}
               WHEN t."employeeId" IS NOT NULL OR t."payrollRunId" IS NOT NULL OR t.reason = 'cod_collection_custody' THEN NULL
               WHEN t."transferGroupId" IS NOT NULL THEN 'treasury:transfer:' || t."transferGroupId" || ':completed'
               ELSE 'treasury:txn:' || t.id || ':recorded' END AS expected_key
        FROM treasury_transactions t
        LEFT JOIN customer_payments cp ON cp."treasuryTransactionId" = t.id
        LEFT JOIN supplier_payments sp ON sp."treasuryTransactionId" = t.id
        ${hasCr ? 'LEFT JOIN customer_payment_reversals cr ON cr."treasuryReversalTransactionId" = t.id' : ''}
        ${hasSr ? 'LEFT JOIN supplier_payment_reversals sr ON sr."treasuryReversalTransactionId" = t.id' : ''}
        WHERE t.type <> 'transfer_in'
      )
      SELECT l.id AS "transactionId", l."transactionNumber", l.type, l.amount::text AS amount, to_char(l."movementDate", 'YYYY-MM-DD') AS "movementDate",
             a.code AS "accountCode", a."glAccountCode", l.category, l.expected_key AS "expectedEventKey",
             e.id AS "eventId", e.status AS "eventStatus", e."rejectionReason" AS "rejectionReason",
             GREATEST(0, (current_date - l."movementDate"::date))::int AS "ageDays"
      FROM legs l
      JOIN treasury_accounts a ON a.id = l."treasuryAccountId"
      LEFT JOIN accounting_financial_events e ON e."idempotencyKey" = l.expected_key
      WHERE l.expected_key IS NOT NULL AND COALESCE(e.status, 'NO_EVENT') NOT IN ('POSTED', 'IGNORED')
      ORDER BY l."movementDate" ASC`;
    const all: Array<Record<string, string | number | null>> = await runner.query(sql);
    const rows: TreasuryPostingException[] = all.map((r) => {
      const status = (r.eventStatus as string | null) ?? null;
      const cause: PostingExceptionCause = status === 'REJECTED' ? 'REJECTED' : status ? 'NOT_POSTED_YET' : r.glAccountCode ? 'NO_EVENT' : 'UNMAPPED_ACCOUNT';
      return {
        transactionId: r.transactionId as string,
        transactionNumber: r.transactionNumber as string,
        type: r.type as string,
        amount: r.amount as string,
        movementDate: r.movementDate as string,
        accountCode: r.accountCode as string,
        glAccountCode: (r.glAccountCode as string | null) ?? null,
        category: r.category as TreasuryPostingException['category'],
        expectedEventKey: r.expectedEventKey as string,
        eventId: (r.eventId as string | null) ?? null,
        eventStatus: status,
        cause,
        reason: (r.rejectionReason as string | null) ?? null,
        ageDays: Number(r.ageDays),
      };
    });
    const byCause: Record<string, { count: number; amount: string }> = {};
    let total = 0;
    for (const r of rows) {
      const c = (byCause[r.cause] ??= { count: 0, amount: '0.00' });
      c.count += 1;
      c.amount = (Number(c.amount) + Number(r.amount)).toFixed(2);
      total += Number(r.amount);
    }
    const deferred: Array<{ payroll: string; cod: string }> = await runner.query(
      `SELECT count(*) FILTER (WHERE "employeeId" IS NOT NULL OR "payrollRunId" IS NOT NULL)::text AS payroll,
              count(*) FILTER (WHERE reason = 'cod_collection_custody')::text AS cod FROM treasury_transactions`,
    );
    return {
      total: rows.length,
      totalAmount: total.toFixed(2),
      byCause,
      rows: rows.slice(0, limit),
      deferredByPolicy: { payrollLegs: Number(deferred[0]?.payroll ?? 0), codCustodyLegs: Number(deferred[0]?.cod ?? 0) },
    };
  }
}
