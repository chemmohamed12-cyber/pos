# Daii — UUID Repair Report

**Purpose (PART 2 §10 / §19 / §23 / §30):** the record of the Controlled
Data Repair that eliminates the legacy non-RFC4122 primary keys causing
`accountId must be a UUID` / `treasuryAccountId must be a UUID`.

**Status on the real staging DB: NOT YET RUN.** The repair *engine*,
*flow*, and *verification* are fully built and proven twice on an isolated
scratch PostgreSQL cluster (once scripted, once against a booted app).
The real staging execution is the operator's step per
`DATA_REPAIR_RUNBOOK.md`. **v1.0.3 is NOT functionally complete until that
run passes** (PART 2 §30).

---

## 1. Root cause (settled — see `UUID_BUG_ENDTOEND_TRACE.md`)

Not a code defect. `1755840100000-CreateUsers.ts` defined
`gen_random_uuid()` by hand (no pgcrypto / PG10) as
`md5(random()::text || clock_timestamp()::text)::uuid` → random version /
variant nibbles → ~92% of pre-fix rows fail `@IsUUID()`. Treasury/Deposit
resubmit a stored id from a dropdown through an `@IsUUID()` field → 400.

`1755852500000-FixGenRandomUuidRfc4122Compliance` (shipped in v1.0.3) fixes
**generation** only. This repair fixes the **existing rows**.

## 2. The repair (what runs)

`src/database/uuid-repair.core.ts` → `runUuidRfc4122Repair()`, driven by
`DataRepairService` (or the deferred migration). In ONE transaction:

1. Discover every FK touching a repaired table (`information_schema`),
   `ALTER … DEFERRABLE INITIALLY DEFERRED`, `SET CONSTRAINTS ALL DEFERRED`.
2. For each non-compliant `id`: allocate a fresh (now-compliant)
   `gen_random_uuid()`; update DB-enforced children, soft/hidden FK
   columns, discriminator-scoped polymorphic columns, `users`-shared PKs;
   then the row's own PK. Log `old → new` via `RAISE NOTICE`.
3. `SET CONSTRAINTS ALL IMMEDIATE` (forces the deferred checks NOW, so a
   consistency bug fails here, not at COMMIT — and clears pending trigger
   events so the next step can't hit SQLSTATE 55006).
4. `ALTER … NOT DEFERRABLE` (restore original constraint state).

**`SET CONSTRAINTS ALL IMMEDIATE` was added during the rehearsal** — the
`ALTER … NOT DEFERRABLE` step fails with *"cannot ALTER TABLE … pending
trigger events"* without it. **The copy of `RepairNonCompliantUuids.ts`
currently on the server predates this fix and will fail 55006 if run
as-is** — the v1.0.3-hardening delta replaces `tools/data-repair/`.

## 3. Controlled flow (the CTO's exact chain — PART 2 §10)

```
pre-repair pg_dump backup (verified: pg_restore --list parses it)
  → audit (read-only)                     — UUID_AUDIT_REPORT.md
  → plan mapping (read-only, reviewable)   — old → new, every new id RFC4122
  → link the verified backup to the repair (the gate: no verified backup → no repair)
  → execute (one transaction)
  → verify integrity (FK-orphan sweep + auth/role + zero-remaining re-audit)
  → application verification (the two flows)
  → keep the backup + mapping + repair record as Release Evidence — do NOT delete
```

`DataRepairService` records `auditResult`, `mapping`, `rowsRepaired`,
`integrityResult` on one `data_repair_runs` row.

## 4. Rehearsal results (isolated scratch cluster — NOT staging)

### 4a. Scripted (`rehearsal-evidence/`, `scratch-rehearsal.ts`)

| Step | Result |
|---|---|
| Legacy rows injected | 3 — `users`, `treasury_accounts`, `treasury_account_types` |
| Audit | 3 non-compliant PKs found |
| Mapping | 3 old→new, all RFC4122 (`04-mapping.json`) |
| Repair | 3 rows, one transaction (`05-applied.json`) |
| Integrity | **PASS** — 141 checks, 0 failures, 0 remaining non-compliant (`06-integrity.json`) |
| Row-count parity | identical before/after (`07-record-integrity.json`) — only ids changed |
| `@IsUUID()` on repaired id | accepted; old id still rejected |
| Restore/rollback | `pg_restore` → ids + counts back to pre-repair (`09-restore.json`) |

### 4b. Live-app (`rehearsal-evidence/10-live-app-endpoint-proof.md`)

| | Result |
|---|---|
| Legacy rows injected | 4 — `treasury_accounts` ×2, `treasury_account_types`, `users` |
| BEFORE — `POST /api/treasury/cash-in` | **400** `"accountId must be a UUID"` |
| BEFORE — `POST /api/deposits/:id/approve` | **400** `"treasuryAccountId must be a UUID"` |
| Repair | 4 rows, integrity PASS |
| AFTER — `POST /api/treasury/cash-in` | **201** — `TRS-IN-2026-000001`, `status:"posted"` (real ledger movement) |
| AFTER — `POST /api/deposits/:id/approve` | **201** — `status:"approved"`, treasury txn `TRS-IN-2026-000002` + `customer_ledger_entries` credit 1000 created |
| Full-DB census after all app activity | **0** non-compliant across all 52 tables |
| Restore/rollback | DB returns exactly to pre-repair state |

## 5. Regression guards (in CI, no DB)

- `src/database/uuid-repair.core.spec.ts` — broken vs fixed generator
  simulation (100% pass / 100% unique for the fix); repair ordering
  (constraint-defer → child updates → own PK → constraint-restore);
  soft-reference-inventory completeness.
- `src/foundation/release/data-repair.service.spec.ts` — repair refused
  without a linked verified backup; transaction wraps the repair; mapping
  recorded even on integrity failure.
- `.../treasury.controller.spec.ts` / `.../deposits.controller.spec.ts` —
  the DTOs must keep **rejecting** `0a066947-1794-9892-6816-35f51ddf72c0`
  and **accepting** a real UUID (the literal `"… must be a UUID"` strings).

## 6. Acceptance (cannot be marked done until ALL true on staging)

- [ ] pre-repair `pg_dump` taken + verified + retained as evidence
- [ ] audit run, non-compliant count recorded
- [ ] mapping generated + reviewed
- [ ] repair executed, `rowsRepaired` recorded
- [ ] `verifyUuidRepairIntegrity` → passed, 0 orphans, 0 remaining
- [ ] `POST /deposits/:id/approve` succeeds with a real repaired treasuryAccountId — **no UUID error**
- [ ] `POST /treasury/cash-in` succeeds with a real repaired accountId — **no UUID error**
- [ ] Login + `/api/health/deep` + frontend-bundle + migration state all green
- [ ] `pg_restore` of the pre-repair dump verified to bring the DB back (rollback proof)
