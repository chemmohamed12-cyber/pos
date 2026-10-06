import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { TaxPeriod } from '../infrastructure/tax-period.entity';

export interface ReportQuery {
  orgUnitId?: string;
}

export interface SectionAccountRow {
  accountId: string;
  code: string;
  name: string;
  nameAr: string | null;
  accountType: string;
  normalBalance: string;
  balance: string;
}

export interface BalanceSheet {
  asOfDate: string;
  assets: SectionAccountRow[];
  assetsTotal: string;
  liabilities: SectionAccountRow[];
  liabilitiesTotal: string;
  equity: SectionAccountRow[];
  equityStoredTotal: string;
  unclosedNetIncome: string;
  equityTotal: string;
  balanced: boolean;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  revenue: SectionAccountRow[];
  revenueTotal: string;
  expenses: SectionAccountRow[];
  expensesTotal: string;
  netIncome: string;
}

export interface CashFlowStatement {
  from: string;
  to: string;
  beginningCash: string;
  endingCash: string;
  netChangeActual: string;
  operating: {
    periodNetIncome: string;
    depreciationAddBack: string;
    arDelta: string;
    apDelta: string;
    inventoryDelta: string;
    total: string;
  };
  investing: {
    acquisitionsCashOutflow: string;
    disposalsCashInflow: string;
    total: string;
    note: string;
  };
  financing: {
    total: string;
    note: string;
  };
  unclassifiedOther: string;
}

export interface TaxPeriodSummary {
  taxPeriod: { id: string; code: string; startDate: string; endDate: string; jurisdictionCode: string | null };
  taxPayableMovement: string;
  taxReceivableMovement: string;
}

/**
 * F14 — Financial Reporting (ADR-047). A pure read model, exactly like
 * `LedgerService`: every figure is a PostgreSQL `NUMERIC` aggregation over
 * `POSTED`/`REVERSED` `accounting_journal_lines` (never `JavaScript` sums
 * or compares a ledger figure — ADR-035 D4's own discipline, extended
 * here). F14 never writes to the GL, never creates a Journal Entry, never
 * changes a Process Engine state, never touches AR/AP/Treasury/Inventory —
 * running a report has zero side effect (ADR-047 Architecture Rule):
 *
 *   POSTED GL -> Existing Ledger / SQL Aggregation -> Financial Statement -> Account Drill-down
 *
 * never `GL -> New Reporting Ledger -> Statement`. This service builds no
 * new ledger of its own; `LedgerService.getAccountLedger` remains the ONE
 * drill-down source (ADR-047 D2) — this file only adds new aggregations
 * over the SAME `accounting_journal_lines`/`accounting_gl_accounts` tables
 * `LedgerService` already reads, duplicating its `postedFilter` fragment
 * locally rather than modifying F03's own `ledger.service.ts` (no F01-F13
 * file is touched by F14).
 */
@Injectable()
export class FinancialReportingService {
  constructor(private readonly dataSource: DataSource) {}

  // Identical in shape and intent to `LedgerService`'s own private `postedFilter` (F03) — duplicated,
  // not imported, so F14 never modifies or depends on F03's internals (ADR-047 Architecture Rule).
  private readonly postedFilter = `EXISTS (
    SELECT 1 FROM process_instances pi
    WHERE pi."definitionKey" = 'accounting_journal_entry'
      AND pi."entityType" = 'JournalEntry'
      AND pi."entityId" = e.id::text
      AND pi."currentState" IN ('POSTED', 'REVERSED')
  )`;

