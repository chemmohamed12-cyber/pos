/**
 * What caused a backup run to start — matches CTO directive's two
 * required modes plus a manual/ad-hoc trigger for testing and one-off
 * safety backups. `'pre_restore_safety'` (Phase B) is a distinct trigger
 * so it's traceable in backup history as "taken automatically right
 * before a restore overwrote the database" — the recovery path if that
 * restore itself goes wrong.
 */
export type BackupTrigger = 'scheduled' | 'pre_update' | 'manual' | 'pre_restore_safety';
