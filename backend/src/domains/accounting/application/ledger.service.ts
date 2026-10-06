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

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebitBase: string;
  totalCreditBase: string;
  balanced: boolean;
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
  private readonly postedFilter = `EXISTS (
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
              ))::numeric(20,4) AS "runningBalanceBase"
       FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
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
  async getTrialBalance(query: { orgUnitId?: string; from?: string; to?: string } = {}, manager?: EntityManager): Promise<TrialBalance> {
    const runner = manager ?? this.dataSource;
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
    const where = conds.join(' AND ');

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
}
