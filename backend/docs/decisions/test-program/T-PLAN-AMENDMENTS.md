# T-PLAN amendments (append-only). A change to a frozen criterion is recorded here BEFORE the affected run, with reason and approver; it never alters a recorded result.

## A-1 — 2026-10-10 — database approval entry semantics (CTO decision "PHASE 6 DATABASE APPROVAL GATE")
- **Affects:** `T-PLAN-FROZEN-2026-10-10.md` §1 only (the proposed approval-entry JSON and its description). **No change** to any T-01…T-12 scenario, expected result, stop condition, or to R1–R10.
- **Reason:** CTO ruled that `databases: ["postgres"]` must not allow business tests to run against the PostgreSQL system database. The frozen §1 text listed `postgres` under `databases`.
- **Replacement (supersedes §1's JSON):** see `APPROVAL-ENTRY-PROPOSED.json` — `postgres` moves to a new field `adminDatabases` (administrative connections only; statements restricted to read-only SELECT/SHOW, transaction control, and the exact `CREATE DATABASE "<name>"` / `DROP DATABASE [IF EXISTS] "<name>" [WITH (FORCE)]` for names matching `^daii_test_biz_t[0-9]{2}[a-z0-9_]*$`), `databases` is empty, `rolePatterns` is empty (no role changes), and `expectedSystemIdentifier` is recorded.
- **Run environment change:** `DB_NAME` for harness-based runs is a pattern-matching placeholder `daii_test_biz_t00_unused` (never connected to), not `postgres` (the ambient configuration may no longer be an administrative database).
- **Approver:** CTO (decision text of 2026-10-10). **Effective before any run:** yes — no business test has been executed.
- **Verification of the amendment:** `tools/testing/db-guard-admin.test.js` (9 tests) and `docs/decisions/test-program/DISPOSABLE-DB-POLICY-2026-10-10.md`.
