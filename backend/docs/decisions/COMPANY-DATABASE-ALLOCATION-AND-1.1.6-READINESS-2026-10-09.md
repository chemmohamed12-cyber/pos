# Company database allocation, audit chain, retention — 1.1.6 readiness (2026-10-09)

Status vocabulary: IMPLEMENTED / VERIFIED (isolated PostgreSQL) / OPEN. Nothing here was deployed or run against production.

## 1. Company creation on the shared host

**Confirmed (host `stderr.log`):** `no pg_hba.conf entry for host "127.0.0.1", user "xnexdrgr_daii_app2", database "postgres", SSL off`, raised by `createPhysicalDatabase` (`company-registry.controller.ts`, now replaced by `company-database-allocator.ts`).
**Not established:** whether the role holds `CREATEDB`; whether cPanel permits any non-panel database creation. Neither can be tested without host access.

### Design
`COMPANY_DB_MODE=create|pool` (default `create`, unchanged behaviour).

| Mode | Source of the database | Needs |
|---|---|---|
| create | `CREATE DATABASE` via `COMPANY_DB_MAINTENANCE_DATABASE`, optionally with a dedicated role (`COMPANY_DB_ADMIN_USER/PASSWORD`) | pg_hba access to the maintenance DB and CREATEDB |
| pool | pre-created EMPTY databases listed in `COMPANY_DB_POOL` | databases created in cPanel, the application role granted access |

Pool claim rules: not already in `database_registries` (any status), reachable with the application's credentials, zero tables. A non-empty database is never used.

### Durability and concurrency
- "Assigned" is derived from the persistent `database_registries` table, so a restart cannot hand a database out twice (proved by booting a fresh application instance over the same control-plane DB).
- Allocation + Company row run in one in-process critical section. **Limit:** a single Node process. Passenger with several workers could race; the registry's unique `companyId` does not prevent two Companies naming one database. If the host runs >1 worker, add a unique index on `database_registries."databaseName"` (needs an approved migration) — OPEN decision.

### Failure behaviour
| Failure | Result | Left behind |
|---|---|---|
| initial admin user unknown | 400, checked **before** anything is allocated | nothing |
| maintenance DB unreachable / no CREATEDB | 422 `COMPANY_DATABASE_CREATION_FAILED` | nothing |
| pool empty / exhausted | 422 `COMPANY_DATABASE_POOL_EXHAUSTED` with per-database reasons | nothing |
| migration / role-seeding fault after allocation | 422 with `stage`, `companyId` | Company `PROVISIONING`, registry `FAILED`, the pooled database stays assigned to **that** Company |

The last row is deliberate: the database may be partially migrated, so it is not recycled automatically (no destructive reset). It is resumed with `POST /api/installation/companies/:id/retry-provisioning` (same Company, same database, no new allocation; only for `PROVISIONING` Companies). Abandoning such a Company is an operator decision and needs an approved cleanup plan.

### Evidence (isolated PG 5544)
- `company-database-allocation.http.real-pg.spec.ts` (6): pool claim order, non-empty/unreachable skipped, exhaustion, retry, concurrent requests, create-mode failures, admin-role path.
- `company-database-pool.full-flow.real-pg.spec.ts` (2): real control plane, real provisioning (full Company migrations — >50 tables, roles seeded, initial admin, health check, READY) through HTTP; restart durability; exhaustion; unknown admin leaves nothing; failure after allocation then resume with same Company/DB.
- Not simulated: cPanel's own pg_hba/ownership model. The resume test uses a limited role to reproduce "cannot create objects".

### What the operator must do on cPanel (verification needed)
1. Create N empty PostgreSQL databases in cPanel; grant the application user ALL privileges (it must be able to create schema objects and, for `uuid-ossp`, `CREATE` on the database).
2. Set `COMPANY_DB_MODE=pool` and `COMPANY_DB_POOL=["<db1>","<db2>"]` in the Node application's environment; restart.
3. Confirm the granted user can `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` there — the migrations and the application run it.