  /**
   * ADR-047 D1/D3 — per-account balances, normalized to each account's own `normalBalance` direction
   * (so a liability/equity/revenue account with a "normal" credit balance shows as a positive number,
   * exactly like `debitBase`/`creditBase` already do for `LedgerService.getTrialBalance`, just
   * pre-netted). `from` is OPTIONAL and, when omitted, the aggregation is unbounded from inception —
   * this is the exact mechanism D3's `UnclosedNetIncome` formula and every Balance Sheet section rely
   * on (never "current fiscal year only"). `beforeExclusive` computes an opening-style balance
   * (`businessDate < date`), matching `LedgerService.getAccountLedger`'s own opening-balance
   * convention; `toInclusive` computes an as-of/closing-style balance (`businessDate <= date`).
   */
  private async accountSection(
    accountTypes: string[] | null,
    controlFunctions: string[] | null,
    opts: { orgUnitId?: string; from?: string; toInclusive?: string; beforeExclusive?: string },
    manager?: EntityManager,
  ): Promise<{ rows: SectionAccountRow[]; total: string }> {
    const params: unknown[] = [];
    const conds: string[] = [this.postedFilter];
    if (opts.orgUnitId) {
      params.push(opts.orgUnitId);
      conds.push(`(l."orgUnitId" = $${params.length} OR e."orgUnitId" = $${params.length})`);
    }
    if (opts.from) {
      params.push(opts.from);
      conds.push(`e."businessDate" >= $${params.length}`);
    }
    if (opts.toInclusive) {
      params.push(opts.toInclusive);
      conds.push(`e."businessDate" <= $${params.length}`);
    }
    if (opts.beforeExclusive) {
      params.push(opts.beforeExclusive);
      conds.push(`e."businessDate" < $${params.length}`);
    }
    const where = conds.join(' AND ');

    const acctConds: string[] = [];
    if (accountTypes) {
      params.push(accountTypes);
      acctConds.push(`a."accountType" = ANY($${params.length})`);
    }
    if (controlFunctions) {
      params.push(controlFunctions);
      acctConds.push(`a."controlFunction" = ANY($${params.length})`);
    }
    const acctWhere = acctConds.length ? `WHERE ${acctConds.join(' AND ')}` : '';

    const rows = (await (manager ?? this.dataSource).query(
      `SELECT a.id AS "accountId", a.code, a.name, a."nameAr", a."accountType", a."normalBalance",
              (CASE WHEN a."normalBalance" = 'debit' THEN net ELSE -net END)::numeric(20,4) AS balance,
              COALESCE(SUM(CASE WHEN a."normalBalance" = 'debit' THEN net ELSE -net END) OVER (), 0)::numeric(20,4) AS "sectionTotal"
       FROM (
         SELECT l."accountId",
                (COALESCE(SUM(l."debitBase"),0) - COALESCE(SUM(l."creditBase"),0))::numeric(20,4) AS net
         FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
         WHERE ${where}
         GROUP BY l."accountId"
         HAVING (COALESCE(SUM(l."debitBase"),0) - COALESCE(SUM(l."creditBase"),0)) <> 0
       ) agg
       JOIN accounting_gl_accounts a ON a.id = agg."accountId"
       ${acctWhere}
       ORDER BY a.code ASC`,
      params,
    )) as Array<SectionAccountRow & { sectionTotal: string }>;

    const total = rows.length > 0 ? rows[0].sectionTotal : '0.0000';
    return { rows: rows.map(({ sectionTotal: _drop, ...r }) => r), total };
  }

  /**
   * ADR-047 D1/D3. Equity = stored `accountType='equity'` balances (including whatever
   * `retained_earnings` control-function balance the GL happens to hold today — read generically,
   * never assumed zero) PLUS `unclosedNetIncome` = SUM(revenue) - SUM(expense), UNBOUNDED from
   * inception through `asOfDate`. This is the exact identity that already makes `getTrialBalance`
   * balance for every prior phase (every journal entry's debits equal its credits), so it is
   * self-correcting even if a real closing entry is posted by a future phase: such an entry would
   * itself zero the revenue/expense accounts it closes, so the unbounded SUM here automatically
   * excludes whatever has already been closed into the stored `retained_earnings` balance this
   * formula already reads. `retained_earnings` is never written to by this service.
   */
  async getBalanceSheet(query: { orgUnitId?: string; asOfDate: string }, manager?: EntityManager): Promise<BalanceSheet> {
    const { orgUnitId, asOfDate } = query;
    const assets = await this.accountSection(['asset'], null, { orgUnitId, toInclusive: asOfDate }, manager);
    const liabilities = await this.accountSection(['liability'], null, { orgUnitId, toInclusive: asOfDate }, manager);
    const equity = await this.accountSection(['equity'], null, { orgUnitId, toInclusive: asOfDate }, manager);
    const revenue = await this.accountSection(['revenue'], null, { orgUnitId, toInclusive: asOfDate }, manager);
    const expenses = await this.accountSection(['expense'], null, { orgUnitId, toInclusive: asOfDate }, manager);

    const [uni] = (await (manager ?? this.dataSource).query(`SELECT ($1::numeric - $2::numeric)::numeric(20,4) AS v`, [
      revenue.total,
      expenses.total,
    ])) as Array<{ v: string }>;
    const unclosedNetIncome = uni.v;

    const [eq] = (await (manager ?? this.dataSource).query(`SELECT ($1::numeric + $2::numeric)::numeric(20,4) AS v`, [
      equity.total,
      unclosedNetIncome,
    ])) as Array<{ v: string }>;
    const equityTotal = eq.v;

    const [bal] = (await (manager ?? this.dataSource).query(
      `SELECT ($1::numeric = ($2::numeric + $3::numeric)) AS balanced`,
      [assets.total, liabilities.total, equityTotal],
    )) as Array<{ balanced: boolean }>;

    return {
      asOfDate,
      assets: assets.rows,
      assetsTotal: assets.total,
      liabilities: liabilities.rows,
      liabilitiesTotal: liabilities.total,
      equity: equity.rows,
      equityStoredTotal: equity.total,
      unclosedNetIncome,
      equityTotal,
      balanced: bal.balanced,
    };
  }

