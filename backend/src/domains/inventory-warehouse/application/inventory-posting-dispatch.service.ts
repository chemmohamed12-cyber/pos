import { Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { FinancialPostingSummary, InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';

/** What an inventory request reports about the GL side of what it just did. `not_applicable` = accounting is not installed (no GL exists to post to). */
export type FinancialPostingStatus = FinancialPostingSummary | 'not_applicable';

export interface FinancialPostingReport {
  status: FinancialPostingStatus;
  /** the dispatch of this request: outbox rows handled / that failed and stay queued for the next sweep or a re-drive. */
  dispatched: number;
  failed: number;
  /** false when the in-request dispatch is switched off (INVENTORY_IN_REQUEST_DISPATCH=off): the 30 s sweep posts instead and `status` says `pending` until it does. */
  dispatchEnabled: boolean;
  /** present only when the dispatch itself threw; the document is already committed and the events stay queued. */
  dispatchError?: string;
  message: string;
}

const RANK: Record<FinancialPostingSummary, number> = { none: 0, posted: 1, pending: 2, mixed: 3, rejected: 4 };

/**
 * C2 (ADR-INV-10) - IN-REQUEST posting dispatch for the inventory entry points, plus the truthful report of what happened.
 *
 * The document / movement transaction has ALREADY committed when this runs (it is called by the controller after the service returned), so a failure here
 * can never roll back or hide the stock effect; it can only leave events queued. The dispatch is the existing `EventBusService.dispatchAfterCommit` (claims the
 * Company's outbox rows `FOR UPDATE SKIP LOCKED`, runs the idempotent financial-event handlers, retries up to 5 times) - the 30 s sweep stays the safety net
 * and is safe to overlap with it. The report is then read from the financial events themselves (accounting binds the read through the posting policy), never
 * assumed from the fact that the dispatch ran: `posted` only when every event of the referenced records is POSTED.
 *
 * Switch: `INVENTORY_IN_REQUEST_DISPATCH=off` (any case) restores the pre-C2 behaviour (sweep only); the report then honestly says `pending`.
 */
@Injectable()
export class InventoryPostingDispatchService {
  private readonly logger = new Logger(InventoryPostingDispatchService.name);

  constructor(
    private readonly events: EventBusService,
    @Optional() private readonly postingPolicy?: InventoryPostingPolicyRegistry,
  ) {}

  isEnabled(): boolean {
    return (process.env.INVENTORY_IN_REQUEST_DISPATCH ?? 'on').trim().toLowerCase() !== 'off';
  }

  async dispatchAndReport(manager: EntityManager, refs: Array<{ referenceType: string; referenceId: string }>): Promise<FinancialPostingReport> {
    const dispatchEnabled = this.isEnabled();
    let dispatched = 0;
    let failed = 0;
    let dispatchError: string | undefined;
    if (dispatchEnabled) {
      try {
        ({ dispatched, failed } = await this.events.dispatchAfterCommit(manager));
      } catch (err) {
        dispatchError = err instanceof Error ? err.message : String(err);
        this.logger.warn(`In-request inventory dispatch failed (events stay queued for the sweep): ${dispatchError}`);
      }
    }

    const policy = this.postingPolicy?.get();
    if (!policy?.financialStatusByReference) {
      return { status: 'not_applicable', dispatched, failed, dispatchEnabled, ...(dispatchError ? { dispatchError } : {}), message: 'Accounting is not installed: no GL posting applies.' };
    }
    let status: FinancialPostingSummary = 'none';
    try {
      for (const r of refs) {
        const s = await policy.financialStatusByReference(r.referenceType, r.referenceId, manager);
        if (RANK[s] > RANK[status]) status = s;
      }
    } catch (err) {
      // The status could not be read: never claim "posted".
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not read the financial status after the inventory dispatch: ${reason}`);
      return { status: 'pending', dispatched, failed, dispatchEnabled, dispatchError: dispatchError ?? `status unavailable: ${reason}`, message: 'The GL posting status could not be confirmed; treat it as pending.' };
    }
    return { status, dispatched, failed, dispatchEnabled, ...(dispatchError ? { dispatchError } : {}), message: MESSAGES[status] };
  }
}

const MESSAGES: Record<FinancialPostingSummary, string> = {
  none: 'No financial posting is attached to this record.',
  posted: 'Posted to the General Ledger.',
  pending: 'The stock effect is recorded; the GL posting is still pending and will complete automatically or can be re-driven.',
  rejected: 'The stock effect is recorded but the GL posting was REJECTED; it needs attention (see Financial Events) and is not posted.',
  mixed: 'Part of the GL posting is complete and part is pending or rejected; it needs attention (see Financial Events).',
};
