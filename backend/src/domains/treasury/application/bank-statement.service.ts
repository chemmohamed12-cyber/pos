import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { BankStatement, BankStatementLine, BankStatementMatch } from '../infrastructure/bank-statement.entities';
import { TreasuryTransaction } from '../infrastructure/treasury-transaction.entity';
import { TreasuryService } from './treasury.service';
import {
  MATCH_DATE_WINDOW_DAYS,
  MatchCandidate,
  StatementLineInput,
  cents,
  lineFingerprint,
  reconciliationDifference,
  statementFileHash,
  suggestFor,
} from '../domain/bank-statement';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { runInTransaction } from '../../../foundation/transaction/run-in-transaction';

const STATEMENT_DOC_TYPE = 'bank_statement';
const STATEMENT_PREFIX = 'BST';
const MAX_LINES = 5000;
const SIGNED = /^-?\d+(\.\d{1,2})?$/;
const signedAmount = (t: Pick<TreasuryTransaction, 'type' | 'amount'>): string => (t.type === 'cash_in' || t.type === 'transfer_in' ? t.amount : `-${t.amount}`);

export interface ImportStatementInput {
  treasuryAccountId: string;
  statementNumber?: string | null;
  sourceName?: string | null;
  periodStart: string;
  periodEnd: string;
  openingBalance: string;
  closingBalance: string;
  lines: StatementLineInput[];
}

export interface ReconciliationView {
  statementId: string;
  systemNumber: string;
  status: string;
  closingBalance: string;
  bookBalanceAtPeriodEnd: string;
  outstandingBookNet: string;
  bankOnlyNet: string;
  adjustedBank: string;
  adjustedBook: string;
  difference: string;
  reconciled: boolean;
  unmatchedLines: Array<{ id: string; lineNumber: number; valueDate: string; amount: string; description: string | null; reference: string | null; possibleDuplicate: boolean; ageDays: number }>;
  outstandingBookItems: Array<{ transactionId: string; transactionNumber: string; movementDate: string; signedAmount: string; reference: string | null; ageDays: number }>;
}

/**
 * T5 (2026-10-21) — bank statements and reconciliation, kept SEPARATE from approval and execution: a Treasury movement is "executed" and "posted" long before a bank
 * statement shows it, and it is only "settled" when a person confirms a match. Nothing here posts a journal; bank fees / interest found on a statement are recorded through
 * ordinary Treasury Documents (posting-profile receipt / disbursement) and then matched.
 *
 * Import: validated (dates, amounts, opening + Σ lines = closing), refused if the same file was imported or the period overlaps another statement of the account.
 * Matching: the matcher only SUGGESTS; confirm checks account, status, one-active-match-per-movement (DB-enforced) and that the amounts add up to the cent.
 * Reconcile: all lines must be matched and the two adjusted balances must be equal to the cent — otherwise the exact difference is reported and nothing closes.
 * Dates are compared as UTC calendar days (the same rule as the business-date fix) so the 00:00-03:00 Cairo window cannot move a movement to the next day.
 * Opening position: movements dated before the account's FIRST imported statement are treated as already inside that statement's opening balance (the bank had cleared them);
 * from the first statement on, every unmatched movement is an outstanding item until the bank shows it.
 */