  /** ADR-047 D1. Ordinary, date-range-bounded P&L — NOT the same as the Balance Sheet's unbounded
   * `unclosedNetIncome` (D3), though both reuse the same `accountSection` primitive. */
  async getProfitAndLoss(query: { orgUnitId?: string; from: string; to: string }, manager?: EntityManager): Promise<ProfitAndLoss> {
    const { orgUnitId, from, to } = query;
    const revenue = await this.accountSection(['revenue'], null, { orgUnitId, from, toInclusive: to }, manager);
    const expenses = await this.accountSection(['expense'], null, { orgUnitId, from, toInclusive: to }, manager);
    const [ni] = (await (manager ?? this.dataSource).query(`SELECT ($1::numeric - $2::numeric)::numeric(20,4) AS v`, [
      revenue.total,
      expenses.total,
    ])) as Array<{ v: string }>;
    return {
      from,
      to,
      revenue: revenue.rows,
      revenueTotal: revenue.total,
      expenses: expenses.rows,
      expensesTotal: expenses.total,
      netIncome: ni.v,
    };
  }

  private async controlFunctionDelta(controlFunction: string, opts: { orgUnitId?: string; from: string; to: string }, manager?: EntityManager): Promise<string> {
    const opening = (await this.accountSection(null, [controlFunction], { orgUnitId: opts.orgUnitId, beforeExclusive: opts.from }, manager)).total;
    const closing = (await this.accountSection(null, [controlFunction], { orgUnitId: opts.orgUnitId, toInclusive: opts.to }, manager)).total;
    const [row] = (await (manager ?? this.dataSource).query(`SELECT ($1::numeric - $2::numeric)::numeric(20,4) AS v`, [closing, opening])) as Array<{
      v: string;
    }>;
    return row.v;
  }

  /**
   * ADR-047 D5 addendum — trusted as "genuinely posted" WITHOUT an extra `journalEntryId IS NOT NULL`
   * filter. Proven, not assumed: `handleFixedAssetDepreciationCalculated` (F12) inserts a
   * `DepreciationRunLine` row via the SAME transaction `runHandlerThroughPosting` (F08/F12) uses for
   * `createEntry`+`postEntry`, has no rejection path AFTER that insert, and the whole span rolls back
   * completely (including the insert) on any downstream posting failure. A row can exist in
   * `accounting_depreciation_run_lines` only if its journal entry genuinely posted — filtering on
   * `journalEntryId` would in fact be UNSAFE, since that FK is backfilled by a separate, non-atomic
   * `UPDATE` after `ingest()` returns (`depreciation.service.ts`), so a rare crash in that window could
   * leave a genuinely-posted row with a still-`NULL` `journalEntryId`.
   */
  private async getDepreciationAddBack(from: string, to: string, manager?: EntityManager): Promise<string> {
    const fromYm = from.slice(0, 7);
    const toYm = to.slice(0, 7);
    const [row] = (await (manager ?? this.dataSource).query(
      `SELECT COALESCE(SUM("calculatedAmount"),0)::numeric(20,4) AS total FROM accounting_depreciation_run_lines
       WHERE "depreciationPeriod" >= $1 AND "depreciationPeriod" <= $2`,
      [fromYm, toYm],
    )) as Array<{ total: string }>;
    return row.total;
  }

