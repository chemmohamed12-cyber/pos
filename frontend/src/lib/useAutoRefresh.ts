import { useCallback, useEffect, useRef, useState } from 'react';

export interface AutoRefresh {
  /** when the data on screen was last fetched successfully (null before the first success) */
  updatedAt: Date | null;
  /** true while a request is in flight */
  refreshing: boolean;
  /** the last refresh failed; the data on screen is the last successful one */
  stale: boolean;
  refresh: () => void;
}

const BASE_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Slice C1 (ADR-INV-10) - keeps a read-only screen current without a push channel. `load` is the screen's own fetch (it sets its own state and may throw).
 * It runs on mount, whenever `deps` change, when the tab becomes visible or the window regains focus, and every 30 s while the tab is visible.
 * Single-flight (a tick while a request is running is skipped); `load` receives `isCurrent()` so a response that belongs to an older `deps` generation is
 * discarded instead of overwriting newer data; after a failure the interval backs off (30 s, 60 s, ... capped at 5 min) and the last good data stays on
 * screen, flagged `stale`. It only reads - it never writes, retries or re-drives anything.
 */
export function useAutoRefresh(load: (isCurrent: () => boolean) => Promise<void>, deps: ReadonlyArray<unknown>): AutoRefresh {
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);
  const inFlight = useRef(false);
  const failures = useRef(0);
  const nextAllowed = useRef(0);

  const run = useCallback(async (force: boolean) => {
    if (inFlight.current) return;
    if (!force && Date.now() < nextAllowed.current) return;
    const mine = generation.current;
    inFlight.current = true;
    setRefreshing(true);
    try {
      await loadRef.current(() => generation.current === mine);
      if (generation.current === mine) {
        failures.current = 0;
        setStale(false);
        setUpdatedAt(new Date());
      }
    } catch {
      failures.current += 1;
      nextAllowed.current = Date.now() + Math.min(BASE_INTERVAL_MS * 2 ** (failures.current - 1), MAX_BACKOFF_MS);
      setStale(true);
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    generation.current += 1; // a filter change makes any older response stale
    failures.current = 0;
    nextAllowed.current = 0;
    inFlight.current = false;
    void run(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void run(false);
    };
    const timer = window.setInterval(tick, BASE_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [run]);

  const refresh = useCallback(() => void run(true), [run]);
  return { updatedAt, refreshing, stale, refresh };
}
