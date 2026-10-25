import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { utcBusinessDate } from '../../../../foundation/localization/business-date';
import { DataSource, EntityManager } from 'typeorm';
import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { GLAccount } from '../../infrastructure/gl-account.entity';
import { FinancialDimensionType } from '../../infrastructure/financial-dimension-type.entity';
import { FinancialDimensionValue } from '../../infrastructure/financial-dimension-value.entity';
import { JournalEntry } from '../../infrastructure/journal-entry.entity';
import { JournalLine } from '../../infrastructure/journal-line.entity';
import { JournalLineDimension } from '../../infrastructure/journal-line-dimension.entity';
import { FinancialEventStatus } from '../../domain/journal';
import { ControlFunction } from '../../domain/control-function';
import { CurrencyService } from '../currency.service';
import { JournalEntryService } from '../journal-entry.service';
import { AuditService } from '../../../../foundation/audit/audit.service';
import { EventBusService } from '../../../../foundation/events/event-bus.service';
import { ConfigurationEngineService } from '../../../../foundation/configuration-engine/configuration-engine.service';
import { FinancialEventHandler, FinancialEventHandlerRegistry, HandlerContext, HandlerResult, SUBSCRIBED_TOPICS } from './handler-registry';
import { V1_FINANCE_HANDLERS } from './finance-handlers';

/** The nil UUID stands in for "the accounting engine itself" on system-posted entries. */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * F03 GL Posting Concurrency RCA (`docs/studies/
 * F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md`), Option B — CTO-approved
 * 2026-09-21. A Postgres deadlock (`40P01`) between `postEntry`'s own
 * `numbering_sequences`/`audit_records` locks is, by Postgres's own
 * documented guarantee, always safe to retry: the aborted transaction
 * made no persistent changes. This is domain-agnostic (the RCA reproduced
 * it with no Manufacturing-specific setup) — the retry lives here, in
 * F03's own generic posting gate, not in any calling domain.
 */
/** Topics whose publisher owns the GL effect inside its own transaction — see `validateForPublish`. */
const PUBLISH_GUARDED_TOPICS = ['treasury.cash.recorded', 'treasury.transfer.completed', 'finance.payment.recorded', 'finance.payment.reversed', 'finance.supplier_payment.recorded', 'finance.supplier_payment.reversed', 'deposit.verified', 'collection.remitted'] as const;

const DEADLOCK_ERROR_CODE = '40P01';
const MAX_POSTING_ATTEMPTS = 3;
const DEADLOCK_RETRY_BASE_DELAY_MS = 50;
const DEADLOCK_RETRY_JITTER_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Walks the (possibly wrapped) error for the Postgres error code `runHandlerThroughPosting`'s own wrap sites attach as `.pgCode` — never string-matches the rejection message, which is free text. */
function isDeadlockError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { pgCode?: unknown }).pgCode === DEADLOCK_ERROR_CODE;
}

const DOMAIN_OF_TOPIC: Record<string, string> = {
  'finance.invoice.posted': 'finance',
  'finance.invoice.voided': 'finance',
  'finance.payment.recorded': 'finance',
  'finance.payment.reversed': 'finance',
  'treasury.cash.recorded': 'treasury',
  'treasury.transfer.completed': 'treasury',
  'deposit.verified': 'deposit-control',
  'collection.recorded': 'delivery',
  // F09 (ADR-042 D3) — the sole GL trigger for a COD collection.
  'collection.remitted': 'delivery',
  'return.completed': 'returns',
  // D4 — the Revenue/AR leg of a completed return of an invoiced sale
  'returns.sale_return.credited': 'returns',
  'inventory.movement.recorded': 'inventory',
  'manufacturing.work_order.material_issued': 'manufacturing',
  'manufacturing.work_order.material_returned': 'manufacturing',
  'manufacturing.work_order.finished_goods_received': 'manufacturing',
  'manufacturing.work_order.scrap_recognized': 'manufacturing',
  'manufacturing.work_order.recovery_received': 'manufacturing',
  'customer.refund.adjusted': 'deposit-control',
  // F04 — internal (F04 both emits and consumes; not an outbox subscription)
  'accounting.ar.adjustment.approved': 'accounting',
  // F05 — internal (ADR-037; same pattern as F04's AR line above)
  'accounting.ap.adjustment.approved': 'accounting',
  // F06 — internal (ADR-038; same pattern as F04/F05 above)
  'accounting.cash.adjustment.approved': 'accounting',
  // ADR-070 — Payroll's own GL entry point
  'payroll.run.posted': 'payroll',
  // ADR-070 Addendum A-7 — one payroll payment
  'payroll.payout.settled': 'payroll',
};