@Injectable()
export class BankStatementService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly treasury: TreasuryService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  // ---------------------------------------------------------------- queries
  async list(filter: { treasuryAccountId?: string; status?: string } = {}, manager?: EntityManager): Promise<BankStatement[]> {
    const where: Record<string, unknown> = {};
    if (filter.treasuryAccountId) where.treasuryAccountId = filter.treasuryAccountId;
    if (filter.status) where.status = filter.status;
    return this.em(manager).getRepository(BankStatement).find({ where, order: { periodEnd: 'DESC', importedAt: 'DESC' }, take: 200 });
  }

  async get(id: string, manager?: EntityManager): Promise<BankStatement & { lines: Array<BankStatementLine & { matches: BankStatementMatch[] }> }> {
    const em = this.em(manager);
    const statement = await em.getRepository(BankStatement).findOne({ where: { id } });
    if (!statement) throw new NotFoundException(`Bank statement "${id}" not found.`);
    const lines = await em.getRepository(BankStatementLine).find({ where: { statementId: id }, order: { lineNumber: 'ASC' } });
    const matches = lines.length ? await em.query(`SELECT * FROM bank_statement_matches WHERE "lineId" = ANY($1::uuid[]) AND "unmatchedAt" IS NULL`, [lines.map((l) => l.id)]) : [];
    return Object.assign(statement, { lines: lines.map((l) => Object.assign(l, { matches: (matches as BankStatementMatch[]).filter((m) => m.lineId === l.id) })) });
  }

  // ---------------------------------------------------------------- import
  async importStatement(input: ImportStatementInput, actorUserId: string, manager?: EntityManager): Promise<BankStatement> {
    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (!date.test(input.periodStart) || !date.test(input.periodEnd) || input.periodStart > input.periodEnd) throw new BadRequestException('The statement period must be two valid dates, start not after end.');
    if (!SIGNED.test(input.openingBalance) || !SIGNED.test(input.closingBalance)) throw new BadRequestException('Opening and closing balances must be amounts with at most two decimals.');
    const lines = input.lines ?? [];
    if (lines.length === 0) throw new BadRequestException('A statement needs at least one line.');
    if (lines.length > MAX_LINES) throw new BadRequestException(`A statement is limited to ${MAX_LINES} lines per import.`);
    lines.forEach((l, i) => {
      if (!date.test(l.valueDate ?? '')) throw new BadRequestException(`Line ${i + 1}: the value date must be YYYY-MM-DD.`);
      if (l.valueDate < input.periodStart || l.valueDate > input.periodEnd) throw new BadRequestException(`Line ${i + 1}: the value date ${l.valueDate} is outside the statement period.`);
      if (!SIGNED.test(l.amount ?? '') || cents(l.amount) === 0) throw new BadRequestException(`Line ${i + 1}: the amount must be a non-zero amount with at most two decimals (positive = into the account).`);
    });
    const total = lines.reduce((s, l) => s + cents(l.amount), 0);
    if (cents(input.openingBalance) + total !== cents(input.closingBalance)) {
      throw new BadRequestException(`The statement does not add up: opening ${input.openingBalance} + lines ${(total / 100).toFixed(2)} = ${((cents(input.openingBalance) + total) / 100).toFixed(2)}, but the closing balance is ${input.closingBalance}. Nothing was imported.`);
    }
    const account = await this.treasury.getAccount(input.treasuryAccountId, manager);
    if (account.status !== 'active') throw new ConflictException(`Treasury account "${account.code}" is inactive.`);
    if (!account.glAccountCode?.trim()) throw new ConflictException(`Treasury account "${account.code}" is not GL-mapped — map it before reconciling it.`);

    const fileHash = statementFileHash(input.treasuryAccountId, input.periodStart, input.periodEnd, input.openingBalance, input.closingBalance, lines);
    const run = async (m: EntityManager) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bank_statement:${input.treasuryAccountId}`]);
      const dup = await m.getRepository(BankStatement).findOne({ where: { treasuryAccountId: input.treasuryAccountId, fileHash } });
      if (dup) throw new ConflictException(`This statement was already imported as ${dup.systemNumber} on ${dup.importedAt.toISOString().slice(0, 10)}. Nothing was imported.`);
      // Chronological, contiguous statements only: a new statement must start after every existing one ends (no overlap, no back-filling), and must continue from the
      // previous closing balance — otherwise the reconciliation arithmetic below would silently double count.
      const later = await m.query(`SELECT "systemNumber" FROM bank_statements WHERE "treasuryAccountId" = $1 AND "periodEnd" >= $2::date ORDER BY "periodEnd" DESC LIMIT 1`, [input.treasuryAccountId, input.periodStart]);
      if (later.length > 0) throw new ConflictException(`The period overlaps or precedes statement ${later[0].systemNumber} of this account — statements must be imported in chronological order. Nothing was imported.`);
      const previous = await m.query(`SELECT "systemNumber", "closingBalance"::text AS closing FROM bank_statements WHERE "treasuryAccountId" = $1 ORDER BY "periodEnd" DESC LIMIT 1`, [input.treasuryAccountId]);
      if (previous.length > 0 && cents(previous[0].closing) !== cents(input.openingBalance)) {
        throw new ConflictException(`The opening balance ${input.openingBalance} does not continue from the closing balance ${previous[0].closing} of ${previous[0].systemNumber}. Nothing was imported.`);
      }

      await this.numbering.registerDocumentType(STATEMENT_DOC_TYPE, STATEMENT_PREFIX, true, m);
      const systemNumber = await this.numbering.getNextNumber(STATEMENT_DOC_TYPE, m);
      const repo = m.getRepository(BankStatement);
      const statement = await repo.save(
        repo.create({
          systemNumber, statementNumber: input.statementNumber ?? null, treasuryAccountId: input.treasuryAccountId, periodStart: input.periodStart, periodEnd: input.periodEnd,
          openingBalance: Number(input.openingBalance).toFixed(2), closingBalance: Number(input.closingBalance).toFixed(2), fileHash, sourceName: input.sourceName ?? null,
          status: 'imported', lineCount: lines.length, importedByUserId: actorUserId, version: 1,
        }),
      );
      const fps = lines.map((l) => lineFingerprint(input.treasuryAccountId, l));
      const existing: Array<{ fingerprint: string }> = await m.query(
        `SELECT DISTINCT l.fingerprint FROM bank_statement_lines l JOIN bank_statements s ON s.id = l."statementId" WHERE s."treasuryAccountId" = $1 AND l.fingerprint = ANY($2::text[])`,
        [input.treasuryAccountId, fps],
      );
      const seen = new Set(existing.map((e) => e.fingerprint));
      const lineRepo = m.getRepository(BankStatementLine);
      let n = 0;
      for (const l of lines) {
        n += 1;
        await lineRepo.save(
          lineRepo.create({
            statementId: statement.id, lineNumber: n, valueDate: l.valueDate, description: l.description ?? null, reference: l.reference ?? null, amount: Number(l.amount).toFixed(2),
            fingerprint: fps[n - 1], possibleDuplicate: seen.has(fps[n - 1]), status: 'unmatched', suggestion: null, version: 1,
          }),
        );
      }
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.bank_statement.imported', resource: 'bank_statement', resourceId: statement.id, result: 'success', correlationId: null, after: { systemNumber, lines: lines.length, closing: statement.closingBalance } }, m);
      return statement;
    };
    return runInTransaction(this.dataSource, manager, run);
  }

  // ---------------------------------------------------------------- suggest
  /** Ranks candidates for every line that is not yet matched. Writes ONLY suggestions — never a match. */
  async suggest(statementId: string, actorUserId: string, manager?: EntityManager): Promise<{ suggested: number; ambiguous: number; unmatched: number }> {
    const run = async (m: EntityManager) => {
      const statement = await this.lockStatement(statementId, m);
      if (statement.status === 'reconciled') throw new ConflictException('A reconciled statement cannot be re-matched — reopen it first.');
      const lines = await m.getRepository(BankStatementLine).find({ where: { statementId }, order: { lineNumber: 'ASC' } });
      const pool = await this.candidatePool(statement, m);
      const counts = { suggested: 0, ambiguous: 0, unmatched: 0 };
      const taken = new Set<string>();
      for (const line of lines) {
        if (line.status === 'matched') continue;
        const s = suggestFor({ valueDate: line.valueDate, description: line.description, reference: line.reference, amount: line.amount }, pool.filter((c) => !taken.has(c.transactionId)));
        line.suggestion = s.outcome === 'unmatched' ? null : { outcome: s.outcome, candidates: s.candidates.map((c) => ({ transactionId: c.transactionId, transactionNumber: c.transactionNumber, score: c.score, reasons: c.reasons })) };
        line.status = s.outcome === 'unmatched' ? 'unmatched' : 'suggested';
        if (s.outcome === 'suggested') s.candidates.slice(0, 1).forEach((c) => taken.add(c.transactionId));
        counts[s.outcome] += 1;
        await m.getRepository(BankStatementLine).save(line);
      }
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.bank_statement.suggested', resource: 'bank_statement', resourceId: statementId, result: 'success', correlationId: null, after: counts }, m);
      return counts;
    };
    return runInTransaction(this.dataSource, manager, run);
  }

  private async candidatePool(statement: BankStatement, m: EntityManager): Promise<MatchCandidate[]> {
    const rows: Array<{ id: string; transactionNumber: string; type: string; amount: string; movementDate: Date; reference: string | null }> = await m.query(
      `SELECT t.id, t."transactionNumber", t.type, t.amount, t."movementDate", t.reference
         FROM treasury_transactions t
        WHERE t."treasuryAccountId" = $1 AND t.status = 'posted'
          AND (t."movementDate" AT TIME ZONE 'UTC')::date <= ($2::date + $3::int)
          AND NOT EXISTS (SELECT 1 FROM bank_statement_matches x WHERE x."treasuryTransactionId" = t.id AND x."unmatchedAt" IS NULL)`,
      [statement.treasuryAccountId, statement.periodEnd, MATCH_DATE_WINDOW_DAYS],
    );
    return rows.map((r) => ({ transactionId: r.id, transactionNumber: r.transactionNumber, movementDate: (r.movementDate instanceof Date ? r.movementDate.toISOString() : String(r.movementDate)).slice(0, 10), signedAmount: signedAmount({ type: r.type as never, amount: r.amount }), reference: r.reference }));
  }

  // ---------------------------------------------------------------- confirm / unmatch
  async confirm(lineId: string, transactionIds: string[], actorUserId: string, manager?: EntityManager): Promise<BankStatementLine> {
    const ids = [...new Set(transactionIds ?? [])];
    if (ids.length === 0) throw new BadRequestException('Choose at least one Treasury movement to match.');
    const run = async (m: EntityManager) => {
      const line = await m.getRepository(BankStatementLine).findOne({ where: { id: lineId }, lock: { mode: 'pessimistic_write' } });
      if (!line) throw new NotFoundException(`Statement line "${lineId}" not found.`);
      const statement = await this.lockStatement(line.statementId, m);
      if (statement.status === 'reconciled') throw new ConflictException('This statement is reconciled — reopen it before changing a match.');
      if (line.status === 'matched') throw new ConflictException('This line is already matched. Unmatch it first (with a reason) to change it.');
      const txns = await m.getRepository(TreasuryTransaction).find({ where: ids.map((id) => ({ id })) });
      if (txns.length !== ids.length) throw new NotFoundException('One of the selected Treasury movements does not exist.');
      for (const t of txns) {
        if (t.treasuryAccountId !== statement.treasuryAccountId) throw new ConflictException(`Movement ${t.transactionNumber} belongs to another Treasury account.`);
        if (t.status !== 'posted') throw new ConflictException(`Movement ${t.transactionNumber} is "${t.status}" — only a posted movement can be matched.`);
      }
      const sum = txns.reduce((s, t) => s + cents(signedAmount(t)), 0);
      if (sum !== cents(line.amount)) throw new ConflictException(`The selected movements add up to ${(sum / 100).toFixed(2)}, but the bank line is ${line.amount}. Nothing was matched.`);
      const suggestedIds = new Set((line.suggestion?.candidates ?? []).map((c) => c.transactionId));
      const method = ids.every((id) => suggestedIds.has(id)) ? 'suggestion_confirmed' : 'manual';
      const repo = m.getRepository(BankStatementMatch);
      try {
        for (const t of txns) await repo.save(repo.create({ lineId, treasuryTransactionId: t.id, method, matchedByUserId: actorUserId, unmatchedAt: null, unmatchedByUserId: null, unmatchReason: null }));
      } catch (err) {
        if (/UQ_bank_statement_matches_active_txn|duplicate key/i.test(err instanceof Error ? err.message : String(err))) throw new ConflictException('One of the selected movements is already matched to another bank line.');
        throw err;
      }
      line.status = 'matched';
      line.version += 1;
      await m.getRepository(BankStatementLine).save(line);
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.bank_statement.matched', resource: 'bank_statement_line', resourceId: lineId, result: 'success', correlationId: statement.id, after: { transactions: ids, method } }, m);
      return line;
    };
    return runInTransaction(this.dataSource, manager, run);
  }

  async unmatch(lineId: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<BankStatementLine> {
    const why = (reason ?? '').trim();
    if (why.length < 3) throw new BadRequestException('A reason is required to undo a match.');
    const run = async (m: EntityManager) => {
      const line = await m.getRepository(BankStatementLine).findOne({ where: { id: lineId }, lock: { mode: 'pessimistic_write' } });
      if (!line) throw new NotFoundException(`Statement line "${lineId}" not found.`);
      const statement = await this.lockStatement(line.statementId, m);
      if (statement.status === 'reconciled') throw new ConflictException('This statement is reconciled — reopen it (with a reason) before undoing a match.');
      if (line.status !== 'matched') throw new ConflictException('This line has no confirmed match.');
      await m.query(`UPDATE bank_statement_matches SET "unmatchedAt" = now(), "unmatchedByUserId" = $2, "unmatchReason" = $3 WHERE "lineId" = $1 AND "unmatchedAt" IS NULL`, [lineId, actorUserId, why]);
      line.status = 'unmatched';
      line.suggestion = null;
      line.version += 1;
      await m.getRepository(BankStatementLine).save(line);
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.bank_statement.unmatched', resource: 'bank_statement_line', resourceId: lineId, result: 'success', correlationId: statement.id, after: { reason: why } }, m);
      return line;
    };
    return runInTransaction(this.dataSource, manager, run);
  }

  // ---------------------------------------------------------------- reconciliation
  async reconciliation(statementId: string, manager?: EntityManager): Promise<ReconciliationView> {
    const em = this.em(manager);
    const statement = await em.getRepository(BankStatement).findOne({ where: { id: statementId } });
    if (!statement) throw new NotFoundException(`Bank statement "${statementId}" not found.`);
    const book: Array<{ b: string }> = await em.query(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('cash_in','transfer_in') THEN amount ELSE -amount END),0)::numeric(20,2)::text AS b FROM treasury_transactions WHERE "treasuryAccountId" = $1 AND ("movementDate" AT TIME ZONE 'UTC')::date <= $2::date`,
      [statement.treasuryAccountId, statement.periodEnd],
    );
    const outstanding: Array<{ id: string; transactionNumber: string; type: string; amount: string; movementDate: Date; reference: string | null }> = await em.query(
      `SELECT t.id, t."transactionNumber", t.type, t.amount, t."movementDate", t.reference FROM treasury_transactions t
        WHERE t."treasuryAccountId" = $1 AND (t."movementDate" AT TIME ZONE 'UTC')::date <= $2::date
          AND (t."movementDate" AT TIME ZONE 'UTC')::date >= (SELECT min("periodStart") FROM bank_statements WHERE "treasuryAccountId" = $1)
          AND NOT EXISTS (SELECT 1 FROM bank_statement_matches x WHERE x."treasuryTransactionId" = t.id AND x."unmatchedAt" IS NULL)
        ORDER BY t."movementDate" ASC`,
      [statement.treasuryAccountId, statement.periodEnd],
    );
    const unmatched = await em.getRepository(BankStatementLine).find({ where: { statementId }, order: { lineNumber: 'ASC' } });
    const bankOnly = unmatched.filter((l) => l.status !== 'matched');
    const outstandingNet = outstanding.reduce((s, t) => s + cents(signedAmount({ type: t.type as never, amount: t.amount })), 0);
    const bankOnlyNet = bankOnly.reduce((s, l) => s + cents(l.amount), 0);
    const r = reconciliationDifference({ closingBalance: statement.closingBalance, bookBalanceAtPeriodEnd: book[0].b, outstandingBookNet: (outstandingNet / 100).toFixed(2), bankOnlyNet: (bankOnlyNet / 100).toFixed(2) });
    const age = (d: string | Date) => Math.max(0, Math.round((Date.parse(statement.periodEnd) - Date.parse(String(d instanceof Date ? d.toISOString() : d).slice(0, 10))) / 86_400_000));
    return {
      statementId, systemNumber: statement.systemNumber, status: statement.status, closingBalance: statement.closingBalance, bookBalanceAtPeriodEnd: book[0].b,
      outstandingBookNet: (outstandingNet / 100).toFixed(2), bankOnlyNet: (bankOnlyNet / 100).toFixed(2), adjustedBank: r.adjustedBank, adjustedBook: r.adjustedBook, difference: r.difference,
      reconciled: statement.status === 'reconciled',
      unmatchedLines: bankOnly.map((l) => ({ id: l.id, lineNumber: l.lineNumber, valueDate: l.valueDate, amount: l.amount, description: l.description, reference: l.reference, possibleDuplicate: l.possibleDuplicate, ageDays: age(l.valueDate) })),
      outstandingBookItems: outstanding.map((t) => ({ transactionId: t.id, transactionNumber: t.transactionNumber, movementDate: String(t.movementDate instanceof Date ? t.movementDate.toISOString() : t.movementDate).slice(0, 10), signedAmount: signedAmount({ type: t.type as never, amount: t.amount }), reference: t.reference, ageDays: age(t.movementDate) })),
    };
  }

  async reconcile(statementId: string, actorUserId: string, manager?: EntityManager): Promise<BankStatement> {
    const run = async (m: EntityManager) => {
      const statement = await this.lockStatement(statementId, m);
      if (statement.status === 'reconciled') return statement; // idempotent
      const view = await this.reconciliation(statementId, m);
      if (view.unmatchedLines.length > 0) {
        throw new ConflictException(`${view.unmatchedLines.length} bank line(s) are not matched (${view.bankOnlyNet} in total). Record any bank fee / interest as a Treasury document, execute it, then match the line. Nothing was closed.`);
      }
      if (view.difference !== '0.00') {
        throw new ConflictException(`The statement does not reconcile: adjusted bank ${view.adjustedBank} vs adjusted book ${view.adjustedBook} — difference ${view.difference}. Nothing was closed.`);
      }
      statement.status = 'reconciled';
      statement.reconciledAt = new Date();
      statement.reconciledByUserId = actorUserId;
      statement.reconciliationDifference = view.difference;
      statement.version += 1;
      await m.getRepository(BankStatement).save(statement);
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.bank_statement.reconciled', resource: 'bank_statement', resourceId: statementId, result: 'success', correlationId: null, after: { adjustedBank: view.adjustedBank, adjustedBook: view.adjustedBook } }, m);
      return statement;
    };
    return runInTransaction(this.dataSource, manager, run);
  }

  /** Controlled reversal of a reconciliation: needs a reason, keeps the history in the audit trail, and makes the statement editable again. */
  async reopen(statementId: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<BankStatement> {
    const why = (reason ?? '').trim();
    if (why.length < 3) throw new BadRequestException('A reason is required to reopen a reconciled statement.');
    const run = async (m: EntityManager) => {
      const statement = await this.lockStatement(statementId, m);
      if (statement.status !== 'reconciled') throw new ConflictException('Only a reconciled statement can be reopened.');
      statement.status = 'imported';
      statement.reconciledAt = null;
      statement.reconciledByUserId = null;
      statement.reconciliationDifference = null;
      statement.version += 1;
      await m.getRepository(BankStatement).save(statement);
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.bank_statement.reopened', resource: 'bank_statement', resourceId: statementId, result: 'success', correlationId: null, after: { reason: why } }, m);
      return statement;
    };
    return runInTransaction(this.dataSource, manager, run);
  }

  private async lockStatement(id: string, m: EntityManager): Promise<BankStatement> {
    const s = await m.getRepository(BankStatement).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!s) throw new NotFoundException(`Bank statement "${id}" not found.`);
    return s;
  }
}
