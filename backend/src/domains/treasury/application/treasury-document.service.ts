import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { TreasuryDocument } from '../infrastructure/treasury-document.entity';
import { TreasuryDocumentAllocation } from '../infrastructure/treasury-document-allocation.entity';
import { TreasuryAccount } from '../infrastructure/treasury-account.entity';
import { TreasuryAccountType } from '../infrastructure/treasury-account-type.entity';
import {
  canTransitionTreasuryDocument,
  TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY,
  TREASURY_DOCUMENT_APPROVAL_REQUEST_TYPE,
  TREASURY_DOCUMENT_APPROVER_NODE,
  TREASURY_DOCUMENT_AUTO_APPROVE_LIMIT_KEY,
  TREASURY_DOCUMENT_KINDS,
  TREASURY_DOCUMENT_RESOURCE_TYPE,
  TREASURY_RECEIPT_REASON_ACCOUNTS_KEY,
  TREASURY_TRANSFER_SUBTYPES,
  TreasuryDocumentKind,
  TreasuryTransferSubtype,
} from '../domain/treasury-document';
import { TreasuryService } from './treasury.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { runInTransaction } from '../../../foundation/transaction/run-in-transaction';
import { FINANCE_COLLECTION_CONTRACT, FinanceCollectionContract } from '../../../foundation/module-registry/contracts/collection.contract';

const DOCUMENT_TYPE = 'treasury_document';
const DOCUMENT_PREFIX = 'TD';
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export interface TreasuryDocumentInput {
  kind: TreasuryDocumentKind;
  subtype?: TreasuryTransferSubtype | null;
  businessDate?: string;
  /** receiving (collection / receipt) · paying (disbursement) · source (transfer) account. */
  treasuryAccountId: string;
  counterTreasuryAccountId?: string | null;
  customerId?: string | null;
  allocations?: Array<{ invoiceId: string; amount: string }>;
  unappliedAmount?: string;
  /** misc receipt / disbursement / transfer: the total; collection: derived from allocations + unapplied (any value supplied is checked, not trusted). */
  amount?: string;
  method?: string | null;
  reasonCode?: string | null;
  reference?: string | null;
  purpose?: string | null;
}

export interface TreasuryDocumentView extends TreasuryDocument {
  /** each allocation carries the human invoice number (UI review finding: a raw id is not something a user can act on). */
  allocations: Array<TreasuryDocumentAllocation & { invoiceNumber: string | null }>;
  /**
   * BANK SETTLEMENT is a separate fact from execution and posting: `not_executed` (no movement yet), `unsettled` (executed and posted, but no confirmed bank-statement match),
   * `matched` (a person confirmed a statement line for the movement). Execution never implies the bank cleared it.
   */
  settlement: { state: 'not_executed' | 'unsettled' | 'matched'; statementNumber?: string; lineNumber?: number };
}

export interface EffectLine {
  side: 'debit' | 'credit';
  role: string;
  glAccountCode: string | null;
}

const money = (n: number): string => n.toFixed(2);
const isMoney = (v: unknown): v is string => typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v) && Number(v) > 0;

/**
 * T3 (2026-10-20) — the Treasury Document lifecycle: Draft → Submitted → Approved → Executed (→ Reversed), with Rejected / Cancelled.
 *
 *  - PREPARE (create/edit a draft) ≠ APPROVE (a different person, through the FA-01 maker-checker engine, resolved live against `finance.cash_document.approve`)
 *    ≠ EXECUTE (an explicit action that alone moves money) ≠ REVERSE (a linked document action, never an edit).
 *  - EXECUTE runs inside ONE transaction on a locked row: the document flip, the movement (through the existing Treasury / customer-finance services, hence the existing
 *    Financial Events, publish guard, idempotency and audit), and the links back to the document commit or roll back together. A retry finds `executed` and changes nothing.
 *  - No account number is chosen by the user or hard-coded: misc receipts / disbursements name a REASON, and the company's own reason→account map (posting profile) decides.
 *  - A document is executable only on its own business date (back/forward-dating needs an owner policy — [U] — and is refused rather than guessed).
 */
