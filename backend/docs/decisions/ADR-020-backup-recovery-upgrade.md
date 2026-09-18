# ADR-020 — Backup, Recovery & Upgrade Strategy

**Status:** ACCEPTED (architecture) — no backup/upgrade tooling is built in V1 beyond what Stage 2's Foundation build order requires operationally
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_BACKUP_RECOVERY_UPGRADE_ARCHITECTURE.md`

## Context

Both `baseline` and `xnexus-website` have JSON-file/ZIP-based backup engines (Class D per the extraction matrix — concept referenced, mechanism rejected). Neither addresses schema/version compatibility or rollback, because neither has real migrations. Daii's move to PostgreSQL (ADR-003) and its future On-Premise target (ADR-019) both require a real backup/recovery/upgrade strategy that doesn't yet exist in any source.

## Decision

Daii adopts standard, boring, proven mechanisms rather than inventing new ones: `pg_dump`/`pg_basebackup`-family logical/physical backups for the database, versioned object-storage/filesystem sync for media, forward-only schema migrations with a mandatory pre-migration backup step, and integrity verification (restore-test, not just backup-completion) as a required operational practice, not an optional one.

## Consequences

- **Database backup:** automated logical backups (cloud: managed-service snapshots or `pg_dump` to object storage; on-prem: `pg_dump`/`pg_basebackup` to local/attached storage) on a defined schedule, per deployment target.
- **Media backup:** object-storage versioning/replication (cloud) or scheduled filesystem sync (on-prem) — media backup is tracked separately from DB backup since they're different failure domains.
- **Restore:** documented, tested procedure — restore is not considered supported until it has actually been exercised, not just theoretically possible.
- **Integrity verification:** a restored backup is verified against a checksum/row-count/hash-chain-continuity check (the Audit Engine's hash-chain, ADR-012, gives a strong, free integrity check specifically for the audit table — a broken chain after restore is immediately detectable).
- **Pre-upgrade backup:** every schema migration is preceded by an automatic backup checkpoint — this directly closes the class of risk `baseline`'s numbering-desync defect (TD-29) represented (a destructive operation with no safety net).
- **Schema/version compatibility:** migrations are additive/backward-compatible within a release; breaking changes require a documented migration path, never a silent schema change assumed compatible.
- **Rollback strategy:** roll-forward with a corrective migration is the primary strategy (`DAII_DATA_ARCHITECTURE.md` §6); a full restore-from-pre-upgrade-backup is the fallback of last resort, not the primary rollback mechanism (avoids relying on down-migrations that are rarely exercised and often broken in practice).
- **Recoverable application state:** application processes are stateless where possible (state lives in Postgres/object storage, not in-process) so a crashed/restarted process resumes correctly — this is a natural consequence of the outbox/durable-queue decisions already made (ADR-012), not new scope.