  /**
   * ADR-047 D5 — Investing = fixed-asset cash flows ONLY (the only investing-shaped activity this
   * codebase models). Acquisition cash outflow requires `acquisitionJournalEntryId IS NOT NULL` — F12's
   * own D7 5-point validation already guarantees that link is only ever set once the entry is POSTED
   * (see `FixedAssetService`), so no separate posted-check is needed here. Disposal cash inflow
   * requires `journalEntryId IS NOT NULL` — UNLIKE acquisition, a `FixedAssetDisposal` row exists from
   * the moment it is SUBMITTED (before FA-01 approval), so its mere existence does NOT prove posting;
   * the `journalEntryId` backfill (set only on a successful post) is the correct and necessary filter
   * here. Either way, only the `proceeds`/acquisition-funding leg that specifically hit a
   * `controlFunction = 'bank'` account counts as a real cash movement — e.g. a disposal settled via AR
   * correctly contributes zero.
   */
  private async getInvestingActivity(opts: {
    orgUnitId?: string;
    from: string;
    to: string;
  }, manager?: EntityManager): Promise<{ acquisitionsCashOutflow: string; disposalsCashInflow: string; total: string }> {
    const acqParams: unknown[] = [opts.from, opts.to];
    let acqOrgCond = '';
    if (opts.orgUnitId) {
      acqParams.push(opts.orgUnitId);
      acqOrgCond = `AND fa."orgUnitId" = $${acqParams.length}`;
    }
    const [acqRow] = (await (manager ?? this.dataSource).query(
      `SELECT COALESCE(SUM(jl."creditBase"),0)::numeric(20,4) AS total
       FROM accounting_fixed_assets fa
       JOIN accounting_journal_lines jl ON jl."journalEntryId" = fa."acquisitionJournalEntryId"
       JOIN accounting_gl_accounts a ON a.id = jl."accountId"
       WHERE fa."acquisitionJournalEntryId" IS NOT NULL
         AND fa."acquisitionDate" >= $1 AND fa."acquisitionDate" <= $2
         AND a."controlFunction" = 'bank'
         ${acqOrgCond}`,
      acqParams,
    )) as Array<{ total: string }>;

    const dispParams: unknown[] = [opts.from, opts.to];
    let dispOrgCond = '';
    if (opts.orgUnitId) {
      dispParams.push(opts.orgUnitId);
      dispOrgCond = `AND fa."orgUnitId" = $${dispParams.length}`;
    }
    const [dispRow] = (await (manager ?? this.dataSource).query(
      `SELECT COALESCE(SUM(d.proceeds),0)::numeric(20,4) AS total
       FROM accounting_fixed_asset_disposals d
       JOIN accounting_fixed_assets fa ON fa.id = d."fixedAssetId"
       JOIN accounting_gl_accounts a ON a.id = d."proceedsAccountId"
       WHERE d."journalEntryId" IS NOT NULL
         AND d."proceedsAccountId" IS NOT NULL
         AND a."controlFunction" = 'bank'
         AND d."disposalDate" >= $1 AND d."disposalDate" <= $2
         ${dispOrgCond}`,
      dispParams,
    )) as Array<{ total: string }>;

    const [totalRow] = (await (manager ?? this.dataSource).query(`SELECT ($1::numeric - $2::numeric)::numeric(20,4) AS v`, [
      dispRow.total,
      acqRow.total,
    ])) as Array<{ v: string }>;

    return { acquisitionsCashOutflow: acqRow.total, disposalsCashInflow: dispRow.total, total: totalRow.v };
  }