export interface IngestResult {
  financialEventId: string;
  status: FinancialEventStatus;
  journalEntryId: string | null;
  deduped: boolean;
}

/**
 * F03 — Financial Event Engine (Blueprint §6, ADR-035 D1/D2/D6). Consumes
 * already-committed Transactional-Outbox events (`EventBusService.subscribe`)
 * — NO new broker, NO new durability mechanism. Each event lands as a
 * `FinancialEvent` whose `UNIQUE(idempotencyKey)` is the concurrency
 * control: a redelivered event never produces a second journal.
 */
@Injectable()
export class FinancialEventService implements OnModuleInit {
  private readonly logger = new Logger(FinancialEventService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly currencies: CurrencyService,
    private readonly journals: JournalEntryService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly registry: FinancialEventHandlerRegistry,
    private readonly config: ConfigurationEngineService, // F06 (ADR-038 D3) — for resolveConfiguredPostableAccount
  ) {}

  onModuleInit(): void {
    // Numbering registration is owned by JournalEntryService.onModuleInit — not repeated here
    // (calling registerDocumentType from two init hooks races on the sequence PK).
    for (const [eventType, handler] of Object.entries(V1_FINANCE_HANDLERS)) {
      if (!this.registry.get(eventType)) this.registry.register(eventType, handler);
    }
    // Treasury integrity (T1): money-movement topics whose GL effect is owned by the publishing transaction are validated BEFORE the publisher commits.
    // deposit.verified (published in the approval's own transaction since T1) and collection.remitted (always was, ADR-042 D3c) are guarded too.
    for (const topic of PUBLISH_GUARDED_TOPICS) {
      this.events.registerPublishGuard(topic, (payload, manager) => this.validateForPublish(topic, payload, manager));
    }
    for (const topic of SUBSCRIBED_TOPICS) {
      // ADR-075 (D10): Company-scope — a Company outbox's event is ingested against THAT Company's
      // database (`ctx.manager`); under ambient dispatch `ctx.manager` is null and this falls back to
      // the ambient DataSource exactly as before.
      this.events.subscribe(
        topic,
        async (payload, ctx) => {
          await this.ingest(topic, payload, ctx.manager ?? undefined);
        },
        { scope: 'company' },
      );
    }
  }

