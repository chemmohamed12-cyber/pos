import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * F03 — General Ledger (ADR-035 D3). Journal Entry lifecycle as a
 * `foundation/process-engine` `ProcessDefinition` — no denormalised
 * `status` column, live state read via `ProcessEngineService.getState`,
 * same convention F01 used for fiscal year/period.
 *
 * `POST` always re-runs the full posting gate — `submit` (→ VALIDATED) is
 * optional and any edit drops a VALIDATED entry back to DRAFT so nothing
 * is posted from stale validation. POSTED and REVERSED are terminal for
 * mutation (append-only, ADR-035 D3).
 */
export const JOURNAL_ENTRY_PROCESS: ProcessDefinition = {
  key: 'accounting_journal_entry',
  initialState: 'DRAFT',
  transitions: [
    { from: 'DRAFT', to: 'VALIDATED', action: 'submit' },
    { from: 'VALIDATED', to: 'DRAFT', action: 'revise' },
    { from: 'DRAFT', to: 'POSTED', action: 'post' },
    { from: 'VALIDATED', to: 'POSTED', action: 'post' },
    { from: 'POSTED', to: 'REVERSED', action: 'reverse' },
  ],
};

export const JOURNAL_ENTRY_ENTITY_TYPE = 'JournalEntry';

export type JournalEntryStatus = 'DRAFT' | 'VALIDATED' | 'POSTED' | 'REVERSED';

/** How a journal entry came to exist (ADR-035 D7). */
export type JournalSourceType = 'FINANCIAL_EVENT' | 'MANUAL' | 'REVERSAL' | 'OPENING';

export const JOURNAL_SOURCE_TYPES: readonly JournalSourceType[] = ['FINANCIAL_EVENT', 'MANUAL', 'REVERSAL', 'OPENING'] as const;

/** Source types a human may create directly via `POST /accounting/journals`. */
export const USER_CREATABLE_SOURCE_TYPES: ReadonlySet<JournalSourceType> = new Set<JournalSourceType>(['MANUAL', 'OPENING']);

export function isJournalSourceType(v: unknown): v is JournalSourceType {
  return typeof v === 'string' && (JOURNAL_SOURCE_TYPES as readonly string[]).includes(v);
}

/**
 * F03 — Financial Event lifecycle (ADR-035 D2/D6). A plain status string
 * (not a ProcessDefinition — a financial event has no user-driven
 * workflow, only the engine advances it).
 *   RECEIVED  — landed, idempotency row written
 *   MAPPED    — a handler produced a draft journal entry
 *   POSTED    — the draft passed the posting gate and is on the ledger
 *   REJECTED  — a handler could not map it (missing data / unmapped account); re-drivable
 *   IGNORED   — a subscribed topic with no registered handler, or a handler that deliberately produces no journal
 */
export type FinancialEventStatus = 'RECEIVED' | 'MAPPED' | 'POSTED' | 'REJECTED' | 'IGNORED';

export const FINANCIAL_EVENT_STATUSES: readonly FinancialEventStatus[] = ['RECEIVED', 'MAPPED', 'POSTED', 'REJECTED', 'IGNORED'] as const;