  /**
   * ADR-047 D5 — indirect method. Beginning/Ending Cash from `controlFunction='bank'` balances
   * (same `accountSection` primitive as every other section). Operating = period P&L net income +
   * depreciation add-back (D5 addendum) + AR/AP/Inventory working-capital deltas. Investing =
   * fixed-asset cash flows only. Financing = confirmed genuinely unmodeled anywhere in this codebase
   * (no loan/dividend/capital-contribution concept exists) — shown as zero with an explicit note, never
   * invented. `unclassifiedOther` reconciles Operating+Investing+Financing against the INDEPENDENTLY
   * computed Ending-Beginning change — any variance surfaces honestly rather than being silently
   * absorbed into any one section.
   */
  async getCashFlowStatement(query: { orgUnitId?: string; from: string; to: string }, manager?: EntityManager): Promise<CashFlowStatement> {
    const { orgUnitId, from, to } = query;

    const beginningCash = (await this.accountSection(null, ['bank'], { orgUnitId, beforeExclusive: from }, manager)).total;
    const endingCash = (await this.accountSection(null, ['bank'], { orgUnitId, toInclusive: to }, manager)).total;
    const [netChangeRow] = (await (manager ?? this.dataSource).query(`SELECT ($1::numeric - $2::numeric)::numeric(20,4) AS v`, [
      endingCash,
      beginningCash,
    ])) as Array<{ v: string }>;
    const netChangeActual = netChangeRow.v;

    const pnl = await this.getProfitAndLoss({ orgUnitId, from, to }, manager);
    const periodNetIncome = pnl.netIncome;
    const depreciationAddBack = await this.getDepreciationAddBack(from, to, manager);
    const arDelta = await this.controlFunctionDelta('ar', { orgUnitId, from, to }, manager);
    const apDelta = await this.controlFunctionDelta('ap', { orgUnitId, from, to }, manager);
    const inventoryDelta = await this.controlFunctionDelta('inventory', { orgUnitId, from, to }, manager);

    // Indirect method: net income + depreciation add-back − increase in AR − increase in Inventory + increase in AP.
    const [operatingRow] = (await (manager ?? this.dataSource).query(
      `SELECT ($1::numeric + $2::numeric - $3::numeric - $4::numeric + $5::numeric)::numeric(20,4) AS v`,
      [periodNetIncome, depreciationAddBack, arDelta, inventoryDelta, apDelta],
    )) as Array<{ v: string }>;
    const operatingTotal = operatingRow.v;

    const investing = await this.getInvestingActivity({ orgUnitId, from, to }, manager);
    const financingTotal = '0.0000';

    const [explainedRow] = (await (manager ?? this.dataSource).query(
      `SELECT ($1::numeric + $2::numeric + $3::numeric)::numeric(20,4) AS v`,
      [operatingTotal, investing.total, financingTotal],
    )) as Array<{ v: string }>;
    const [unclassifiedRow] = (await (manager ?? this.dataSource).query(`SELECT ($1::numeric - $2::numeric)::numeric(20,4) AS v`, [
      netChangeActual,
      explainedRow.v,
    ])) as Array<{ v: string }>;

    return {
      from,
      to,
      beginningCash,
      endingCash,
      netChangeActual,
      operating: { periodNetIncome, depreciationAddBack, arDelta, apDelta, inventoryDelta, total: operatingTotal },
      investing: {
        acquisitionsCashOutflow: investing.acquisitionsCashOutflow,
        disposalsCashInflow: investing.disposalsCashInflow,
        total: investing.total,
        note: 'Investing activity covers fixed-asset acquisitions/disposals only — no other investing-transaction type is modeled in this system version.',
      },
      financing: { total: financingTotal, note: 'No financing transactions are modeled in this system version.' },
      unclassifiedOther: unclassifiedRow.v,
    };
  }

  /** ADR-047 D4 — a small, separately-approvable report consuming F10's `accounting_tax_periods`. */
  async getTaxPeriodSummary(taxPeriodId: string, manager?: EntityManager): Promise<TaxPeriodSummary> {
    const taxPeriod = await (manager ?? this.dataSource).getRepository(TaxPeriod).findOne({ where: { id: taxPeriodId } });
    if (!taxPeriod) throw new NotFoundException(`Tax period "${taxPeriodId}" not found.`);

    const taxPayableMovement = (
      await this.accountSection(null, ['tax_payable'], { from: taxPeriod.startDate, toInclusive: taxPeriod.endDate }, manager)
    ).total;
    const taxReceivableMovement = (
      await this.accountSection(null, ['tax_receivable'], { from: taxPeriod.startDate, toInclusive: taxPeriod.endDate }, manager)
    ).total;

    return {
      taxPeriod: {
        id: taxPeriod.id,
        code: taxPeriod.code,
        startDate: taxPeriod.startDate,
        endDate: taxPeriod.endDate,
        jurisdictionCode: taxPeriod.jurisdictionCode,
      },
      taxPayableMovement,
      taxReceivableMovement,
    };
  }
}
