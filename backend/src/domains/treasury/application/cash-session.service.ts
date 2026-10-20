import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CashSession } from '../infrastructure/bank-statement.entities';
import { TreasuryAccount } from '../infrastructure/treasury-account.entity';
import { TreasuryAccountType } from '../infrastructure/treasury-account-type.entity';
import { TreasuryService } from './treasury.service';
import { TreasuryDocumentService } from './treasury-document.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { runInTransaction } from '../../../foundation/transaction/run-in-transaction';

const SESSION_DOC_TYPE = 'cash_session';
const SESSION_PREFIX = 'CS';
/** The posting-profile reason codes a cash-count variance is resolved with. They must exist in the company's receipt / disbursement profiles — no account is chosen here. */
export const CASH_OVER_REASON = 'CASH_OVER';
export const CASH_SHORT_REASON = 'CASH_SHORT';
const MONEY = /^\d+(\.\d{1,2})?$/;

/**
 * T5 (2026-10-21) — cash custody sessions (a shift / drawer / petty-cash fund): open with the book balance as the float, close with a counted amount.
 * The variance (counted − expected) is recorded, requires a reason, and is resolved by a DRAFT Treasury Document (receipt for over, disbursement for short) through the
 * company posting profile — so the correction has its own preparer, a separate approver and an explicit execution like any other movement. A closed session is immutable
 * (there is no edit); only a controlled reopen with a reason can undo it, and only while its variance document has not been approved or executed.
 */
