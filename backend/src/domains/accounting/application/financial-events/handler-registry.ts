import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { ControlFunction } from '../../domain/control-function';

/**
 * F03 — Financial Event Engine (Blueprint §6.2, ADR-035 D2). The Ledger
 * core has ZERO `if (eventType === …)` branches — a handler is a pure
 * function registered here by event type. F07/F09/F10 add their own
 * handlers without touching `JournalEntryService` or the posting gate.
 */

export interface HandlerContext {
  /**
   * F08 (ADR-041 D18a) — the SAME transaction manager `FinancialEventService.ingest` uses for
   * this event's handler-through-posting span. A handler that needs to mutate something
   * atomically with the eventual GL post (F08's inventory-costing handler is the first such case)
   * passes this manager through to that mutation; a handler that stays pure (every other handler
   * shipped before F08) simply never reads this field — zero behavior change for them.
   */
  manager: EntityManager;
  /** the current base/functional currency code */
  baseCurrencyCode: string;
  /** first active postable account with this control function, or null */
  resolveControlAccount(fn: ControlFunction): Promise<string | null>;
  /** an active account by code, or null */
  findAccountByCode(code: string): Promise<string | null>;
  /**
   * F06 (ADR-038 D3) — resolve a GL account whose code comes from a
   * Configuration-Engine key (e.g. `accounting.cash_movement_clearing_account_code`),
   * with fail-closed validation: the resolved account must exist, be
   * active, be postable, and carry **no** `controlFunction`. Returns the
   * account id on success, or a typed reason a handler turns into a
   * `rejected` result. **No hard-coded fallback.**
   */
  resolveConfiguredPostableAccount(
    configKey: string,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: 'unset' | 'not_found' | 'inactive' | 'not_postable' | 'is_control_account' }>;
  /**
   * D5 (2026-10-05) — the control account of a function, but ONLY when exactly one active postable account carries it
   * (e.g. Input VAT = `tax_receivable`). `'none'` / `'ambiguous'` are typed reasons a handler turns into a `rejected`
   * result — never "the first one".
   */
  resolveUniqueControlAccount(fn: ControlFunction): Promise<{ ok: true; id: string } | { ok: false; reason: 'none' | 'ambiguous' }>;
  /**
   * D3-B (2026-10-04) — like `resolveConfiguredPostableAccount`, but the configured value is a JSON map
   * `{ [mapKey]: glAccountCode }` (e.g. manual-receipt Reason Code → Offset GL account). Same fail-closed
   * validation of the resolved account; `'unset'` also covers an absent/blank map entry. No fallback.
   */
  resolveConfiguredMappedAccount(
    configKey: string,
    mapKey: string,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: 'unset' | 'not_found' | 'inactive' | 'not_postable' | 'is_control_account' }>;
  /**
   * F11 (ADR-044 D4) — the generic FinancialEvent-payload dimension-tagging
   * convention: a handler that wants to tag its `JournalDraftLine` with a
   * dimension calls this with the payload's own `{typeCode, valueCode}`
   * hint. Resolves to a real `{dimensionTypeId, dimensionValueId}` pair, or
   * `null` if the type/value code doesn't resolve to an active row — a
   * handler decides for itself whether that's fail-open (post without the
   * dimension) or fail-closed (reject), exactly like any other optional
   * payload hint in this codebase (mirrors `resolveAccount`'s own
   * codeHint-or-fallback shape). No F04–F10 handler calls this in F11 —
   * it exists as a proven, reusable mechanism for a future consumer.
   */
  resolveDimension(typeCode: string, valueCode: string): Promise<{ dimensionTypeId: string; dimensionValueId: string } | null>;
}

export interface JournalDraftLine {
  accountId: string;
  debit?: string;
  credit?: string;
  description?: string | null;
  dimensions?: Array<{ dimensionTypeId: string; dimensionValueId: string }>;
}

export interface JournalDraft {
  businessDate: string;
  description: string;
  transactionCurrencyCode: string;
  orgUnitId: string | null;
  lines: JournalDraftLine[];
}

export type HandlerResult =
  | { kind: 'draft'; draft: JournalDraft }
  | { kind: 'rejected'; reason: string }
  | { kind: 'ignored'; reason: string };

export type FinancialEventHandler = (event: FinancialEvent, ctx: HandlerContext) => Promise<HandlerResult>;

/**
 * Every topic F03 subscribes to. A topic WITH a registered handler is
 * mapped; a topic WITHOUT one lands as `IGNORED` (recorded, never
 * dropped). `inventory.movement.recorded` gained its first real handler in F07
 * (ADR-040) — see `finance-handlers.ts` `V1_FINANCE_HANDLERS` and
 * `inventory-movement.handler.ts`. `deposit.verified` and `collection.remitted` gained theirs in
 * F09 (ADR-042 D1-D3) — `collection.remitted` is a NEW topic F09 itself introduces (it never
 * existed before F09; `remitCollection` published nothing at all until then).
 * `collection.recorded` stays subscribed-but-PERMANENTLY-ignored by design (ADR-042 D3) — not a
 * placeholder, a final position. Returns/Deposit's OTHER topic
 * (`customer.refund.adjusted`, no publisher exists anywhere) remain out of scope, unassigned.
 */
export const SUBSCRIBED_TOPICS: readonly string[] = [
  // V1 real handlers (ADR-035 D6)
  'finance.invoice.posted',
  'finance.invoice.voided',
  'finance.payment.recorded',
  // ADR-048 — Procurement's Supplier Invoice/AP real handlers (AP_EVENT_TOPICS' first publisher)
  'finance.supplier_invoice.posted',
  'finance.supplier_invoice.voided',
  'finance.supplier_payment.recorded',
  // ADR-054/ADR-057 — GRNI (Goods Received Not Invoiced): the Goods Receipt leg, Dr Inventory / Cr GRNI
  'procurement.goods_receipt.posted',
  // ADR-061 — Manufacturing Work Order movements (§13's accounting table)
  'manufacturing.work_order.material_issued',
  'manufacturing.work_order.material_returned',
  'manufacturing.work_order.finished_goods_received',
  'treasury.cash.recorded',
  'treasury.transfer.completed',
  // F07 (ADR-040) — real handler, fail-closed (`no_valuation_source`) until F08
  'inventory.movement.recorded',
  // F09 (ADR-042 D1/D9) — real handler
  'deposit.verified',
  // F09 (ADR-042 D3) — permanently subscribed-but-IGNORED, by design (see `handleCollectionRemitted`'s own doc comment)
  'collection.recorded',
  // F09 (ADR-042 D3) — real handler; the SOLE GL trigger for a COD collection
  'collection.remitted',
  // D4 (2026-10-05) — a completed return of an invoiced sale: Dr Sales Returns [+ Dr tax] / Cr AR
  'returns.sale_return.credited',
  // V1 subscribed-but-IGNORED (no publisher exists yet / out of Financial Core's scope)
  'return.completed',
  'customer.refund.adjusted',
  // ADR-070 — Payroll's own GL entry point (real handler, see finance-handlers.ts)
  'payroll.run.posted',
] as const;

@Injectable()
export class FinancialEventHandlerRegistry {
  private readonly handlers = new Map<string, FinancialEventHandler>();

  register(eventType: string, handler: FinancialEventHandler): void {
    if (this.handlers.has(eventType)) {
      throw new Error(`A financial-event handler is already registered for "${eventType}".`);
    }
    this.handlers.set(eventType, handler);
  }

  get(eventType: string): FinancialEventHandler | undefined {
    return this.handlers.get(eventType);
  }

  registeredTypes(): string[] {
    return [...this.handlers.keys()];
  }
}
