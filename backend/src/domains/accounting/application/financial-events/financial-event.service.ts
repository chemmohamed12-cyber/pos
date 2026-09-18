import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
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

const DOMAIN_OF_TOPIC: Record<string, string> = {
  'finance.invoice.posted': 'finance',
  'finance.invoice.voided': 'finance',
  'finance.payment.recorded': 'finance',
  'treasury.cash.recorded': 'treasury',
  'treasury.transfer.completed': 'treasury',
  'deposit.verified': 'deposit-control',
  'collection.recorded': 'delivery',
  // F09 (ADR-042 D3) — the sole GL trigger for a COD collection.
  'collection.remitted': 'delivery',
  'return.completed': 'returns',
  'inventory.movement.recorded': 'inventory',
  'customer.refund.adjusted': 'deposit-control',
  // F04 — internal (F04 both emits and consumes; not an outbox subscription)
  'accounting.ar.adjustment.approved': 'accounting',
  // F05 — internal (ADR-037; same pattern as F04's AR line above)
  'accounting.ap.adjustment.approved': 'accounting',
  // F06 — internal (ADR-038; same pattern as F04/F05 above)
  'accounting.cash.adjustment.approved': 'accounting',
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
    for (const topic of SUBSCRIBED_TOPICS) {
      this.events.subscribe(topic, async (payload) => {
        await this.ingest(topic, payload);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async listEvents(filter?: { status?: FinancialEventStatus; sourceDomain?: string; eventType?: string }): Promise<FinancialEvent[]> {
    const where: Record<string, unknown> = {};
    if (filter?.status) where.status = filter.status;
    if (filter?.sourceDomain) where.sourceDomain = filter.sourceDomain;
    if (filter?.eventType) where.eventType = filter.eventType;
    return this.dataSource.getRepository(FinancialEvent).find({ where, order: { receivedAt: 'DESC' } });
  }

  async getEvent(id: string): Promise<FinancialEvent> {
    const ev = await this.dataSource.getRepository(FinancialEvent).findOne({ where: { id } });
    if (!ev) throw new NotFoundException(`Financial event "${id}" not found.`);
    return ev;
  }

  // ---------------------------------------------------------------------------
  // Ingest (Blueprint §6.1)
  // ---------------------------------------------------------------------------

  async ingest(eventType: string, rawPayload: Record<string, unknown>): Promise<IngestResult> {
    const payload = rawPayload ?? {};
    const sourceDomain = DOMAIN_OF_TOPIC[eventType] ?? 'unknown';
    const sourceEntityType = str(payload.sourceEntityType) ?? str(payload.entityType) ?? eventType.split('.')[1] ?? 'unknown';
    const sourceEntityId =
      str(payload.sourceEntityId) ?? str(payload.entityId) ?? str(payload.id) ?? str(payload.invoiceId) ?? str(payload.paymentId) ?? 'unknown';
    const idempotencyKey = str(payload.idempotencyKey) ?? `${sourceDomain}:${sourceEntityType}:${sourceEntityId}:${eventType}`;
    const businessDate = str(payload.businessDate) ?? new Date().toISOString().slice(0, 10);

    // 1. idempotency-guarded landing (ADR-035 D6)
    let event: FinancialEvent;
    try {
      event = await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(FinancialEvent);
        const base = await this.currencies.getBaseCurrency();
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
        const existing = await this.dataSource.getRepository(FinancialEvent).findOne({ where: { idempotencyKey } });
        if (existing) {
          return { financialEventId: existing.id, status: existing.status, journalEntryId: existing.journalEntryId, deduped: true };
        }
      }
      throw err;
    }

    // 2. no handler -> IGNORED (recorded, never dropped)
    const handler = this.registry.get(eventType);
    if (!handler) {
      await this.mark(event.id, 'IGNORED', null, 'no handler registered for this event type in V1');
      return { financialEventId: event.id, status: 'IGNORED', journalEntryId: null, deduped: false };
    }

    // 3+4. handler -> (if draft) create + post, ALL inside ONE transaction (ADR-041 D18a).
    // A handler that stays pure (every handler shipped before F08) never reads `ctx.manager` and
    // observes no behavior change; a handler that mutates something via `ctx.manager` (F08's
    // inventory-costing bridge) gets that mutation rolled back together with everything else here
    // on ANY failure — including a later posting-gate rejection.
    return this.runHandlerThroughPosting(event, handler);
  }

  // ---------------------------------------------------------------------------
  // Re-drive a REJECTED (or stuck) event (Blueprint §6.1 / API §20)
  // ---------------------------------------------------------------------------

  async redrive(id: string): Promise<IngestResult> {
    const event = await this.getEvent(id);
    if (event.status === 'POSTED') {
      return { financialEventId: id, status: 'POSTED', journalEntryId: event.journalEntryId, deduped: true };
    }
    if (event.status === 'IGNORED' && !this.registry.get(event.eventType)) {
      throw new NotFoundException(`No handler is registered for "${event.eventType}" — nothing to re-drive.`);
    }
    // discard any prior draft from a failed attempt
    if (event.journalEntryId) await this.discardDraft(event.journalEntryId);

    const handler = this.registry.get(event.eventType);
    if (!handler) {
      await this.mark(id, 'IGNORED', null, 'no handler registered');
      return { financialEventId: id, status: 'IGNORED', journalEntryId: null, deduped: false };
    }
    return this.runHandlerThroughPosting(event, handler);
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
  private async runHandlerThroughPosting(event: FinancialEvent, handler: FinancialEventHandler): Promise<IngestResult> {
    let outcome:
      | { status: 'IGNORED'; reason: string | null }
      | { status: 'REJECTED'; reason: string }
      | { status: 'POSTED'; journalEntryId: string };
    try {
      outcome = await this.dataSource.transaction(async (manager) => {
        const ctx = await this.buildContext(manager);
        let result: HandlerResult;
        try {
          result = await handler(event, ctx);
        } catch (e) {
          throw new Error(`handler threw: ${(e as Error).message}`);
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
            manager,
          );
          entryId = created.id;
        } catch (e) {
          throw new Error(`draft build failed: ${(e as Error).message}`);
        }
        try {
          await this.journals.postEntry(entryId, SYSTEM_ACTOR_ID, { systemPosting: true }, manager);
        } catch (e) {
          throw new Error(`posting gate rejected: ${(e as Error).message}`);
        }
        return { status: 'POSTED' as const, journalEntryId: entryId };
      });
    } catch (e) {
      // the transaction rolled back in full — no draft, no journal, no handler-side mutation
      // survives; `discardDraft` is therefore unreachable on this path (nothing left to discard).
      const message = (e as Error).message;
      await this.mark(event.id, 'REJECTED', null, message);
      await this.publishRejected(event, message);
      return { financialEventId: event.id, status: 'REJECTED', journalEntryId: null, deduped: false };
    }

    if (outcome.status === 'IGNORED') {
      await this.mark(event.id, 'IGNORED', null, outcome.reason);
      return { financialEventId: event.id, status: 'IGNORED', journalEntryId: null, deduped: false };
    }
    if (outcome.status === 'REJECTED') {
      await this.mark(event.id, 'REJECTED', null, outcome.reason);
      await this.publishRejected(event, outcome.reason);
      return { financialEventId: event.id, status: 'REJECTED', journalEntryId: null, deduped: false };
    }

    await this.mark(event.id, 'POSTED', outcome.journalEntryId, null);
    await this.dataSource.transaction(async (manager) => {
      await this.audit.record(
        {
          actorUserId: SYSTEM_ACTOR_ID,
          organizationId: null,
          action: 'accounting.financial_event.posted',
          resource: 'financial_event',
          resourceId: event.id,
          result: 'success',
          correlationId: event.id,
          after: { eventType: event.eventType, journalEntryId: outcome.journalEntryId },
        },
        manager,
      );
    });
    return { financialEventId: event.id, status: 'POSTED', journalEntryId: outcome.journalEntryId, deduped: false };
  }

  private async buildContext(manager: EntityManager): Promise<HandlerContext> {
    const base = await this.currencies.getBaseCurrency();
    const accRepo = this.dataSource.getRepository(GLAccount);
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
        if (!code) return { ok: false as const, reason: 'unset' as const };
        const acc = await accRepo.findOne({ where: { code } });
        if (!acc) return { ok: false as const, reason: 'not_found' as const };
        if (!acc.isActive) return { ok: false as const, reason: 'inactive' as const };
        if (!acc.isPostable) return { ok: false as const, reason: 'not_postable' as const };
        if (acc.controlFunction) return { ok: false as const, reason: 'is_control_account' as const };
        return { ok: true as const, id: acc.id };
      },
      resolveDimension: async (typeCode: string, valueCode: string) => {
        if (!typeCode || !valueCode) return null;
        const type = await this.dataSource.getRepository(FinancialDimensionType).findOne({ where: { code: typeCode, isActive: true } });
        if (!type) return null;
        const value = await this.dataSource
          .getRepository(FinancialDimensionValue)
          .findOne({ where: { dimensionTypeId: type.id, code: valueCode, isActive: true } });
        if (!value) return null;
        return { dimensionTypeId: type.id, dimensionValueId: value.id };
      },
    };
  }

  private async mark(id: string, status: FinancialEventStatus, journalEntryId: string | null, reason: string | null): Promise<void> {
    await this.dataSource.getRepository(FinancialEvent).update(
      { id },
      {
        status,
        journalEntryId: journalEntryId ?? undefined,
        rejectionReason: reason,
        processedAt: status === 'RECEIVED' ? null : new Date(),
      },
    );
  }

  private async discardDraft(entryId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const lines = await manager.getRepository(JournalLine).find({ where: { journalEntryId: entryId } });
      for (const l of lines) await manager.getRepository(JournalLineDimension).delete({ journalLineId: l.id });
      await manager.getRepository(JournalLine).delete({ journalEntryId: entryId });
      await manager.getRepository(JournalEntry).delete({ id: entryId });
    });
  }

  private async publishRejected(event: FinancialEvent, reason: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.events.publish(manager, 'accounting.financial_event.rejected', {
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
