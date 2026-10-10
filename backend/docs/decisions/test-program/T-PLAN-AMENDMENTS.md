# T-PLAN amendments (append-only). A change to a frozen criterion is recorded here BEFORE the affected run, with reason and approver; it never alters a recorded result.

## A-1 — 2026-10-10 — database approval entry semantics (CTO decision "PHASE 6 DATABASE APPROVAL GATE")
- **Affects:** `T-PLAN-FROZEN-2026-10-10.md` §1 only (the proposed approval-entry JSON and its description). **No change** to any T-01…T-12 scenario, expected result, stop condition, or to R1–R10.
- **Reason:** CTO ruled that `databases: ["postgres"]` must not allow business tests to run against the PostgreSQL system database. The frozen §1 text listed `postgres` under `databases`.
- **Replacement (supersedes §1's JSON):** see `APPROVAL-ENTRY-PROPOSED.json` — `postgres` moves to a new field `adminDatabases` (administrative connections only; statements restricted to read-only SELECT/SHOW, transaction control, and the exact `CREATE DATABASE "<name>"` / `DROP DATABASE [IF EXISTS] "<name>" [WITH (FORCE)]` for names matching `^daii_test_biz_t[0-9]{2}[a-z0-9_]*$`), `databases` is empty, `rolePatterns` is empty (no role changes), and `expectedSystemIdentifier` is recorded.
- **Run environment change:** `DB_NAME` for harness-based runs is a pattern-matching placeholder `daii_test_biz_t00_unused` (never connected to), not `postgres` (the ambient configuration may no longer be an administrative database).
- **Approver:** CTO (decision text of 2026-10-10). **Effective before any run:** yes — no business test has been executed.
- **Verification of the amendment:** `tools/testing/db-guard-admin.test.js` (9 tests) and `docs/decisions/test-program/DISPOSABLE-DB-POLICY-2026-10-10.md`.

## A-2 — 2026-10-10 — environment: dedicated cluster on 127.0.0.1:5546 with a least-privilege test role (CTO "DAII Autonomous Testing & Verification" directive)
- **Affects:** the run ENVIRONMENT only (instance, port, role, approval entry). **No change** to any T-00…T-12 scenario, expected result, stop condition, or R1–R10.
- **Reason:** no authorised admin credential exists for the earlier candidate cluster on 5544, and the directive forbids assuming/extracting credentials. The agent therefore created its own dedicated cluster (`backend/tools/testing/biz-cluster-setup.js`): data directory `.test-cluster/pg5546/data` inside the project root and outside git, `listen_addresses=127.0.0.1`, port 5546, `pg_hba` = loopback + scram-sha-256 only. Passwords were generated in memory and persisted only as Windows User-scope environment variables (`DAII_BIZ_PG_PASSWORD`, `DAII_BIZ_PG_BOOTSTRAP_PASSWORD`); the facts file contains none.
- **Roles:** the test role `daii_biz_test` is `LOGIN CREATEDB` only (no superuser, createrole, replication, bypassrls) with `EXECUTE` on `pg_control_system()` for the read-only identity check. The bootstrap superuser exists only to create the cluster/role.
- **Approval entry:** `dedicated-5546-biz` (same shape as A-1: `postgres` administrative-only, pattern `^daii_test_biz_t[0-9]{2}[a-z0-9_]*$`, no role patterns) with `expectedSystemIdentifier` 7695079006474257732. The earlier 5544 proposal/diff is retained as `SUPERSEDED-*` records and is NOT approved.
- **Run environment:** `DB_HOST=127.0.0.1 DB_PORT=5546 DB_USER=daii_biz_test DB_PASSWORD=<User env> DB_NAME=daii_test_biz_t00_unused`.
- **Effective before any run:** yes — no business test had been executed.
