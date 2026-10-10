# Daii Backup, Recovery & Upgrade Architecture

Status: **ACCEPTED (ADR-020).** Stage 1.1 Final Closure item F.

---

## 1. Backup

| Asset | Cloud | On-Premise/LAN | Frequency |
|---|---|---|---|
| PostgreSQL database | Managed-service automated snapshots, or `pg_dump` to object storage | `pg_dump`/`pg_basebackup` to local/attached/network storage | Daily minimum; more frequent for high-write tables at scale (a later tuning decision, not a V1 architecture gap) |
| Object storage (media) | Provider-native versioning/cross-region replication | Scheduled filesystem sync to secondary storage | Continuous (versioning) or daily (sync), per deployment target |
| Configuration/secrets | Backed up alongside deployment infrastructure-as-code, never inside the application database | Same — configuration is not "just another table," it's operational metadata backed up through deployment tooling | Alongside deployment changes |

## 2. Restore

- A documented, versioned restore runbook exists per deployment target — restore is only "supported" once it has been exercised end-to-end at least once per major deployment topology (Cloud, On-Premise), not merely assumed to work because the backup mechanism is standard.
- Restore targets a specific point in time (PITR where the backup mechanism supports it) — "restore to last night's backup" is the minimum bar; finer granularity is a deployment-specific tuning decision.
- **Exercised live, freshly, this release cycle** (not just the earlier V1-era exercise in `planning/v1-release/`) — `pg_dump -Fc` of the working dev database, `pg_restore --no-owner` into a fresh scratch database, row counts compared and matched exactly on every table checked. Full detail and the exact commands: `MASTER_PROJECT_STATUS.md` §8b. **Audited and deliberately kept operational, not turned into a self-service in-app feature** — building create/list/restore-with-confirmation/RBAC/audit-trail as an admin UI would reverse the "no backup automation... implemented here" decision below, not close a gap in it; that remains a real future scope item once actual on-premise packaging work is underway, not something this release cycle needed.

## 3. Integrity Verification

- Post-restore, a verification pass checks: row counts against pre-restore expectations (where known), foreign-key integrity (enforced by Postgres itself per `DAII_DATA_ARCHITECTURE.md` §5), and **Audit Engine hash-chain continuity** — walking the chain from genesis confirms no record was lost or altered by the backup/restore cycle. This is a free, strong integrity signal specifically because ADR-012 already made the audit log tamper-evident for an unrelated reason (security) — Stage 1.1 recognizes the same property also serves backup verification.

## 4. Pre-Upgrade Backup

Every schema migration in every environment is preceded by an automatic backup checkpoint, enforced by the deployment pipeline (Cloud) or the upgrade runbook (On-Premise) — not left to operator discipline alone. This directly closes the risk class `baseline`'s TD-29 numbering defect represents: a destructive/irreversible-feeling operation (in that case, a backup restore; here, a schema migration) proceeding with no safety net.

## 5. Schema/Version Compatibility

- Migrations within a release are additive/backward-compatible wherever possible (new nullable columns, new tables) — old application code continues to run correctly against a migrated schema during a rolling deploy.
- Breaking changes (column removal, type changes affecting existing data) require a documented multi-step migration path (expand → migrate data → contract), never a single migration that could fail halfway and leave the schema in an undefined state relative to the running application version.

## 6. Rollback Strategy

- **Primary:** roll forward with a corrective migration (`DAII_DATA_ARCHITECTURE.md` §6) — the default for the vast majority of issues found post-deploy.
- **Fallback (last resort):** full restore from the pre-upgrade backup checkpoint (§4) — reserved for a migration that has caused data corruption a corrective migration cannot cleanly fix. This is a deliberate choice not to rely on down-migrations as the primary rollback path, since down-migrations are rarely exercised in practice and are a common source of their own bugs precisely because they're untested.

## 7. Recoverable Application State

Application processes hold no durable state outside Postgres and object storage (state lives in the database/outbox, not in-process memory) — a direct consequence of the outbox pattern (ADR-012) and the explicit rejection of in-memory-only persistence anywhere in the architecture (ADR-003, ADR-012). A crashed or restarted process resumes correctly because nothing durable was ever only in its memory to begin with — this was already true by design before ADR-020 named it explicitly as a recovery property.

## 8. What This Document Does Not Do

No backup automation, restore scripts, or migration tooling are implemented here — per Stage 1.1's explicit constraint that no On-Premise product is built now. This is the strategy Stage 2's Foundation build order (`planning/stage-2/STAGE_2_BUILD_ORDER.md`) implements operationally as Daii's own deployment infrastructure matures.
