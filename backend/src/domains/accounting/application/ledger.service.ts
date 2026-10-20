import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { GLAccount } from '../infrastructure/gl-account.entity';

export interface LedgerQuery {
  orgUnitId?: string;
  from?: string;
  to?: string;
}

export interface LedgerLineRow {
  journalEntryId: string;
  entryNumber: string | null;
  businessDate: string;
  postingDate: string | null;
  description: string | null;
  sourceType: string;
  lineDescription: string | null;
  debitBase: string;
  creditBase: string;
  runningBalanceBase: string;
  /**
   * Slice C1 (ADR-INV-11) - ADDITIVE traceability fields (every existing field above keeps its meaning). `entryState` is `POSTED` or `REVERSED` (a line is only
   * ever on the ledger in one of those states); the event fields are NULL for entries that did not come from a financial event (manual / opening / reversal of a
   * manual entry). `referenceType` / `referenceId` are what the originating event carries (warehouse document, opening batch, goods receipt, ...).
   */
  entryState?: string | null;
  financialEventId?: string | null;
  eventType?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
}

export interface AccountLedger {
  account: { id: string; code: string; name: string; accountType: string; normalBalance: string };
  openingBalanceBase: string;
  periodDebitBase: string;
  periodCreditBase: string;
  closingBalanceBase: string;
  lines: LedgerLineRow[];
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
  debitBase: string;
  creditBase: string;
}

export interface TrialBalanceQuery {
  orgUnitId?: string;
  from?: string;
  to?: string;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  /** GROSS posted debit activity in the window (not the sum of the rows' net figures). */
  totalDebitBase: string;
  /** GROSS posted credit activity in the window. */
  totalCreditBase: string;
  balanced: boolean;
}

/**
 * CR-2026-10-15 — the Trial Balance screen payload. TWO DIFFERENT TOTALS, never interchangeable:
 *  - `totalDebitBase` / `totalCreditBase` (inherited, LOCKED CONTRACT): GROSS posted activity — Σ of every posted line's debit / credit.
 *    Signed into closing snapshots (`ClosingSnapshotService`) and asserted by the GL specs. Do not change their meaning.
 *  - `balanceTotalDebitBase` / `balanceTotalCreditBase`: Σ of the displayed rows — each account's NET balance on its debit or credit
 *    side. These are what the screen's footer shows. They equal the gross totals only when no account has both debit and credit lines.
 */
export interface TrialBalanceReport extends TrialBalance {
  /** Σ over accounts of GREATEST(net, 0) — the sum of the displayed debit column. */
  balanceTotalDebitBase: string;
  /** Σ over accounts of GREATEST(-net, 0) — the sum of the displayed credit column. */
  balanceTotalCreditBase: string;
}

/**
 * Slice C1 (ADR-INV-11) - the PERIODIC trial balance (`GET /accounting/trial-balance?mode=periodic`): per account the opening balance (everything strictly before
 * `from`), the period debit and credit, and the closing balance, with parent accounts rolled up from the chart. The default `getTrialBalance` /
 * `getTrialBalanceReport` payloads - including the locked gross totals the closing snapshot signs - are NOT changed by it.
 */
export interface PeriodicTrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  nameAr: string | null;
  accountType: string;
  normalBalance: string;
  parentAccountId: string | null;
  /** true for a non-postable (group) account: its figures are the roll-up of its descendants. */
  isGroup: boolean;
  /** signed net, debit positive: opening / closing */
  openingBase: string;
  closingBase: string;
  openingDebitBase: string;
  openingCreditBase: string;
  periodDebitBase: string;
  periodCreditBase: string;
  closingDebitBase: string;
  closingCreditBase: string;
}

export interface PeriodicTrialBalance {
  mode: 'periodic';
  from: string | null;
  to: string | null;
  rows: PeriodicTrialBalanceRow[];
  /** totals over POSTABLE accounts only (group rows are roll-ups and are never added in) */
  totals: {
    openingDebitBase: string;
    openingCreditBase: string;
    periodDebitBase: string;
    periodCreditBase: string;
    closingDebitBase: string;
    closingCreditBase: string;
  };
  /** each side balances on its own: opening debits = opening credits, period debits = period credits, closing debits = closing credits */
  balanced: { opening: boolean; period: boolean; closing: boolean };
  generatedAt: string;
}