@Injectable()
export class CashSessionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly treasury: TreasuryService,
    private readonly documents: TreasuryDocumentService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async list(filter: { treasuryAccountId?: string; status?: string } = {}, manager?: EntityManager): Promise<CashSession[]> {
    const where: Record<string, unknown> = {};
    if (filter.treasuryAccountId) where.treasuryAccountId = filter.treasuryAccountId;
    if (filter.status) where.status = filter.status;
    return this.em(manager).getRepository(CashSession).find({ where, order: { openedAt: 'DESC' }, take: 200 });
  }

  async get(id: string, manager?: EntityManager): Promise<CashSession> {
    const s = await this.em(manager).getRepository(CashSession).findOne({ where: { id } });
    if (!s) throw new NotFoundException(`Cash session "${id}" not found.`);
    return s;
  }

  async open(input: { treasuryAccountId: string; custodianUserId?: string; note?: string }, actorUserId: string, manager?: EntityManager): Promise<CashSession> {
    const run = async (m: EntityManager) => {
      const account = await m.getRepository(TreasuryAccount).findOne({ where: { id: input.treasuryAccountId } });
      if (!account) throw new NotFoundException(`Treasury account "${input.treasuryAccountId}" not found.`);
      if (account.status !== 'active') throw new ConflictException(`Treasury account "${account.code}" is inactive.`);
      const type = await m.getRepository(TreasuryAccountType).findOne({ where: { id: account.accountTypeId } });
      if (!type || !['cash', 'custody'].includes(type.code)) throw new BadRequestException('A cash session can only be opened on a cash or custody account.');
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${account.id}`]);
      const open = await m.getRepository(CashSession).findOne({ where: { treasuryAccountId: account.id, status: 'open' } });
      if (open) throw new ConflictException(`Account "${account.code}" already has an open session (${open.sessionNumber}). Close it first.`);
      await this.numbering.registerDocumentType(SESSION_DOC_TYPE, SESSION_PREFIX, true, m);
      const sessionNumber = await this.numbering.getNextNumber(SESSION_DOC_TYPE, m);
      const opening = await this.treasury.getAccountBalance(account.id, m);
      const repo = m.getRepository(CashSession);
      const saved = await repo.save(
        repo.create({ sessionNumber, treasuryAccountId: account.id, custodianUserId: input.custodianUserId ?? actorUserId, status: 'open', openedByUserId: actorUserId, openingBalance: opening, note: input.note ?? null, version: 1 }),
      );
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.cash_session.opened', resource: 'cash_session', resourceId: saved.id, result: 'success', correlationId: null, after: { sessionNumber, opening } }, m);
      return saved;
    };
    return runInTransaction(this.dataSource, manager, run);
  }

  async close(id: string, input: { countedAmount: string; varianceReason?: string }, actorUserId: string, manager?: EntityManager): Promise<CashSession> {
    if (!MONEY.test(input.countedAmount ?? '')) throw new BadRequestException('The counted amount must be zero or a positive amount with at most two decimals.');
    const run = async (m: EntityManager) => {
      const session = await m.getRepository(CashSession).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!session) throw new NotFoundException(`Cash session "${id}" not found.`);
      if (session.status !== 'open') throw new ConflictException(`Session ${session.sessionNumber} is already closed.`);
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${session.treasuryAccountId}`]); // a consistent snapshot: no movement slips in between the read and the close
      const expected = await this.treasury.getAccountBalance(session.treasuryAccountId, m);
      const varianceCents = Math.round(Number(input.countedAmount) * 100) - Math.round(Number(expected) * 100);
      const variance = (varianceCents / 100).toFixed(2);
      let varianceDocumentId: string | null = null;
      const reason = (input.varianceReason ?? '').trim();
      if (varianceCents !== 0) {
        if (reason.length < 3) throw new BadRequestException(`The count differs from the book balance by ${variance} — a reason for the variance is required. Nothing was closed.`);
        const codes = this.documents.listReasonCodes();
        const code = varianceCents > 0 ? CASH_OVER_REASON : CASH_SHORT_REASON;
        const list = varianceCents > 0 ? codes.receipt : codes.disbursement;
        if (!list.includes(code)) throw new ConflictException(`The reason "${code}" is not mapped in the company posting profile — ask Accounting to map it before a cash variance can be resolved. Nothing was closed.`);
        const draft = await this.documents.create(
          {
            kind: varianceCents > 0 ? 'misc_receipt' : 'disbursement',
            treasuryAccountId: session.treasuryAccountId,
            amount: (Math.abs(varianceCents) / 100).toFixed(2),
            reasonCode: code,
            reference: session.sessionNumber,
            purpose: `Cash count variance (${varianceCents > 0 ? 'over' : 'short'}) — session ${session.sessionNumber}: ${reason}`,
          },
          actorUserId,
          m,
        );
        varianceDocumentId = draft.id;
      }
      session.status = 'closed';
      session.closedAt = new Date();
      session.closedByUserId = actorUserId;
      session.expectedBalance = expected;
      session.countedAmount = Number(input.countedAmount).toFixed(2);
      session.variance = variance;
      session.varianceReason = reason || null;
      session.varianceDocumentId = varianceDocumentId;
      session.version += 1;
      await m.getRepository(CashSession).save(session);
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.cash_session.closed', resource: 'cash_session', resourceId: id, result: 'success', correlationId: varianceDocumentId, after: { expected, counted: session.countedAmount, variance } }, m);
      return session;
    };
    return runInTransaction(this.dataSource, manager, run);
  }

  async reopen(id: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<CashSession> {
    const why = (reason ?? '').trim();
    if (why.length < 3) throw new BadRequestException('A reason is required to reopen a closed session.');
    const run = async (m: EntityManager) => {
      const session = await m.getRepository(CashSession).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!session) throw new NotFoundException(`Cash session "${id}" not found.`);
      if (session.status !== 'closed') throw new ConflictException(`Session ${session.sessionNumber} is not closed.`);
      const other = await m.getRepository(CashSession).findOne({ where: { treasuryAccountId: session.treasuryAccountId, status: 'open' } });
      if (other) throw new ConflictException(`Account already has an open session (${other.sessionNumber}).`);
      if (session.varianceDocumentId) {
        const doc = await this.documents.get(session.varianceDocumentId, m);
        if (['approved', 'executed', 'reversed'].includes(doc.status)) {
          throw new ConflictException(`The variance document ${doc.documentNumber} is "${doc.status}" — reverse or cancel it first; a session whose correction was approved cannot be reopened.`);
        }
        if (['draft', 'submitted', 'rejected'].includes(doc.status)) await this.documents.cancel(doc.id, `Cash session ${session.sessionNumber} reopened: ${why}`, actorUserId, m);
      }
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'treasury.cash_session.reopened', resource: 'cash_session', resourceId: id, result: 'success', correlationId: null, after: { reason: why, previous: { counted: session.countedAmount, expected: session.expectedBalance, variance: session.variance } } },
        m,
      );
      session.status = 'open';
      session.closedAt = null;
      session.closedByUserId = null;
      session.expectedBalance = null;
      session.countedAmount = null;
      session.variance = null;
      session.varianceReason = null;
      session.varianceDocumentId = null;
      session.reopenedAt = new Date();
      session.reopenedByUserId = actorUserId;
      session.reopenReason = why;
      session.version += 1;
      await m.getRepository(CashSession).save(session);
      return session;
    };
    return runInTransaction(this.dataSource, manager, run);
  }
}
