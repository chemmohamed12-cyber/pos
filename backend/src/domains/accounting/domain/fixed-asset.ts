import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * F12 — Fixed Assets (ADR-045). Lifecycle states: a `FixedAsset` created without a linked acquisition
 * `JournalEntry` starts `pending_acquisition` (excluded from depreciation eligibility, reported as its
 * own named reconciliation bucket — ADR-045 D7); linking a valid, POSTED, cost-matching entry (at
 * creation or later) transitions it to `active`; a POSTED, FA-01-approved disposal transitions it to
 * `disposed`; `reverse_disposal` is NEVER user-callable — it fires only as the event-driven side effect
 * of reversing that disposal's own `JournalEntry` (ADR-045 D11, `FixedAssetEventListenerService`).
 */
export const FIXED_ASSET_PROCESS: ProcessDefinition = {
  key: 'accounting_fixed_asset',
  initialState: 'pending_acquisition',
  transitions: [
    { from: 'pending_acquisition', to: 'active', action: 'link_acquisition' },
    { from: 'active', to: 'disposed', action: 'dispose' },
    { from: 'disposed', to: 'active', action: 'reverse_disposal' },
  ],
};

export const FIXED_ASSET_ENTITY_TYPE = 'FixedAsset';

export type FixedAssetLifecycleState = 'pending_acquisition' | 'active' | 'disposed';

/** ADR-045 D5 — straight-line only for V1, behind a swappable method field for future extension. */
export type DepreciationMethod = 'straight_line';

export const DEPRECIATION_METHODS: readonly DepreciationMethod[] = ['straight_line'] as const;

export function isDepreciationMethod(v: unknown): v is DepreciationMethod {
  return typeof v === 'string' && (DEPRECIATION_METHODS as readonly string[]).includes(v);
}

/** ADR-045 D2/D13 — the FA-01 request-type code + approver node for a disposal, mirroring `domain/ar.ts`'s exact shape. */
export const FIXED_ASSET_APPROVAL_REQUEST_TYPES = {
  dispose: 'accounting.fixed_asset.dispose',
} as const;

export const FIXED_ASSET_APPROVER_PERMISSION_NODE = 'accounting.fixed_asset.approve';

/** ADR-045 D13 — independently set for this domain, not copied from AR/AP's own `minApprovers: 2`. */
export const FIXED_ASSET_DISPOSAL_META = {
  requestTypeCode: FIXED_ASSET_APPROVAL_REQUEST_TYPES.dispose,
  minApprovers: 1,
  alwaysGated: true,
} as const;

/** ADR-045 D9 — `YYYY-MM`. */
export function isValidDepreciationPeriod(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** The internal FinancialEvent type an approved disposal is ingested as (ADR-045 D2, mirrors `accounting.{ar,ap,cash}.adjustment.approved`). */
export const FIXED_ASSET_DISPOSAL_APPROVED_EVENT = 'accounting.fixed_asset.adjustment.approved';

/**
 * ADR-045 D2 (corrected during implementation — disclosed, not hidden): a Depreciation Run posts
 * via the SAME `FinancialEventService.ingest` pipeline every other automated poster in this codebase
 * uses (F04-F10, F11's own proof), NOT a bare `JournalEntryService.createEntry({sourceType:'MANUAL'})`
 * call as the original ADR text stated. The bare-MANUAL approach was found, during implementation, to
 * incorrectly subject a routine depreciation run to `assertBackdatingAllowed`'s 0-day MANUAL-journal
 * rule — meaning running "January's depreciation" on any day after January 31st (an entirely normal
 * real-world timing) would be rejected as an illegal backdated manual journal. `FINANCIAL_EVENT`
 * entries are exempt from that rule by design (`assertBackdatingAllowed` only constrains `MANUAL`).
 * "Direct, no FA-01" (D2's actual intent) still holds — DepreciationService calls `ingest` itself,
 * synchronously, with no approval gate, exactly matching what F09's own handlers already do for their
 * own "direct, no FA-01" postings (they are ALSO ingest-driven, never a bare `createEntry` call).
 */
export const FIXED_ASSET_DEPRECIATION_CALCULATED_EVENT = 'accounting.fixed_asset.depreciation.calculated';

/** The real, already-existing F03 event F12 subscribes to (ADR-045 D11) — never modified, never re-published by F12. */
export const JOURNAL_REVERSED_EVENT = 'accounting.journal.reversed';