/**
 * F03 — General Ledger read model (Blueprint §11, ADR-035 D9). **Every
 * figure is a PostgreSQL `NUMERIC` aggregation over POSTED
 * `accounting_journal_lines` rows** — no `GLAccount.balance` column, no
 * running-balance cache in V1. All arithmetic (sums, running balance,
 * trial-balance totals, the balanced check) is done SQL-side in `NUMERIC`
 * — JavaScript never adds or compares a ledger figure (ADR-035 D4). A
 * line counts only when its entry's Process Engine state is `POSTED`.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly dataSource: DataSource) {}

  // A line is on the ledger when its entry has been posted — state POSTED *or* REVERSED.
  // A REVERSED entry's lines are permanent historical fact; the reversing entry adds its own
  // offsetting POSTED lines, so the net is zero but BOTH sets remain visible on the account
  // (ADR-035 D3 — append-only). Only DRAFT / VALIDATED entries are excluded.
  /** C1: public (read-only string) so read-side analyses reuse the ONE definition of "a posted entry"; the alias of the entries table must be `e`. */
  readonly postedFilter = `EXISTS (
    SELECT 1 FROM process_instances pi
    WHERE pi."definitionKey" = 'accounting_journal_entry'
      AND pi."entityType" = 'JournalEntry'
      AND pi."entityId" = e.id::text
      AND pi."currentState" IN ('POSTED', 'REVERSED')
  )`;

  async getAccountLedger(accountId: string, query: LedgerQuery = {}, manager?: EntityManager): Promise<AccountLedger> {
    const account = await (manager ?? this.dataSource).getRepository(GLAccount).findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException(`GL account "${accountId}" not found.`);

    const scopeParams: unknown[] = [accountId];
    let scope = `l."accountId" = $1 AND ${this.postedFilter}`;
    if (query.orgUnitId) {
      scopeParams.push(query.orgUnitId);
      scope += ` AND (l."orgUnitId" = $${scopeParams.length} OR e."orgUnitId" = $${scopeParams.length})`;
    }

    // Opening balance: everything strictly before `from` (0 if no `from`), in SQL NUMERIC.
    let openingBalanceBase = '0.0000';
    if (query.from) {
      const p = [...scopeParams, query.from];
      const [row] = (await (manager ?? this.dataSource).query(
        `SELECT COALESCE(SUM(l."debitBase" - l."creditBase"), 0)::numeric(20,4) AS bal
         FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
         WHERE ${scope} AND e."businessDate" < $${p.length}`,
        p,
      )) as Array<{ bal: string }>;
      openingBalanceBase = row.bal;
    }

    const periodParams = [...scopeParams];
    let periodScope = scope;
    if (query.from) {
      periodParams.push(query.from);
      periodScope += ` AND e."businessDate" >= $${periodParams.length}`;
    }
    if (query.to) {
      periodParams.push(query.to);
      periodScope += ` AND e."businessDate" <= $${periodParams.length}`;
    }

    const [totals] = (await (manager ?? this.dataSource).query(
      `SELECT COALESCE(SUM(l."debitBase"),0)::numeric(20,4) AS d, COALESCE(SUM(l."creditBase"),0)::numeric(20,4) AS c
       FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
       WHERE ${periodScope}`,
      periodParams,
    )) as Array<{ d: string; c: string }>;

    const openParam = periodParams.length + 1;
    const lines = (await (manager ?? this.dataSource).query(
      `SELECT l."journalEntryId", e."entryNumber", e."businessDate", e."postingDate", e."description",
              e."sourceType", l."description" AS "lineDescription", l."debitBase", l."creditBase",
              ($${openParam}::numeric(20,4) + SUM(l."debitBase" - l."creditBase") OVER (
                 ORDER BY e."businessDate" ASC, e."entryNumber" ASC NULLS LAST, l."lineNumber" ASC
                 ROWS UNBOUNDED PRECEDING
              ))::numeric(20,4) AS "runningBalanceBase",
              (SELECT pi."currentState" FROM process_instances pi
                WHERE pi."definitionKey" = 'accounting_journal_entry' AND pi."entityType" = 'JournalEntry' AND pi."entityId" = e.id::text LIMIT 1) AS "entryState",
              fe.id AS "financialEventId", fe."eventType" AS "eventType",
              COALESCE(fe.payload->>'referenceType', CASE WHEN fe."eventType" = 'procurement.goods_receipt.posted' THEN 'goods_receipt' END) AS "referenceType",
              COALESCE(fe.payload->>'referenceId', fe.payload->>'goodsReceiptId') AS "referenceId"
       FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
       LEFT JOIN accounting_financial_events fe ON fe.id = e."financialEventId"
       WHERE ${periodScope}
       ORDER BY e."businessDate" ASC, e."entryNumber" ASC NULLS LAST, l."lineNumber" ASC`,
      [...periodParams, openingBalanceBase],
    )) as LedgerLineRow[];

    const [closing] = (await (manager ?? this.dataSource).query(
      `SELECT ($1::numeric(20,4) + $2::numeric(20,4) - $3::numeric(20,4))::numeric(20,4) AS bal`,
      [openingBalanceBase, totals.d, totals.c],
    )) as Array<{ bal: string }>;

    return {
      account: {
        id: account.id,
        code: account.code,
        name: account.name,
        accountType: account.accountType,
        normalBalance: account.normalBalance,
      },
      openingBalanceBase,
      periodDebitBase: totals.d,
      periodCreditBase: totals.c,
      closingBalanceBase: closing.bal,
      lines,
    };
  }

  /** Multi-Company Area 9 (2026-09-22) — `manager?` added so a company-scoped caller (`ClosingSnapshotService`) can run this against that Company's own connection instead of the ambient one. Falls back to the ambient `this.dataSource` when omitted, unchanged for every existing caller. */
  async getTrialBalance(query: TrialBalanceQuery = {}, manager?: EntityManager): Promise<TrialBalance> {
    const runner = manager ?? this.dataSource;
    const { where, params } = this.trialBalanceWhere(query);

    const rows = (await runner.query(
      `SELECT a.id AS "accountId", a.code, a.name, a."accountType", a."normalBalance",
              GREATEST(net, 0)::numeric(20,4)  AS "debitBase",
              GREATEST(-net, 0)::numeric(20,4) AS "creditBase"
       FROM (
         SELECT l."accountId",
                (COALESCE(SUM(l."debitBase"),0) - COALESCE(SUM(l."creditBase"),0))::numeric(20,4) AS net
         FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
         WHERE ${where}
         GROUP BY l."accountId"
         HAVING (COALESCE(SUM(l."debitBase"),0) - COALESCE(SUM(l."creditBase"),0)) <> 0
       ) agg
       JOIN accounting_gl_accounts a ON a.id = agg."accountId"
       ORDER BY a.code ASC`,
      params,
    )) as TrialBalanceRow[];

    const [tot] = (await runner.query(
      `SELECT COALESCE(SUM(l."debitBase"),0)::numeric(20,4) AS d,
              COALESCE(SUM(l."creditBase"),0)::numeric(20,4) AS c,
              (COALESCE(SUM(l."debitBase"),0) = COALESCE(SUM(l."creditBase"),0)) AS balanced
       FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
       WHERE ${where}`,
      params,
    )) as Array<{ d: string; c: string; balanced: boolean }>;

    return {
      rows,
      totalDebitBase: tot?.d ?? '0.0000',
      totalCreditBase: tot?.c ?? '0.0000',
      balanced: tot?.balanced ?? true,
    };
  }

  /**
   * CR-2026-10-15 — the Trial Balance SCREEN. The rows show each account's NET balance, but `totalDebitBase`/`totalCreditBase` are the
   * GROSS posted activity (a contract the closing snapshot signs and the GL specs assert), so they did not equal the column sums whenever
   * an account had both debit and credit lines. This adds `balanceTotalDebitBase`/`balanceTotalCreditBase` — the sums of exactly the
   * displayed row figures, computed SQL-side over the same per-account aggregate — and leaves every existing field unchanged.
   */
  async getTrialBalanceReport(query: TrialBalanceQuery = {}, manager?: EntityManager): Promise<TrialBalanceReport> {
    const runner = manager ?? this.dataSource;
    const tb = await this.getTrialBalance(query, manager);
    const { where, params } = this.trialBalanceWhere(query);
    const [bal] = (await runner.query(
      `SELECT COALESCE(SUM(GREATEST(net, 0)),0)::numeric(20,4)  AS d,
              COALESCE(SUM(GREATEST(-net, 0)),0)::numeric(20,4) AS c
       FROM (
         SELECT (COALESCE(SUM(l."debitBase"),0) - COALESCE(SUM(l."creditBase"),0))::numeric(20,4) AS net
         FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
         WHERE ${where}
         GROUP BY l."accountId"
       ) agg`,
      params,
    )) as Array<{ d: string; c: string }>;
    return { ...tb, balanceTotalDebitBase: bal?.d ?? '0.0000', balanceTotalCreditBase: bal?.c ?? '0.0000' };
  }

  async getPeriodicTrialBalance(query: TrialBalanceQuery = {}, manager?: EntityManager): Promise<PeriodicTrialBalance> {
    const runner = manager ?? this.dataSource;
    const params: unknown[] = [query.from ?? null, query.to ?? null];
    let org = '';
    if (query.orgUnitId) {
      params.push(query.orgUnitId);
      org = ` AND (l."orgUnitId" = $${params.length} OR e."orgUnitId" = $${params.length})`;
    }
    const baseCte = `base AS (
      SELECT l."accountId" AS account_id,
             COALESCE(SUM(CASE WHEN $1::date IS NOT NULL AND e."businessDate" < $1::date THEN l."debitBase" - l."creditBase" ELSE 0 END), 0) AS opening,
             COALESCE(SUM(CASE WHEN ($1::date IS NULL OR e."businessDate" >= $1::date) THEN l."debitBase" ELSE 0 END), 0) AS pdr,
             COALESCE(SUM(CASE WHEN ($1::date IS NULL OR e."businessDate" >= $1::date) THEN l."creditBase" ELSE 0 END), 0) AS pcr
        FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
       WHERE ${this.postedFilter} AND ($2::date IS NULL OR e."businessDate" <= $2::date)${org}
       GROUP BY l."accountId"
    )`;
    const rows = (await runner.query(
      `WITH RECURSIVE ${baseCte},
       tree AS (
         SELECT a.id AS leaf_id, a.id AS anc_id, 0 AS depth FROM accounting_gl_accounts a
         UNION ALL
         SELECT t.leaf_id, c."parentAccountId", t.depth + 1 FROM tree t JOIN accounting_gl_accounts c ON c.id = t.anc_id
          WHERE c."parentAccountId" IS NOT NULL AND t.depth < 20
       ),
       rolled AS (
         SELECT t.anc_id AS account_id, SUM(b.opening) AS opening, SUM(b.pdr) AS pdr, SUM(b.pcr) AS pcr
           FROM tree t JOIN base b ON b.account_id = t.leaf_id GROUP BY t.anc_id
       )
       SELECT a.id AS "accountId", a.code, a.name, a."nameAr", a."accountType", a."normalBalance", a."parentAccountId", NOT a."isPostable" AS "isGroup",
              r.opening::numeric(20,4) AS "openingBase", (r.opening + r.pdr - r.pcr)::numeric(20,4) AS "closingBase",
              GREATEST(r.opening, 0)::numeric(20,4) AS "openingDebitBase", GREATEST(-r.opening, 0)::numeric(20,4) AS "openingCreditBase",
              r.pdr::numeric(20,4) AS "periodDebitBase", r.pcr::numeric(20,4) AS "periodCreditBase",
              GREATEST(r.opening + r.pdr - r.pcr, 0)::numeric(20,4) AS "closingDebitBase", GREATEST(-(r.opening + r.pdr - r.pcr), 0)::numeric(20,4) AS "closingCreditBase"
         FROM rolled r JOIN accounting_gl_accounts a ON a.id = r.account_id
        WHERE r.opening <> 0 OR r.pdr <> 0 OR r.pcr <> 0
        ORDER BY a.code ASC`,
      params,
    )) as PeriodicTrialBalanceRow[];

    // totals over the accounts that carry lines (never over roll-ups), straight from the same base aggregate
    const [t] = (await runner.query(
      `WITH ${baseCte}
       SELECT COALESCE(SUM(GREATEST(opening, 0)), 0)::numeric(20,4) AS "openingDebitBase", COALESCE(SUM(GREATEST(-opening, 0)), 0)::numeric(20,4) AS "openingCreditBase",
              COALESCE(SUM(pdr), 0)::numeric(20,4) AS "periodDebitBase", COALESCE(SUM(pcr), 0)::numeric(20,4) AS "periodCreditBase",
              COALESCE(SUM(GREATEST(opening + pdr - pcr, 0)), 0)::numeric(20,4) AS "closingDebitBase", COALESCE(SUM(GREATEST(-(opening + pdr - pcr), 0)), 0)::numeric(20,4) AS "closingCreditBase",
              (COALESCE(SUM(opening), 0) = 0) AS "openingBalanced", (COALESCE(SUM(pdr), 0) = COALESCE(SUM(pcr), 0)) AS "periodBalanced",
              (COALESCE(SUM(opening + pdr - pcr), 0) = 0) AS "closingBalanced"
         FROM base`,
      params,
    )) as Array<PeriodicTrialBalance['totals'] & { openingBalanced: boolean; periodBalanced: boolean; closingBalanced: boolean }>;

    return {
      mode: 'periodic',
      from: query.from ?? null,
      to: query.to ?? null,
      rows,
      totals: {
        openingDebitBase: t.openingDebitBase,
        openingCreditBase: t.openingCreditBase,
        periodDebitBase: t.periodDebitBase,
        periodCreditBase: t.periodCreditBase,
        closingDebitBase: t.closingDebitBase,
        closingCreditBase: t.closingCreditBase,
      },
      balanced: { opening: t.openingBalanced, period: t.periodBalanced, closing: t.closingBalanced },
      generatedAt: new Date().toISOString(),
    };
  }

  private trialBalanceWhere(query: TrialBalanceQuery): { where: string; params: unknown[] } {
    const params: unknown[] = [];
    const conds: string[] = [this.postedFilter];
    if (query.orgUnitId) {
      params.push(query.orgUnitId);
      conds.push(`(l."orgUnitId" = $${params.length} OR e."orgUnitId" = $${params.length})`);
    }
    if (query.from) {
      params.push(query.from);
      conds.push(`e."businessDate" >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      conds.push(`e."businessDate" <= $${params.length}`);
    }
    return { where: conds.join(' AND '), params };
  }
}
