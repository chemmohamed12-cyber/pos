import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { LedgerService } from './ledger.service';

/** Topics / event types that move inventory value (the "inventory" posting domain). */
const INVENTORY_OUTBOX_TOPICS = ['inventory.movement.recorded', 'procurement.goods_receipt.posted'];
const INVENTORY_EVENT_TYPES = ['inventory.movement.recorded', 'procurement.goods_receipt.posted', 'accounting.inventory.adjustment.approved'];

export interface PostingStatus {
  domain: 'inventory';
  generatedAt: string;
  /** outbox rows not yet turned into a financial event (pending / processing). */
  pendingEvents: number;
  oldestPendingAt: string | null;
  /** outbox rows whose dispatch failed 5 times (dead-letter by status). */
  failedOutbox: number;
  /** financial events REJECTED (re-drivable on the Financial Events screen). */
  rejectedEvents: number;
  /** financial events received/mapped but not yet posted. */
  inFlightEvents: number;
  /** the latest time a journal entry was posted (any source) - "data as of". */
  lastPostedAt: string | null;
  lastReconciliation: {
    id: string;
    asOfDate: string;
    status: string;
    classification: string | null;
    unexplainedBase: string | null;
    driftBase: string | null;
    createdAt: string;
  } | null;
  /** `current` when nothing is pending/rejected/failed/in flight; otherwise `pending` (only pending / in-flight) or `attention` (rejected or failed). */
  state: 'current' | 'pending' | 'attention';
}

export interface FinancialStatusItem {
  source: 'financial_event' | 'outbox';
  id: string;
  eventType: string | null;
  glKind: string | null;
  status: string;
  rejectionReason: string | null;
  journalEntryId: string | null;
  businessDate: string | null;
  at: string | null;
}

/**
 * Slice C1 (ADR-INV-10) - READ-ONLY posting visibility. It answers "is what I am looking at complete?": how many inventory events are still travelling,
 * how many were rejected or dead-lettered, when the books were last posted, and the latest reconciliation. It reads accounting's own tables and the shared
 * outbox only and never writes, retries or re-drives anything (re-drive stays an explicit action on the Financial Events screen).
 */
@Injectable()
export class PostingStatusService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async getInventoryStatus(manager?: EntityManager): Promise<PostingStatus> {
    const m = this.em(manager);
    const [outbox] = (await m.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending,
              MIN("createdAt") FILTER (WHERE status IN ('pending','processing')) AS oldest,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM event_outbox WHERE topic = ANY($1::text[])`,
      [INVENTORY_OUTBOX_TOPICS],
    )) as Array<{ pending: number; oldest: Date | null; failed: number }>;
    const [events] = (await m.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
              COUNT(*) FILTER (WHERE status IN ('RECEIVED','MAPPED'))::int AS in_flight
         FROM accounting_financial_events WHERE "eventType" = ANY($1::text[])`,
      [INVENTORY_EVENT_TYPES],
    )) as Array<{ rejected: number; in_flight: number }>;
    const [posted] = (await m.query(
      `SELECT MAX(e."postedAt") AS last FROM accounting_journal_entries e WHERE ${this.ledger.postedFilter}`,
    )) as Array<{ last: Date | null }>;
    const runs = (await m.query(
      `SELECT id, "asOfDate"::text AS "asOfDate", status, classification, "unexplainedBase"::text AS "unexplainedBase", "driftBase"::text AS "driftBase", "createdAt"
         FROM accounting_inventory_reconciliation_runs ORDER BY "createdAt" DESC LIMIT 1`,
    )) as Array<{ id: string; asOfDate: string; status: string; classification: string | null; unexplainedBase: string | null; driftBase: string | null; createdAt: Date }>;

    const state: PostingStatus['state'] = events.rejected > 0 || outbox.failed > 0 ? 'attention' : outbox.pending > 0 || events.in_flight > 0 ? 'pending' : 'current';
    return {
      domain: 'inventory',
      generatedAt: new Date().toISOString(),
      pendingEvents: outbox.pending,
      oldestPendingAt: outbox.oldest ? new Date(outbox.oldest).toISOString() : null,
      failedOutbox: outbox.failed,
      rejectedEvents: events.rejected,
      inFlightEvents: events.in_flight,
      lastPostedAt: posted.last ? new Date(posted.last).toISOString() : null,
      lastReconciliation: runs[0] ? { ...runs[0], createdAt: new Date(runs[0].createdAt).toISOString() } : null,
      state,
    };
  }

  /**
   * The financial effect of ONE operational document (or any reference): its financial events and the outbox rows still waiting. The reference is what the
   * inventory events already carry in their payload (`referenceType` / `referenceId`), so accounting never reads another module's tables.
   */
  async getFinancialStatusByReference(
    referenceType: string,
    referenceId: string,
    manager?: EntityManager,
  ): Promise<{ referenceType: string; referenceId: string; summary: 'none' | 'posted' | 'pending' | 'rejected' | 'mixed'; items: FinancialStatusItem[] }> {
    const m = this.em(manager);
    const events = (await m.query(
      `SELECT 'financial_event' AS source, fe.id::text AS id, fe."eventType" AS "eventType", fe.payload->>'glKind' AS "glKind", fe.status AS status,
              fe."rejectionReason" AS "rejectionReason", fe."journalEntryId"::text AS "journalEntryId", fe."businessDate"::text AS "businessDate", fe."receivedAt" AS at
         FROM accounting_financial_events fe
        WHERE (fe.payload->>'referenceType' = $1 AND fe.payload->>'referenceId' = $2)
           OR ($1 = 'goods_receipt' AND fe.payload->>'goodsReceiptId' = $2)
        ORDER BY fe."receivedAt" DESC LIMIT 200`,
      [referenceType, referenceId],
    )) as Array<Omit<FinancialStatusItem, 'at'> & { at: Date | null }>;
    const waiting = (await m.query(
      `SELECT 'outbox' AS source, o.id::text AS id, o.topic AS "eventType", o.payload->>'glKind' AS "glKind", o.status AS status, NULL AS "rejectionReason",
              NULL AS "journalEntryId", o.payload->>'businessDate' AS "businessDate", o."createdAt" AS at
         FROM event_outbox o
        WHERE o.status IN ('pending','processing','failed')
          AND ((o.payload->>'referenceType' = $1 AND o.payload->>'referenceId' = $2) OR ($1 = 'goods_receipt' AND o.payload->>'goodsReceiptId' = $2))
        ORDER BY o."createdAt" DESC LIMIT 200`,
      [referenceType, referenceId],
    )) as Array<Omit<FinancialStatusItem, 'at'> & { at: Date | null }>;
    const items: FinancialStatusItem[] = [...events, ...waiting].map((r) => ({ ...r, at: r.at ? new Date(r.at).toISOString() : null }));
    const posted = items.filter((i) => i.source === 'financial_event' && i.status === 'POSTED').length;
    const rejected = items.filter((i) => i.status === 'REJECTED' || i.status === 'failed').length;
    const pending = items.filter((i) => i.source === 'outbox' ? i.status !== 'failed' : i.status === 'RECEIVED' || i.status === 'MAPPED').length;
    const summary = items.length === 0 ? 'none' : rejected > 0 && (posted > 0 || pending > 0) ? 'mixed' : rejected > 0 ? 'rejected' : pending > 0 ? (posted > 0 ? 'mixed' : 'pending') : 'posted';
    return { referenceType, referenceId, summary, items };
  }
}
