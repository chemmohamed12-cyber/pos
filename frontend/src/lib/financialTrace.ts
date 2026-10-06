import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * NAV-07 — Document → Financial Status → Financial Event → Journal, on the operational screens. READ-ONLY over the existing Financial Event Engine
 * list (`GET /accounting/financial-events`, permission `accounting.financial_event.view`): every event carries the id of the document that raised it
 * (`sourceEntityId`) and, once posted, the journal it produced. Nothing is posted, retried or changed from here; a user without the view permission
 * simply sees no financial block (the screen behaves exactly as before).
 *
 * The existing list endpoint has no per-document filter, so the list is fetched once per page view (shared + short-lived cache) and matched by
 * `sourceEntityId` in the browser. Fine for the current volume; a server-side `sourceEntityId` filter is the follow-up if the event table grows.
 */
export interface TraceEvent {
  id: string;
  eventType: string;
  sourceEntityId: string;
  status: 'RECEIVED' | 'MAPPED' | 'POSTED' | 'REJECTED' | 'IGNORED';
  journalEntryId: string | null;
  rejectionReason: string | null;
  receivedAt: string;
  /** the publisher's own payload; deposit.verified carries `depositId` here but no `sourceEntityId` (it lands as 'unknown') */
  payload?: { depositId?: string } | null;
}

/** The three states the operator needs; RECEIVED/MAPPED are "not posted yet", IGNORED has no financial effect by design. */
export type TraceState = 'pending' | 'posted' | 'rejected' | 'ignored';
export const traceStateOf = (e: TraceEvent): TraceState =>
  e.status === 'POSTED' ? 'posted' : e.status === 'REJECTED' ? 'rejected' : e.status === 'IGNORED' ? 'ignored' : 'pending';

let cache: { at: number; promise: Promise<TraceEvent[] | null> } | null = null;
const TTL_MS = 8000;

export function loadTraceEvents(force = false): Promise<TraceEvent[] | null> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.promise;
  const promise = api
    .get<TraceEvent[]>('/accounting/financial-events')
    .then((r) => (Array.isArray(r) ? r : null))
    .catch(() => null); // not permitted / accounting not licensed: no financial block
  cache = { at: Date.now(), promise };
  return promise;
}

/** Events raised by the given document ids. `null` = the user cannot see financial events (render nothing); loading = `undefined`. */
export function useTraceEvents(ids: string[]): TraceEvent[] | null | undefined {
  const [events, setEvents] = useState<TraceEvent[] | null | undefined>(undefined);
  const key = ids.join(',');
  useEffect(() => {
    let live = true;
    loadTraceEvents().then((all) => {
      if (!live) return;
      if (all === null) return setEvents(null);
      const wanted = new Set(key ? key.split(',') : []);
      setEvents(all.filter((e) => wanted.has(e.sourceEntityId) || (!!e.payload?.depositId && wanted.has(e.payload.depositId))));
    });
    return () => {
      live = false;
    };
  }, [key]);
  return events;
}

/** Overall state of a document from its events: any rejection wins, then pending, then posted. */
export function overallState(events: TraceEvent[]): TraceState | 'none' {
  const states = events.map(traceStateOf).filter((s) => s !== 'ignored');
  if (states.length === 0) return 'none';
  if (states.includes('rejected')) return 'rejected';
  if (states.includes('pending')) return 'pending';
  return 'posted';
}