  /**
   * Treasury integrity (T1) — "dry-run" of exactly what ingestion will do, run inside the publisher's transaction before the outbox row exists:
   * (1) the accounting date must fall in an open fiscal period (the same gate `postEntry` applies), and (2) the registered handler, given the
   * real payload, must produce a draft rather than a rejection (bank leg mapped to an active chart account, counter/clearing account configured,
   * control accounts present...). A handler is pure for these topics, so nothing is written. Throws 409 with the handler's own reason, so the
   * caller's whole transaction rolls back — a movement that could never post is never committed. Residual by design: a period closed or a chart
   * edited between this check and the later dispatch is still caught by the normal REJECTED/redrive path.
   */
  async validateForPublish(eventType: string, rawPayload: Record<string, unknown>, manager: EntityManager): Promise<void> {
    const handler = this.registry.get(eventType);
    if (!handler) return;
    const payload = rawPayload ?? {};
    const businessDate = (str(payload.businessDate) ?? utcBusinessDate()).slice(0, 10); // some publishers send a full ISO timestamp; the period gate compares calendar dates
    const orgUnitId = str(payload.orgUnitId);
    await this.journals.assertPostingDateOpen(orgUnitId, businessDate, manager);
    const base = await this.currencies.getBaseCurrency(manager);
    const draftEvent = {
      eventType,
      payload,
      businessDate,
      orgUnitId,
      sourceEntityId: str(payload.sourceEntityId) ?? 'preflight',
      transactionCurrencyCode: str(payload.currency) ?? str(payload.transactionCurrencyCode) ?? base?.code ?? 'XXX',
    } as unknown as FinancialEvent;
    const result = await handler(draftEvent, await this.buildContext(manager));
    if (result.kind === 'rejected') {
      throw new ConflictException(`This movement cannot be posted to the general ledger — ${result.reason}. Nothing was recorded.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async listEvents(filter?: { status?: FinancialEventStatus; sourceDomain?: string; eventType?: string }, manager?: EntityManager): Promise<FinancialEvent[]> {
    const where: Record<string, unknown> = {};
    if (filter?.status) where.status = filter.status;
    if (filter?.sourceDomain) where.sourceDomain = filter.sourceDomain;
    if (filter?.eventType) where.eventType = filter.eventType;
    return (manager ?? this.dataSource).getRepository(FinancialEvent).find({ where, order: { receivedAt: 'DESC' } });
  }

  async getEvent(id: string, manager?: EntityManager): Promise<FinancialEvent> {
    const ev = await (manager ?? this.dataSource).getRepository(FinancialEvent).findOne({ where: { id } });
    if (!ev) throw new NotFoundException(`Financial event "${id}" not found.`);
    return ev;
  }

  // ---------------------------------------------------------------------------
  // Ingest (Blueprint §6.1)
  // ---------------------------------------------------------------------------

  async ingest(eventType: string, rawPayload: Record<string, unknown>, manager?: EntityManager): Promise<IngestResult> {
    const payload = rawPayload ?? {};
    const sourceDomain = DOMAIN_OF_TOPIC[eventType] ?? 'unknown';
    const sourceEntityType = str(payload.sourceEntityType) ?? str(payload.entityType) ?? eventType.split('.')[1] ?? 'unknown';
    const sourceEntityId =
      str(payload.sourceEntityId) ?? str(payload.entityId) ?? str(payload.id) ?? str(payload.invoiceId) ?? str(payload.paymentId) ?? 'unknown';
    const idempotencyKey = str(payload.idempotencyKey) ?? `${sourceDomain}:${sourceEntityType}:${sourceEntityId}:${eventType}`;
    const businessDate = str(payload.businessDate) ?? utcBusinessDate();

    // 1. idempotency-guarded landing (ADR-035 D6)
    let event: FinancialEvent;
    try {
      event = await (manager ?? this.dataSource).transaction(async (txManager) => {
        const repo = txManager.getRepository(FinancialEvent);
        const base = await this.currencies.getBaseCurrency(txManager);
        return repo.save(
          repo.create({
            eventType,
            sourceDomain,
            sourceEntityType,
            sourceEntityId,
            idempotencyKey,
            businessDate,
            orgUnitId: str(payload.orgUnitId),
            transactionCurrencyCode: str(payload.currency) ?? str(payload.transactionCurrencyCode) ?? base?.code ?? 'XXX',
            payload,
            payloadVersion: typeof payload.payloadVersion === 'number' ? payload.payloadVersion : 1,
            status: 'RECEIVED',
            journalEntryId: null,
            rejectionReason: null,
          }),
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await (manager ?? this.dataSource).getRepository(FinancialEvent).findOne({ where: { idempotencyKey } });
        if (existing) {
          return { financialEventId: existing.id, status: existing.status, journalEntryId: existing.journalEntryId, deduped: true };
        }
      }
      throw err;
    }

    // 2. no handler -> IGNORED (recorded, never dropped)
    const handler = this.registry.get(eventType);
    if (!handler) {
      await this.mark(event.id, 'IGNORED', null, 'no handler registered for this event type in V1', manager);
      return { financialEventId: event.id, status: 'IGNORED', journalEntryId: null, deduped: false };
    }

    // 3+4. handler -> (if draft) create + post, ALL inside ONE transaction (ADR-041 D18a).
    // A handler that stays pure (every handler shipped before F08) never reads `ctx.manager` and
    // observes no behavior change; a handler that mutates something via `ctx.manager` (F08's
    // inventory-costing bridge) gets that mutation rolled back together with everything else here
    // on ANY failure — including a later posting-gate rejection.
    return this.runHandlerThroughPosting(event, handler, manager);
  }

  // ---------------------------------------------------------------------------
  // Re-drive a REJECTED (or stuck) event (Blueprint §6.1 / API §20)
  // ---------------------------------------------------------------------------

  async redrive(id: string, manager?: EntityManager): Promise<IngestResult> {
    const event = await this.getEvent(id, manager);
    if (event.status === 'POSTED') {
      return { financialEventId: id, status: 'POSTED', journalEntryId: event.journalEntryId, deduped: true };
    }
    if (event.status === 'IGNORED' && !this.registry.get(event.eventType)) {
      throw new NotFoundException(`No handler is registered for "${event.eventType}" — nothing to re-drive.`);
    }
    // discard any prior draft from a failed attempt
    if (event.journalEntryId) await this.discardDraft(event.journalEntryId, manager);

    const handler = this.registry.get(event.eventType);
    if (!handler) {
      await this.mark(id, 'IGNORED', null, 'no handler registered', manager);
      return { financialEventId: id, status: 'IGNORED', journalEntryId: null, deduped: false };
    }
    return this.runHandlerThroughPosting(event, handler, manager);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * F08 (ADR-041 D18a) — the handler-execution-through-posting span, as ONE transaction: any
   * failure (the handler throwing, `createEntry` failing, or `postEntry`'s gate rejecting) rolls
   * back EVERYTHING inside it, including whatever the handler mutated via `ctx.manager` — never a
   * partially-applied side effect sitting next to a REJECTED financial event. Every rejection-reason
   * PREFIX below (`handler threw:` / `draft build failed:` / `posting gate rejected:`) is preserved
   * exactly as the pre-D18a two-transaction design produced it — this is a change to the
   * TRANSACTIONAL SHAPE only, not to any observable message or to the posting gate's own checks.
   */
  private async runHandlerThroughPosting(event: FinancialEvent, handler: FinancialEventHandler, manager?: EntityManager): Promise<IngestResult> {
    type Outcome =
      | { status: 'IGNORED'; reason: string | null }
      | { status: 'REJECTED'; reason: string }
      | { status: 'POSTED'; journalEntryId: string };

    let outcome: Outcome | null = null;
    let finalError: Error | null = null;

    // RCA Option B — a deadlock (`40P01`) aborts the WHOLE transaction with no persistent
    // change (Postgres's own guarantee for a deadlock loser), so retrying from scratch is safe.
    // Any other error (a real posting-gate rejection, a handler error) exits after one attempt —
    // this loop only ever retries the specific, transient failure class the RCA reproduced.
    for (let attempt = 1; attempt <= MAX_POSTING_ATTEMPTS; attempt++) {
      try {
        outcome = await (manager ?? this.dataSource).transaction(async (txManager) => {
          const ctx = await this.buildContext(txManager);
          let result: HandlerResult;
          try {
            result = await handler(event, ctx);
          } catch (e) {
            const wrapped = new Error(`handler threw: ${(e as Error).message}`) as Error & { pgCode?: unknown };
            wrapped.pgCode = (e as { code?: unknown })?.code;
            throw wrapped;
          }
          if (result.kind === 'ignored') return { status: 'IGNORED' as const, reason: result.reason };
          if (result.kind === 'rejected') return { status: 'REJECTED' as const, reason: result.reason };

          let entryId: string;
          try {
            const created = await this.journals.createEntry(
              {
                sourceType: 'FINANCIAL_EVENT',
                financialEventId: event.id,
                businessDate: result.draft.businessDate,
                description: result.draft.description,
                transactionCurrencyCode: result.draft.transactionCurrencyCode,
                orgUnitId: result.draft.orgUnitId,
                lines: result.draft.lines,
              },
              SYSTEM_ACTOR_ID,
              txManager,
            );
            entryId = created.id;
          } catch (e) {
            const wrapped = new Error(`draft build failed: ${(e as Error).message}`) as Error & { pgCode?: unknown };
            wrapped.pgCode = (e as { code?: unknown })?.code;
            throw wrapped;
          }
          try {
            await this.journals.postEntry(entryId, SYSTEM_ACTOR_ID, { systemPosting: true }, txManager);
          } catch (e) {
            const wrapped = new Error(`posting gate rejected: ${(e as Error).message}`) as Error & { pgCode?: unknown };
            wrapped.pgCode = (e as { code?: unknown })?.code;
            throw wrapped;
          }
          return { status: 'POSTED' as const, journalEntryId: entryId };
        });
        finalError = null;
        break;
      } catch (e) {
        finalError = e as Error;
        if (isDeadlockError(e) && attempt < MAX_POSTING_ATTEMPTS) {
          await sleep(DEADLOCK_RETRY_BASE_DELAY_MS + Math.random() * DEADLOCK_RETRY_JITTER_MS);
          continue;
        }
        break;
      }
    }

    if (finalError) {
      // the transaction rolled back in full (on the FINAL attempt) — no draft, no journal, no
      // handler-side mutation survives; `discardDraft` is therefore unreachable on this path
      // (nothing left to discard).
      const message = finalError.message;
      await this.mark(event.id, 'REJECTED', null, message, manager);
      await this.publishRejected(event, message, manager);
      return { financialEventId: event.id, status: 'REJECTED', journalEntryId: null, deduped: false };
    }
    const result = outcome as Outcome;

    if (result.status === 'IGNORED') {
      await this.mark(event.id, 'IGNORED', null, result.reason, manager);
      return { financialEventId: event.id, status: 'IGNORED', journalEntryId: null, deduped: false };
    }
    if (result.status === 'REJECTED') {
      await this.mark(event.id, 'REJECTED', null, result.reason, manager);
      await this.publishRejected(event, result.reason, manager);
      return { financialEventId: event.id, status: 'REJECTED', journalEntryId: null, deduped: false };
    }

    await this.mark(event.id, 'POSTED', result.journalEntryId, null, manager);
    await (manager ?? this.dataSource).transaction(async (txManager) => {
      await this.audit.record(
        {
          actorUserId: SYSTEM_ACTOR_ID,
          organizationId: null,
          action: 'accounting.financial_event.posted',
          resource: 'financial_event',
          resourceId: event.id,
          result: 'success',
          correlationId: event.id,
          after: { eventType: event.eventType, journalEntryId: result.journalEntryId },
        },
        txManager,
      );
    });
    return { financialEventId: event.id, status: 'POSTED', journalEntryId: result.journalEntryId, deduped: false };
  }

  /**
   * FA-02 (2026-10-06) — a publisher's PRE-MUTATION check that a configured account is resolvable AND postable, using exactly the
   * resolution the handler will perform later (so "accepted now, rejected at posting" cannot happen for a config reason).
   */
  async preflightConfiguredPostableAccount(configKey: string, manager?: EntityManager): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    const ctx = await this.buildContext(manager ?? this.dataSource.manager);
    return ctx.resolveConfiguredPostableAccount(configKey);
  }

  private async buildContext(manager: EntityManager): Promise<HandlerContext> {
    const base = await this.currencies.getBaseCurrency(manager);
    const accRepo = manager.getRepository(GLAccount);
    const resolvePostableNonControlByCode = async (code: string) => {
      if (!code) return { ok: false as const, reason: 'unset' as const };
      const acc = await accRepo.findOne({ where: { code } });
      if (!acc) return { ok: false as const, reason: 'not_found' as const };
      if (!acc.isActive) return { ok: false as const, reason: 'inactive' as const };
      if (!acc.isPostable) return { ok: false as const, reason: 'not_postable' as const };
      if (acc.controlFunction) return { ok: false as const, reason: 'is_control_account' as const };
      return { ok: true as const, id: acc.id };
    };
    return {
      manager,
      baseCurrencyCode: base?.code ?? 'XXX',
      resolveControlAccount: async (fn: ControlFunction) => {
        const acc = await accRepo.findOne({ where: { controlFunction: fn, isActive: true, isPostable: true } });
        return acc?.id ?? null;
      },
      findAccountByCode: async (code: string) => {
        if (!code) return null;
        const acc = await accRepo.findOne({ where: { code, isActive: true } });
        return acc?.id ?? null;
      },
      resolveConfiguredPostableAccount: async (configKey: string) => {
        const code = (this.config.get<string>(configKey) ?? '').trim();
        return resolvePostableNonControlByCode(code);
      },
      resolveUniqueControlAccount: async (fn: ControlFunction) => {
        const found = await accRepo.find({ where: { controlFunction: fn, isActive: true, isPostable: true }, take: 2 });
        if (found.length === 0) return { ok: false as const, reason: 'none' as const };
        if (found.length > 1) return { ok: false as const, reason: 'ambiguous' as const };
        return { ok: true as const, id: found[0].id };
      },
      resolveConfiguredMappedAccount: async (configKey: string, mapKey: string) => {
        const raw = this.config.get<unknown>(configKey);
        const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
        const entry = map[mapKey];
        const code = typeof entry === 'string' ? entry.trim() : '';
        return resolvePostableNonControlByCode(code);
      },
      resolveDimension: async (typeCode: string, valueCode: string) => {
        if (!typeCode || !valueCode) return null;
        const type = await manager.getRepository(FinancialDimensionType).findOne({ where: { code: typeCode, isActive: true } });
        if (!type) return null;
        const value = await manager
          .getRepository(FinancialDimensionValue)
          .findOne({ where: { dimensionTypeId: type.id, code: valueCode, isActive: true } });
        if (!value) return null;
        return { dimensionTypeId: type.id, dimensionValueId: value.id };
      },
    };
  }

  private async mark(id: string, status: FinancialEventStatus, journalEntryId: string | null, reason: string | null, manager?: EntityManager): Promise<void> {
    await (manager ?? this.dataSource).getRepository(FinancialEvent).update(
      { id },
      {
        status,
        journalEntryId: journalEntryId ?? undefined,
        rejectionReason: reason,
        processedAt: status === 'RECEIVED' ? null : new Date(),
      },
    );
  }

  private async discardDraft(entryId: string, manager?: EntityManager): Promise<void> {
    await (manager ?? this.dataSource).transaction(async (txManager) => {
      const lines = await txManager.getRepository(JournalLine).find({ where: { journalEntryId: entryId } });
      for (const l of lines) await txManager.getRepository(JournalLineDimension).delete({ journalLineId: l.id });
      await txManager.getRepository(JournalLine).delete({ journalEntryId: entryId });
      await txManager.getRepository(JournalEntry).delete({ id: entryId });
    });
  }

  private async publishRejected(event: FinancialEvent, reason: string, manager?: EntityManager): Promise<void> {
    await (manager ?? this.dataSource).transaction(async (txManager) => {
      await this.events.publish(txManager, 'accounting.financial_event.rejected', {
        financialEventId: event.id,
        eventType: event.eventType,
        sourceDomain: event.sourceDomain,
        reason,
      });
    });
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /duplicate key value violates unique constraint/i.test(msg);
}
