# Daii — UUID Audit Report

**Purpose (PART 2 §10 step 2 / §23):** the read-only census of
non-RFC4122 primary keys, the affected tables, and the FK / soft-reference
dependency graph the repair must update.

**Status on the real staging DB: NOT YET RUN** (no server/DB access in this
workstream). The census below is the *tooling + method*, proven on an
isolated scratch cluster. The operator runs the real census as **step 2**
of `DATA_REPAIR_RUNBOOK.md`, immediately after the pre-repair backup.

---

## 1. How to run the real audit (read-only, safe on production)

Option A — SQL only (no app, no Release Center needed):
```bash
PGPASSWORD=… psql -h 127.0.0.1 -U xnexdrgr_daii_app2 -d xnexdrgr_daii_staging \
  -f release-new/backend/tools/data-repair/uuid-audit.sql
```

Option B — via the Release Center once it is deployed:
```
POST /api/release/data-repairs   {"kind":"uuid_rfc4122"}
  → creates a data_repair_run, runs auditNonCompliantUuids(), returns auditResult
GET  /api/release/data-repairs/:id
```

Both use the **same** strict check — the one `class-validator`'s `@IsUUID()`
enforces:

```
^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
                          ^version 1-5      ^variant 8/9/a/b
```

## 2. Expected result shape

Per-table: `{ table, totalRows, nonCompliantRows, sampleNonCompliantIds[] }`
plus `totalNonCompliant` and a `zeroBaselineCleanupAdvised` flag (true only
if the *business* tables carry a large share — advisory, never triggers a
cleanup).

**Scratch-cluster rehearsal (representative, not the real numbers):**

| Scenario | non-compliant found |
|---|---|
| Scripted rehearsal (`rehearsal-evidence/03-audit.json`) | 3 — `users`, `treasury_accounts`, `treasury_account_types` |
| Live-app rehearsal (`rehearsal-evidence/10-live-app-endpoint-proof.md`) | 4 — `treasury_accounts` ×2, `treasury_account_types`, `users` |

On the **real** staging DB the expected pattern is: **every row of every
PK table created before `1755852500000` ran** is a candidate, ~92% of
which fail the check (the pre-fix `md5(...)::uuid` generator passes only
~7.7% by chance — `src/database/uuid-repair.core.spec.ts` re-derives this).
Rows created *after* that migration (e.g. the seeded MAIN-CASH account, if
the seed migration ran post-fix) are already compliant and are left
untouched.

## 3. Affected-scope inventory (fixed, from the exhaustive schema audit)

Encoded in `src/database/uuid-repair.core.ts` and re-checked live by
`verifyUuidRepairIntegrity()`:

| Category | Count | Handling |
|---|---:|---|
| PK tables (`gen_random_uuid()` / `uuid_generate_v4()` default) | **52** | `PK_TABLES` — each non-compliant `id` rewritten |
| Shared-PK tables (id == `users.id`) | 3 | `SHARED_PK_FROM_USERS` — rewritten in lockstep with `users` |
| DB-enforced FK constraints | 47 | auto-discovered via `information_schema`, made `DEFERRABLE` for the txn |
| Soft FK columns (uuid, no constraint) | ~90 | `SOFT_REFERENCES` (hardcoded from the audit) |
| Hidden FK columns (VARCHAR storing an id) | ~12 | `SOFT_REFERENCES` with `text: true` |
| Polymorphic id columns | 3 | `POLYMORPHIC_REFERENCES` — rewritten only where the discriminator matches |
| JSON/JSONB embedding ids (`audit_records`, `event_outbox`, …) | 4 | **deliberately NOT rewritten** — point-in-time history |

## 4. Verification that the audit is complete

`src/database/uuid-repair.core.spec.ts` asserts every `SOFT_REFERENCES`
target is itself an audited `PK_TABLE` (no dangling map entry).
`verifyUuidRepairIntegrity()` runs an FK-orphan sweep across **all** of the
above (DB-enforced + soft + hidden) after the repair — on the scratch
rehearsal that was **141 checks, 0 failures, 0 remaining non-compliant**
(`rehearsal-evidence/06-integrity.json`).

## 5. What the audit does NOT decide

Whether to run `ZeroBaselineCleanup`. That stays a separate, manual
decision (`DATA_REPAIR_RUNBOOK.md`) — the audit only *flags* it as advised
or not; it is never run automatically as part of the UUID repair.