@Injectable()
export class TreasuryDocumentService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly treasury: TreasuryService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly approvals: ApprovalEngineService,
    private readonly config: ConfigurationEngineService,
    @Inject(FINANCE_COLLECTION_CONTRACT) private readonly collections: FinanceCollectionContract,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.approvals.registerRequestType(TREASURY_DOCUMENT_APPROVAL_REQUEST_TYPE, 'action.treasury_document').catch(() => undefined);
    await this.approvals
      .upsertMatrixRule(
        { requestTypeCode: TREASURY_DOCUMENT_APPROVAL_REQUEST_TYPE, minApprovers: 1, requiredPermissionNode: TREASURY_DOCUMENT_APPROVER_NODE, valueThreshold: null, orgUnitId: null },
        SYSTEM_ACTOR,
      )
      .catch(() => undefined);
    this.events.subscribe('approval.request.approved', async (payload, ctx) => this.onApprovalDecided('approved', payload as Record<string, unknown>, ctx.manager ?? undefined), { scope: 'company' });
    this.events.subscribe('approval.request.rejected', async (payload, ctx) => this.onApprovalDecided('rejected', payload as Record<string, unknown>, ctx.manager ?? undefined), { scope: 'company' });
  }

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async get(id: string, manager?: EntityManager): Promise<TreasuryDocumentView> {
    const em = this.em(manager);
    const doc = await em.getRepository(TreasuryDocument).findOne({ where: { id } });
    if (!doc) throw new NotFoundException(`Treasury document "${id}" not found.`);
    const rows = await em.getRepository(TreasuryDocumentAllocation).find({ where: { documentId: id }, order: { createdAt: 'ASC' } });
    const numbers = new Map<string, string>();
    if (rows.length > 0) {
      const found: Array<{ id: string; invoiceNumber: string }> = await em.query(`SELECT id, "invoiceNumber" FROM sales_invoices WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.invoiceId)]);
      for (const f of found) numbers.set(f.id, f.invoiceNumber);
    }
    const allocations = rows.map((r) => Object.assign(r, { invoiceNumber: numbers.get(r.invoiceId) ?? null }));
    let settlement: TreasuryDocumentView['settlement'] = { state: doc.executedTransactionId ? 'unsettled' : 'not_executed' };
    if (doc.executedTransactionId) {
      const present: Array<{ ok: boolean }> = await em.query(`SELECT to_regclass('bank_statement_matches') IS NOT NULL AS ok`);
      if (present[0]?.ok) {
        const hit: Array<{ systemNumber: string; lineNumber: number }> = await em.query(
          `SELECT s."systemNumber", l."lineNumber" FROM bank_statement_matches m JOIN bank_statement_lines l ON l.id = m."lineId" JOIN bank_statements s ON s.id = l."statementId" WHERE m."unmatchedAt" IS NULL AND m."treasuryTransactionId" = $1 LIMIT 1`,
          [doc.executedTransactionId],
        );
        if (hit.length > 0) settlement = { state: 'matched', statementNumber: hit[0].systemNumber, lineNumber: hit[0].lineNumber };
      }
    }
    return Object.assign(doc, { allocations, settlement }) as TreasuryDocumentView;
  }

  async list(filter: { status?: string; kind?: string } = {}, manager?: EntityManager): Promise<TreasuryDocument[]> {
    const where: Record<string, unknown> = {};
    if (filter.status) where.status = filter.status;
    if (filter.kind) where.kind = filter.kind;
    return this.em(manager).getRepository(TreasuryDocument).find({ where, order: { createdAt: 'DESC' }, take: 500 });
  }

  /** The reason CODES an author may choose (never the accounts behind them). */
  listReasonCodes(): { receipt: string[]; disbursement: string[] } {
    return {
      receipt: Object.keys(this.readMap(TREASURY_RECEIPT_REASON_ACCOUNTS_KEY)).sort(),
      disbursement: Object.keys(this.readMap(TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY)).sort(),
    };
  }

  /** The accounting effect the document WILL have, in roles + the mapped GL codes that are known to Treasury (no account is invented). */
  async previewEffect(id: string, manager?: EntityManager): Promise<{ documentId: string; lines: EffectLine[]; note: string }> {
    const doc = await this.get(id, manager);
    const em = this.em(manager);
    const accounts = new Map<string, TreasuryAccount>();
    for (const accId of [doc.treasuryAccountId, doc.counterTreasuryAccountId].filter((x): x is string => !!x)) {
      const a = await em.getRepository(TreasuryAccount).findOne({ where: { id: accId } });
      if (a) accounts.set(a.id, a);
    }
    const gl = (accId: string | null) => (accId ? accounts.get(accId)?.glAccountCode ?? null : null);
    const reasonKey = doc.kind === 'misc_receipt' ? TREASURY_RECEIPT_REASON_ACCOUNTS_KEY : TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY;
    const mappedReason = doc.reasonCode ? (this.readMap(reasonKey)[doc.reasonCode] ?? null) : null;
    let lines: EffectLine[] = [];
    let note = '';
    switch (doc.kind) {
      case 'customer_collection':
        lines = [
          { side: 'debit', role: 'Receiving cash / bank account', glAccountCode: gl(doc.treasuryAccountId) },
          { side: 'credit', role: 'Accounts receivable (control)', glAccountCode: null },
        ];
        note = 'One receipt: AR is credited once for the total; each allocation settles its own invoice in the customer ledger (the unapplied part stays as a customer advance inside AR).';
        break;
      case 'transfer':
        lines = [
          { side: 'debit', role: 'Destination cash / bank account', glAccountCode: gl(doc.counterTreasuryAccountId) },
          { side: 'credit', role: 'Source cash / bank account', glAccountCode: gl(doc.treasuryAccountId) },
        ];
        note = 'A transfer between two internal accounts: no revenue, no expense, no customer or supplier effect.';
        break;
      case 'misc_receipt':
        lines = [
          { side: 'debit', role: 'Receiving cash / bank account', glAccountCode: gl(doc.treasuryAccountId) },
          { side: 'credit', role: `Reason "${doc.reasonCode}" account (company posting profile)`, glAccountCode: mappedReason },
        ];
        note = 'The counter account comes from the company reason→account map; an unmapped reason cannot be executed.';
        break;
      case 'disbursement':
        lines = [
          { side: 'debit', role: `Reason "${doc.reasonCode}" account (company posting profile)`, glAccountCode: mappedReason },
          { side: 'credit', role: 'Paying cash / bank account', glAccountCode: gl(doc.treasuryAccountId) },
        ];
        note = 'The counter account comes from the company reason→account map; an unmapped reason cannot be executed.';
        break;
    }
    return { documentId: id, lines, note };
  }

  // ---------------------------------------------------------------------------
  // Prepare (maker)
  // ---------------------------------------------------------------------------

  async create(input: TreasuryDocumentInput, actorUserId: string, manager?: EntityManager): Promise<TreasuryDocumentView> {
    const run = async (m: EntityManager) => {
      const normalized = await this.validateInput(input, actorUserId, m);
      await this.numbering.registerDocumentType(DOCUMENT_TYPE, DOCUMENT_PREFIX, true, m);
      const documentNumber = await this.numbering.getNextNumber(DOCUMENT_TYPE, m);
      const repo = m.getRepository(TreasuryDocument);
      const saved = await repo.save(repo.create({ ...normalized.fields, documentNumber, status: 'draft', createdByUserId: actorUserId, version: 1 }));
      await this.replaceAllocations(saved.id, normalized.allocations, m);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'treasury.document.created', resource: 'treasury_document', resourceId: saved.id, result: 'success', correlationId: null, after: { documentNumber, kind: saved.kind, amount: saved.amount } },
        m,
      );
      return saved.id;
    };
    const id = await runInTransaction(this.dataSource, manager, run);
    return this.get(id, manager);
  }

  async update(id: string, input: TreasuryDocumentInput, expectedVersion: number | undefined, actorUserId: string, manager?: EntityManager): Promise<TreasuryDocumentView> {
    const run = async (m: EntityManager) => {
      const doc = await this.lock(id, m);
      if (doc.status !== 'draft') throw new ConflictException(`Only a draft can be edited — this document is "${doc.status}". Cancel it or create a new one.`);
      if (doc.createdByUserId !== actorUserId) throw new ForbiddenException('Only the preparer can edit a draft.');
      this.assertVersion(doc, expectedVersion);
      if (input.kind !== doc.kind) throw new BadRequestException('The kind of a document cannot be changed.');
      const normalized = await this.validateInput(input, actorUserId, m);
      Object.assign(doc, normalized.fields, { version: doc.version + 1 });
      await m.getRepository(TreasuryDocument).save(doc);
      await this.replaceAllocations(id, normalized.allocations, m);
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.document.updated', resource: 'treasury_document', resourceId: id, result: 'success', correlationId: null, after: { amount: doc.amount } }, m);
    };
    await runInTransaction(this.dataSource, manager, run);
    return this.get(id, manager);
  }

  // ---------------------------------------------------------------------------
  // Submit → approval (checker is a different person; resolved live by the engine)
  // ---------------------------------------------------------------------------

  async submit(id: string, expectedVersion: number | undefined, actorUserId: string, manager?: EntityManager): Promise<TreasuryDocumentView> {
    let approvalStarted = false;
    const run = async (m: EntityManager) => {
      const doc = await this.lock(id, m);
      if (!canTransitionTreasuryDocument(doc.status, 'submitted')) throw new ConflictException(`A document in status "${doc.status}" cannot be submitted.`);
      if (doc.createdByUserId !== actorUserId) throw new ForbiddenException('Only the preparer can submit a draft.');
      this.assertVersion(doc, expectedVersion);
      await this.preflight(doc, actorUserId, m); // re-validate with today's data: the world may have changed since the draft was saved

      doc.status = 'submitted';
      doc.submittedAt = new Date();
      doc.version += 1;
      if (this.withinAutoApproveLimit(doc.amount)) {
        doc.status = 'approved';
        doc.autoApproved = true;
        doc.approvedAt = new Date();
        await m.getRepository(TreasuryDocument).save(doc);
        await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.document.auto_approved', resource: 'treasury_document', resourceId: id, result: 'success', correlationId: null, after: { amount: doc.amount, limitKey: TREASURY_DOCUMENT_AUTO_APPROVE_LIMIT_KEY } }, m);
      } else {
        await m.getRepository(TreasuryDocument).save(doc);
        approvalStarted = true;
      }
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.document.submitted', resource: 'treasury_document', resourceId: id, result: 'success', correlationId: null, after: { status: doc.status } }, m);
    };
    await runInTransaction(this.dataSource, manager, run);
    if (approvalStarted) {
      const doc = await this.em(manager).getRepository(TreasuryDocument).findOne({ where: { id } });
      const request = await this.approvals.submit(
        {
          requestTypeCode: TREASURY_DOCUMENT_APPROVAL_REQUEST_TYPE,
          resourceType: TREASURY_DOCUMENT_RESOURCE_TYPE,
          resourceId: id,
          requestedAction: doc!.kind,
          payload: { amount: doc!.amount, kind: doc!.kind, documentNumber: doc!.documentNumber },
          makerUserId: actorUserId,
        },
        manager,
      );
      await this.em(manager).getRepository(TreasuryDocument).update({ id }, { approvalRequestId: request.id });
    }
    return this.get(id, manager);
  }

  /** The checker's decision, through the FA-01 engine (maker ≠ checker and the live `finance.cash_document.approve` check are enforced THERE). */
  async decide(id: string, approverUserId: string, decision: 'approved' | 'rejected', note: string | undefined, manager?: EntityManager): Promise<TreasuryDocumentView> {
    const doc = await this.em(manager).getRepository(TreasuryDocument).findOne({ where: { id } });
    if (!doc) throw new NotFoundException(`Treasury document "${id}" not found.`);
    if (doc.status !== 'submitted' || !doc.approvalRequestId) throw new ConflictException(`This document is "${doc.status}" — nothing is waiting for a decision.`);
    await this.approvals.decide(doc.approvalRequestId, approverUserId, decision, note ?? null, manager);
    return this.get(id, manager);
  }

  private async onApprovalDecided(decision: 'approved' | 'rejected', payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    if (payload.resourceType !== TREASURY_DOCUMENT_RESOURCE_TYPE) return;
    const id = String(payload.resourceId ?? '');
    const requestId = String(payload.approvalRequestId ?? '');
    const run = async (m: EntityManager) => {
      const doc = await m.getRepository(TreasuryDocument).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!doc || doc.status !== 'submitted' || doc.approvalRequestId !== requestId) return; // stale / replayed event: nothing to do
      const decided: Array<{ approverUserId: string; note: string | null }> = await m.query(
        `SELECT "approverUserId", note FROM approval_decisions WHERE "approvalRequestId" = $1 AND decision = $2 ORDER BY "decidedAt" DESC LIMIT 1`,
        [requestId, decision],
      );
      doc.status = decision === 'approved' ? 'approved' : 'rejected';
      doc.version += 1;
      if (decision === 'approved') {
        doc.approvedAt = new Date();
        doc.approvedByUserId = decided[0]?.approverUserId ?? null;
      } else {
        doc.rejectionNote = decided[0]?.note ?? null;
      }
      await m.getRepository(TreasuryDocument).save(doc);
      await this.audit.record({ actorUserId: decided[0]?.approverUserId ?? SYSTEM_ACTOR, organizationId: null, action: `treasury.document.${decision}`, resource: 'treasury_document', resourceId: id, result: 'success', correlationId: requestId, after: { status: doc.status } }, m);
    };
    await runInTransaction(this.dataSource, manager, run);
  }

  // ---------------------------------------------------------------------------
  // Execute (the only action that moves money)
  // ---------------------------------------------------------------------------

  async execute(id: string, expectedVersion: number | undefined, actorUserId: string, manager?: EntityManager): Promise<TreasuryDocumentView> {
    const run = async (m: EntityManager) => {
      const doc = await this.lock(id, m);
      if (doc.status === 'executed') return; // idempotent retry: already done, nothing repeated
      if (doc.status !== 'approved') throw new ConflictException(`Only an approved document can be executed — this one is "${doc.status}".`);
      this.assertVersion(doc, expectedVersion);
      const today = new Date().toISOString().slice(0, 10);
      if (doc.businessDate !== today) {
        throw new ConflictException(`This document is dated ${doc.businessDate} but executes on ${today}: back- or forward-dated execution needs an owner policy and is not allowed. Cancel it and prepare a new one.`);
      }
      await this.preflight(doc, actorUserId, m);
      const allocations = await m.getRepository(TreasuryDocumentAllocation).find({ where: { documentId: id } });

      const result = await this.performMovement(doc, allocations, actorUserId, m);
      doc.status = 'executed';
      doc.executedAt = new Date();
      doc.executedByUserId = actorUserId;
      doc.executedTransactionId = result.transactionId;
      doc.executedPaymentId = result.paymentId;
      doc.version += 1;
      await m.getRepository(TreasuryDocument).save(doc);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'treasury.document.executed', resource: 'treasury_document', resourceId: id, result: 'success', correlationId: null, after: { documentNumber: doc.documentNumber, transactionId: result.transactionId, paymentId: result.paymentId, approvedBy: doc.approvedByUserId } },
        m,
      );
    };
    await runInTransaction(this.dataSource, manager, run);
    await this.events.dispatchAfterCommit(manager);
    return this.get(id, manager);
  }

  private async performMovement(
    doc: TreasuryDocument,
    allocations: TreasuryDocumentAllocation[],
    actorUserId: string,
    m: EntityManager,
  ): Promise<{ transactionId: string; paymentId: string | null }> {
    const reference = doc.reference ?? doc.documentNumber;
    switch (doc.kind) {
      case 'customer_collection': {
        const r = await this.collections.recordCollection(
          {
            customerId: doc.customerId!,
            allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
            unappliedAmount: doc.unappliedAmount,
            method: doc.method ?? 'cash',
            treasuryAccountId: doc.treasuryAccountId,
            reference,
            documentId: doc.id,
          },
          actorUserId,
          m,
        );
        return { transactionId: r.treasuryTransactionId, paymentId: r.paymentId };
      }
      case 'transfer': {
        const { out } = await this.treasury.transferDirect(doc.treasuryAccountId, doc.counterTreasuryAccountId!, doc.amount, reference, doc.purpose, actorUserId, m);
        return { transactionId: out.id, paymentId: null };
      }
      case 'misc_receipt': {
        const leg = await this.treasury.cashInDirect(doc.treasuryAccountId, doc.amount, null, null, reference, doc.purpose, actorUserId, m, { configKey: TREASURY_RECEIPT_REASON_ACCOUNTS_KEY, reasonCode: doc.reasonCode! });
        return { transactionId: leg.id, paymentId: null };
      }
      case 'disbursement': {
        const leg = await this.treasury.cashOutDirect(doc.treasuryAccountId, doc.amount, null, null, reference, doc.purpose, actorUserId, m, { configKey: TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY, reasonCode: doc.reasonCode! });
        return { transactionId: leg.id, paymentId: null };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cancel / reverse
  // ---------------------------------------------------------------------------

  async cancel(id: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<TreasuryDocumentView> {
    const why = (reason ?? '').trim();
    if (why.length < 3) throw new BadRequestException('A reason is required to cancel a document.');
    let withdrawRequest: string | null = null;
    const run = async (m: EntityManager) => {
      const doc = await this.lock(id, m);
      if (!canTransitionTreasuryDocument(doc.status, 'cancelled')) throw new ConflictException(`A document in status "${doc.status}" cannot be cancelled${doc.status === 'executed' ? ' — reverse it instead' : ''}.`);
      if (doc.status === 'submitted' && doc.approvalRequestId) {
        if (doc.createdByUserId !== actorUserId) throw new ForbiddenException('Only the preparer can withdraw a document that is waiting for approval.');
        withdrawRequest = doc.approvalRequestId;
      }
      doc.status = 'cancelled';
      doc.cancelReason = why;
      doc.version += 1;
      await m.getRepository(TreasuryDocument).save(doc);
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.document.cancelled', resource: 'treasury_document', resourceId: id, result: 'success', correlationId: null, after: { reason: why } }, m);
    };
    await runInTransaction(this.dataSource, manager, run);
    if (withdrawRequest) await this.approvals.withdraw(withdrawRequest, actorUserId, manager).catch(() => undefined); // a decision that raced us leaves the document cancelled and the request terminal
    return this.get(id, manager);
  }

  /** Reverse an EXECUTED document through the mechanism that owns its accounting effect; the document keeps its history and becomes `reversed`. */
  async reverse(id: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<TreasuryDocumentView> {
    const why = (reason ?? '').trim();
    if (why.length < 3) throw new BadRequestException('A reason is required to reverse a document.');
    const run = async (m: EntityManager) => {
      const doc = await this.lock(id, m);
      if (doc.status === 'reversed') return;
      if (doc.status !== 'executed') throw new ConflictException(`Only an executed document can be reversed — this one is "${doc.status}".`);
      if (doc.kind === 'customer_collection') {
        await this.collections.reversePayment(doc.executedPaymentId!, `${doc.documentNumber}: ${why}`, actorUserId, m);
      } else if (doc.kind === 'transfer') {
        await this.treasury.reverseTransaction(doc.executedTransactionId!, `${doc.documentNumber}: ${why}`, actorUserId, m, { ownerBypass: true });
      } else {
        const key = doc.kind === 'misc_receipt' ? TREASURY_RECEIPT_REASON_ACCOUNTS_KEY : TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY;
        await this.treasury.reverseTransaction(doc.executedTransactionId!, `${doc.documentNumber}: ${why}`, actorUserId, m, { ownerBypass: true, counter: { configKey: key, reasonCode: doc.reasonCode! } });
      }
      doc.status = 'reversed';
      doc.reversedAt = new Date();
      doc.reversedByUserId = actorUserId;
      doc.reversalReason = why;
      doc.version += 1;
      await m.getRepository(TreasuryDocument).save(doc);
      await this.audit.record({ actorUserId, organizationId: null, action: 'treasury.document.reversed', resource: 'treasury_document', resourceId: id, result: 'success', correlationId: null, after: { reason: why } }, m);
    };
    await runInTransaction(this.dataSource, manager, run);
    await this.events.dispatchAfterCommit(manager);
    return this.get(id, manager);
  }

  // ---------------------------------------------------------------------------
  // Validation helpers
  // ---------------------------------------------------------------------------

  private async lock(id: string, m: EntityManager): Promise<TreasuryDocument> {
    const doc = await m.getRepository(TreasuryDocument).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!doc) throw new NotFoundException(`Treasury document "${id}" not found.`);
    return doc;
  }

  private assertVersion(doc: TreasuryDocument, expected: number | undefined): void {
    if (expected !== undefined && expected !== doc.version) {
      throw new ConflictException(`The document changed since you opened it (version ${doc.version}, you have ${expected}). Reload it and try again.`);
    }
  }

  private withinAutoApproveLimit(amount: string): boolean {
    const raw = (this.config.get<string>(TREASURY_DOCUMENT_AUTO_APPROVE_LIMIT_KEY) ?? '').trim();
    if (!raw) return false;
    const limit = Number(raw);
    return Number.isFinite(limit) && limit > 0 && Number(amount) <= limit;
  }

  private readMap(configKey: string): Record<string, string> {
    const raw = this.config.get<unknown>(configKey);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  }

  private async replaceAllocations(documentId: string, allocations: Array<{ invoiceId: string; amount: string }>, m: EntityManager): Promise<void> {
    const repo = m.getRepository(TreasuryDocumentAllocation);
    await repo.delete({ documentId });
    for (const a of allocations) await repo.save(repo.create({ documentId, invoiceId: a.invoiceId, amount: a.amount }));
  }

  /** Structural validation of a draft (cheap, no money moves). Returns the persisted shape. */
  private async validateInput(
    input: TreasuryDocumentInput,
    actorUserId: string,
    m: EntityManager,
  ): Promise<{ fields: Partial<TreasuryDocument>; allocations: Array<{ invoiceId: string; amount: string }> }> {
    if (!TREASURY_DOCUMENT_KINDS.includes(input.kind)) throw new BadRequestException(`Unknown document kind "${input.kind}".`);
    const today = new Date().toISOString().slice(0, 10);
    const businessDate = input.businessDate ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new BadRequestException('businessDate must be YYYY-MM-DD.');
    const purpose = (input.purpose ?? '').trim();
    const reference = (input.reference ?? '').trim();
    if (!input.treasuryAccountId) throw new BadRequestException('An account is required.');
    await this.requireUsableAccount(input.treasuryAccountId, m);

    const fields: Partial<TreasuryDocument> = {
      kind: input.kind,
      subtype: null,
      businessDate,
      treasuryAccountId: input.treasuryAccountId,
      counterTreasuryAccountId: null,
      customerId: null,
      method: null,
      reasonCode: null,
      reference: reference || null,
      purpose: purpose || null,
      unappliedAmount: '0.00',
    };
    let allocations: Array<{ invoiceId: string; amount: string }> = [];

    if (input.kind === 'customer_collection') {
      if (!input.customerId) throw new BadRequestException('A customer is required for a customer collection.');
      await this.collections.listOpenInvoices(input.customerId, actorUserId, m); // Scope check + existence of the customer
      allocations = (input.allocations ?? []).map((a) => ({ invoiceId: a.invoiceId, amount: a.amount }));
      if (new Set(allocations.map((a) => a.invoiceId)).size !== allocations.length) throw new BadRequestException('An invoice can appear only once in a collection.');
      for (const a of allocations) if (!isMoney(a.amount)) throw new BadRequestException('Every allocation must be a positive amount with at most two decimals.');
      const unapplied = input.unappliedAmount ?? '0.00';
      if (!/^\d+(\.\d{1,2})?$/.test(unapplied)) throw new BadRequestException('The unapplied amount must be zero or a positive amount.');
      const total = allocations.reduce((s, a) => s + Number(a.amount), 0) + Number(unapplied);
      if (total <= 0) throw new BadRequestException('A collection needs at least one allocation or an unapplied amount.');
      if (input.amount !== undefined && Math.abs(Number(input.amount) - total) > 0.004) throw new BadRequestException(`The amount (${input.amount}) does not equal the allocations plus the unapplied part (${money(total)}).`);
      fields.amount = money(total);
      fields.customerId = input.customerId;
      fields.unappliedAmount = money(Number(unapplied));
      fields.method = (input.method ?? '').trim() || 'cash';
    } else {
      if (!isMoney(input.amount)) throw new BadRequestException('A positive amount with at most two decimals is required.');
      fields.amount = input.amount;
      if (input.kind === 'transfer') {
        const subtype = input.subtype ?? 'account_transfer';
        if (!TREASURY_TRANSFER_SUBTYPES.includes(subtype)) throw new BadRequestException(`Unknown transfer subtype "${subtype}".`);
        if (!input.counterTreasuryAccountId) throw new BadRequestException('A destination account is required for a transfer.');
        if (input.counterTreasuryAccountId === input.treasuryAccountId) throw new BadRequestException('The source and destination accounts must differ.');
        await this.requireUsableAccount(input.counterTreasuryAccountId, m);
        await this.assertTransferSubtype(subtype, input.treasuryAccountId, input.counterTreasuryAccountId, m);
        fields.subtype = subtype;
        fields.counterTreasuryAccountId = input.counterTreasuryAccountId;
        if (purpose.length < 3) throw new BadRequestException('A purpose is required.');
      } else {
        const reasonCode = (input.reasonCode ?? '').trim();
        if (!reasonCode) throw new BadRequestException('A reason code is required.');
        if (purpose.length < 3) throw new BadRequestException('A purpose is required.');
        if (!reference) throw new BadRequestException('A reference (the supporting document number) is required.');
        const key = input.kind === 'misc_receipt' ? TREASURY_RECEIPT_REASON_ACCOUNTS_KEY : TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY;
        if (!this.readMap(key)[reasonCode]) {
          throw new BadRequestException(`The reason "${reasonCode}" has no account in the company posting profile (${key}). Ask Accounting to map it before preparing this document.`);
        }
        fields.reasonCode = reasonCode;
      }
    }
    return { fields, allocations };
  }

  private async requireUsableAccount(accountId: string, m: EntityManager): Promise<TreasuryAccount> {
    const account = await m.getRepository(TreasuryAccount).findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException(`Treasury account "${accountId}" not found.`);
    if (account.status !== 'active') throw new ConflictException(`Treasury account "${account.code}" is inactive.`);
    if (!account.glAccountCode?.trim()) throw new ConflictException(`Treasury account "${account.code}" is not GL-mapped — map it before preparing a document on it.`);
    return account;
  }

  private async assertTransferSubtype(subtype: TreasuryTransferSubtype, sourceId: string, destId: string, m: EntityManager): Promise<void> {
    if (subtype === 'account_transfer') return;
    const accounts = await m.getRepository(TreasuryAccount).find({ where: { id: In([sourceId, destId]) } });
    const types = await m.getRepository(TreasuryAccountType).find({ where: { id: In(accounts.map((a) => a.accountTypeId)) } });
    const codeOf = (accId: string) => types.find((t) => t.id === accounts.find((a) => a.id === accId)?.accountTypeId)?.code ?? '';
    const cashLike = (c: string) => c === 'cash' || c === 'custody';
    if (subtype === 'bank_deposit' && !(cashLike(codeOf(sourceId)) && codeOf(destId) === 'bank')) {
      throw new BadRequestException('A bank deposit moves money from a cash / custody account into a bank account.');
    }
    if (subtype === 'bank_withdrawal' && !(codeOf(sourceId) === 'bank' && cashLike(codeOf(destId)))) {
      throw new BadRequestException('A bank withdrawal moves money from a bank account into a cash / custody account.');
    }
  }

  /** Read-only re-validation at submit and again at execute: accounts usable, funds visible, invoices still open with enough remaining, reason still mapped. */
  private async preflight(doc: TreasuryDocument, actorUserId: string, m: EntityManager): Promise<void> {
    await this.requireUsableAccount(doc.treasuryAccountId, m);
    if (doc.counterTreasuryAccountId) await this.requireUsableAccount(doc.counterTreasuryAccountId, m);
    if (doc.kind === 'customer_collection') {
      const open = new Map((await this.collections.listOpenInvoices(doc.customerId!, actorUserId, m)).map((i) => [i.id, i]));
      const allocations = await m.getRepository(TreasuryDocumentAllocation).find({ where: { documentId: doc.id } });
      for (const a of allocations) {
        const inv = open.get(a.invoiceId);
        if (!inv) throw new ConflictException(`Invoice ${a.invoiceId} is no longer open for collection.`);
        if (Number(a.amount) > Number(inv.remaining)) throw new ConflictException(`Invoice ${inv.invoiceNumber} has only ${inv.remaining} remaining, but ${a.amount} is allocated.`);
      }
    }
    if (doc.kind === 'misc_receipt' || doc.kind === 'disbursement') {
      const key = doc.kind === 'misc_receipt' ? TREASURY_RECEIPT_REASON_ACCOUNTS_KEY : TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY;
      if (!doc.reasonCode || !this.readMap(key)[doc.reasonCode]) throw new ConflictException(`The reason "${doc.reasonCode}" is no longer mapped in the company posting profile.`);
    }
  }
}

