/** Overall status of a BackupRun (one logical backup event, up to two artifacts). */
export type BackupRunStatus = 'running' | 'completed' | 'failed' | 'partially_failed';

/**
 * Status of one physical BackupArtifact. `'completed'` means the file was
 * written; `'verified'` means it was ALSO independently checked (exists,
 * correct size, correct checksum, and — for a database artifact — its
 * internal structure is readable by pg_restore) — the CTO directive's own
 * "a backup must not be considered valid simply because the file was
 * created" requirement. Never skip straight from 'pending' to 'verified'.
 */
export type BackupArtifactStatus = 'pending' | 'completed' | 'failed' | 'verified' | 'verification_failed';

/** DB vs. media backup — kept as separate artifacts per ADR-020 §1's explicit split, not one bundled file. */
export type BackupArtifactType = 'database' | 'media';
