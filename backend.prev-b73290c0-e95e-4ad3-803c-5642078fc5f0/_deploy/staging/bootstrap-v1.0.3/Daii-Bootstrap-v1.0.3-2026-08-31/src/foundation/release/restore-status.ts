/**
 * Release Center — Phase B (Restore). `'pending_confirmation'` is the
 * deliberate "not a one-click accidental action" gate the CTO directive
 * requires: `preflight()` creates the row in this state and nothing else
 * happens until a SEPARATE `confirmAndRestore()` call, within the
 * confirmation window, actually touches the database. `'expired'` means
 * that window passed without confirmation — the operation must be
 * re-preflighted, not silently resumed (the world may have changed).
 */
export type RestoreOperationStatus =
  | 'pending_confirmation'
  | 'expired'
  | 'running'
  | 'completed'
  | 'failed';