## 2. Audit chain
- **Confirmed on daii_dev (read-only):** `audit_records` seq 13 and 14 share `prevHash` (both chained onto seq 12) — a fork from concurrent writers. `FOR UPDATE` on the head row is not enough: the waiting writer is handed the same, now stale, row.
- **Fix:** `pg_advisory_xact_lock` before reading the head. `audit-chain-concurrency.real-pg.spec.ts`: 40 concurrent writers => linear, verifiable chain; the old behaviour fails the same test (mutant).
- Existing forked chains (daii_dev seq 14) are **not** repaired. No historical record was touched.
- **Production break at seq 1 — cause UNKNOWN.** It is not this race (a fork breaks at the second writer, not at record 1). Hypotheses, none verified: (a) records written by a release before the key-sorted hash fix (SEC-10) cannot be verified by the current verifier; (b) a manual recovery in September altered or truncated the first rows; (c) genesis mismatch. Read-only queries to run on the host (no writes):

```sql
SELECT count(*) AS n, min(seq) AS first_seq, max(seq) AS last_seq FROM audit_records;
SELECT seq, "timestamp", action, left("prevHash",16) AS prev16, left(hash,16) AS hash16,
       ("prevHash" = repeat('0',64)) AS prev_is_genesis,
       jsonb_typeof(before) AS bt, jsonb_typeof(after) AS at
FROM audit_records ORDER BY seq LIMIT 5;
SELECT a.seq, (a."prevHash" = b.hash) AS links_to_previous
FROM audit_records a JOIN audit_records b ON b.seq = a.seq - 1 WHERE a.seq <= 20 ORDER BY a.seq;
```
Please send the output. No repair will be proposed before it is analysed, and none executed without explicit approval.

## 3. Backup retention
- **Confirmed:** retention deleted backup files before the database rows; a run referenced by `releases.backupRunId` then failed on the FK, leaving the backup without files.
- **Fix:** a referenced run is never a candidate; DB records are removed before files; a failure is isolated to that run and logged. `backup-manager.retention.spec.ts` (3).
- Related: `reconcileInterruptedDeploys` wrote the string `'system'` into a uuid column (host log 12:40) — now `NULL`, test added.
- **Already-damaged backups on the host** (files gone, rows present) are not detected or repaired by this change. OPEN: read-only audit of `backup_runs` vs files.

## 4. The 503 after 1.1.4
New evidence: the host environment list shows `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/`INTEGRATION_ENCRYPTION_KEY` far shorter than the 32 characters the schema demands when `NODE_ENV=production`, and no `NODE_ENV`. If the application really runs with `NODE_ENV` unset (=development), the production-only rule "DATABASE_CREDENTIAL_ENCRYPTION_KEY required" (hypothesis H1) did **not** apply, so H1 is **weakened, not disproved** (cPanel/Passenger may inject NODE_ENV outside this list). The cause remains unconfirmed; needed: the cPanel "Application mode" value and the Passenger/`stderr.log` lines around the 1.1.4 swap.

**Security note (separate):** the pasted environment contains real secrets in clear text. Treat `JWT_*` and `INTEGRATION_ENCRYPTION_KEY` as exposed and rotate them in a planned window (JWT rotation logs everyone out; rotating `INTEGRATION_ENCRYPTION_KEY` or `DATABASE_CREDENTIAL_ENCRYPTION_KEY` makes already-encrypted stored values unreadable — do **not** change those two without a re-encryption plan). Running with short secrets also means the host is not in production mode, which disables the production config checks.

## 5. Open items
- Authorization Foundation final closure report: NOT written (separate work; known results HR 21/21, closure HTTP 23/23, security/mutation 40/41, scoped-perf gate failed +62% p95).
- F-7 (verify the restored app over HTTP after a rollback), UI surfacing of `DEPLOYED_UNVERIFIED`, merge/push of `release-company-fanout`, unique index on `database_registries."databaseName"` if multi-worker.
