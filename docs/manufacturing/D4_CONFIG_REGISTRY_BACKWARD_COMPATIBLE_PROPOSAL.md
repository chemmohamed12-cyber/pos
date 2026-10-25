# D4 — Configuration registry: backward-compatible, non-destructive sync (PROPOSAL — not implemented)

Status: **proposal for cross-team review.** Nothing in this document is implemented. The manufacturing UX program did not change `config-registry.seeder.ts`, the registry tables, or any configuration value (CTO directive: do not make a broad registry change incidentally; do not overwrite or restore archived values without verified intent/ownership).

## 1. Defect (T-M-01) — what is proven

`backend/src/foundation/configuration-engine/config-registry.seeder.ts` rebuilds `config_keys` from the code of the **running build** on every boot:

* keys present in code and not in the table → inserted;
* keys present in both but different → updated;
* **keys in the table that this build's code does not know → the `config_keys` row is DELETED and all its active `config_values` are ARCHIVED** (`archivedAt = now`).

Consequence on a database shared by backends of different versions: a build that predates a key (older registry, e.g. 64 keys) removes the key and archives its values when it boots; the newer build (69 keys) re-inserts the key on its next boot, **but the archived values are not restored**. The evidence is in the audit trail: `configuration.registry.synced` entries alternate between `total=64` and `total=69`, with `removed` lists naming the same keys (including `accounting.manufacturing_scrap_loss_account_code`). Observed effect during this program: the manufacturing scrap-loss account setting was found archived, so scrap posting would have been rejected (now surfaced as a blocking reason by D6).

Why it is dangerous beyond manufacturing: **any** configuration value of **any** team whose key is newer than the oldest backend that touches the shared database can be silently archived.

### Evidence re-verified on 2026-10-25 (read-only query of `audit_records`, action `configuration.registry.synced`, 148 rows since 2026-10-04)
Every sync with `removed > 0` is a **64-key build booting after a 68/69/71-key build**, and it is always followed within minutes-to-hours by a larger build re-adding the same keys:

| removal (UTC) | `total` after | keys removed |
|---|---|---|
| 2026-10-21 07:16 | 64 | 4 purchase-cost keys |
| 2026-10-21 16:10 | 64 | those 4 + `accounting.treasury_receipt_reason_accounts` + 2 more treasury keys (7) |
| 2026-10-24 18:57 | 64 | 4 purchase-cost keys |
| 2026-10-24 20:37 | 64 | 4 purchase-cost keys + **`accounting.manufacturing_scrap_loss_account_code`** |
| 2026-10-24 22:53 | 64 | the same 5 |
| 2026-10-25 10:27 | 64 | the same 5 (a 64-key build was running on the shared database this morning) |

Two archived `config_values` rows for the scrap-loss key exist today (set 2026-10-24 21:16Z and 23:55Z by the shared demo admin account); both are archived and **were not restored**. Since 2026-10-25 10:52Z (this build) no sync has removed anything. Other teams' keys (purchase cost, treasury reasons) were removed by the same mechanism — the defect is not specific to manufacturing.

## 1b. Related finding — nine keys reported as `changed` at EVERY boot (investigated 2026-10-25, read-only)

Every backend boot writes a `configuration.registry.synced` audit row with `changed: 9` even when nothing changed (`added: 0`, `removed: 0`, `total: 69`). Cause, reproduced with the compiled seeder's own `composeSources()/toRow()/rowEquals()` against the live `config_keys` rows:

* `rowEquals` compares `allowed` with `JSON.stringify(a.allowed) === JSON.stringify(b.allowed)`. PostgreSQL `jsonb` returns object keys in its own normalised order (`{"max":60,"min":3}`), while the code declares them as `{ min, max }`. The two strings never match for the **nine keys that declare a `{min,max}` range**: `core.security.rate_limit.auth_per_minute`, `core.security.session_idle_minutes`, `core.config.cache_reload_seconds`, `core.approval.request_ttl_hours`, `core.approval.expire_sweep_interval_min`, `accounting.allow_backdated_manual_journal_days`, `inventory.reservation_hold_minutes`, `logistics.remittance_grace_days`, `logistics.sales_return_eligibility_window_days`.
* It is **not** caused by two backends running concurrently: the entries line up with every restart of one backend, and `total` has been 69 with `removed: []` since this build started (the earlier 64 → 69 step, `added: 5`, is the older build being replaced by this one).
* (`core.config.org_scope_enabled`'s `flagRemoveBy` also differs when read with a raw driver; through the ORM both sides are the same `date` string, so it is not among the nine in the audit rows.)

**Effect:** each boot rewrites nine `config_keys` rows with identical meaning and appends one audit row (hash-chain growth + noise). **No configuration value is touched** (only `config_keys` rows are updated, never `config_values`). **Risk:** the constant noise makes a *real* registry change harder to spot in the audit trail — the same row would also carry a genuine `removed` list, which is the T-M-01 signal.

**Not changed here.** Proposed (for the independent D4 package): compare `allowed` with an order-insensitive canonical form, add a test that two consecutive boots of the same build write no audit row (already in §4, test 2).

## 2. Operational safeguard (in force now, no code)

* Only one backend version (a build whose registry is a superset of every key in use) may run against a shared database. Never run an older and a newer build concurrently or alternately on the same database.
* Before starting a build on a shared database, compare its `total` with the last `configuration.registry.synced` audit row; a smaller total means it would archive values.
* Do not "restore" archived values by hand unless the intended value and its owner are verified (an archived value may be a stale or superseded one).

## 3. Proposed change (backward compatible)

### 3.1 Sync becomes additive; deletion becomes an explicit, audited maintenance action
1. `sync()` only **upserts** keys known to the running build. Keys it does not know are **left untouched** (row and values).
2. Add a nullable `introducedInBuild` / `lastSeenBuild` pair on `config_keys` (additive migration, default NULL) written on upsert, so every row records which build last vouched for it.
3. Removal of a key that no build in the fleet uses any more becomes an explicit command (`config:registry:prune --key <k> --confirm`) that (a) refuses while any active value exists unless `--archive-values` is passed, (b) writes an audit row naming the actor and reason, (c) never runs at boot.

### 3.2 Version compatibility guard
* Store a monotonically increasing `registry_version` (the number of keys alone is not enough) in a single-row table. A build whose own `registry_version` is **lower** than the stored one must not write to `config_keys` at all (read-only, logs a warning once) — it can still serve requests with the keys it knows.
* The Release Center / engine already knows build versions; it should surface "registry newer than this build" as a visible warning.

### 3.3 Value safety
* Archival of a `config_value` only through the configuration engine's own API (user action or explicit prune), never as a side effect of boot.
* A value whose key row is missing (because a rolled-back deployment removed the row) is treated as **dormant**, not archived; re-inserting the key re-activates it.

## 4. Required tests (all must exist before merge)

1. **Fleet simulation (real PostgreSQL):** boot seeder A (subset, 64 keys) and seeder B (superset, 69 keys) alternately against one database, three rounds each; set a value for a key only B knows; after every boot assert the value is still active, the key row still exists, and no `removed` entry is audited.
2. **Idempotency:** two consecutive syncs of the same build produce an identical table and no audit row.
3. **Downgrade is read-only:** a build with a lower `registry_version` performs no `config_keys` write and keeps every value active.
4. **Prune is explicit and audited:** prune refuses a key with active values without `--archive-values`; with it, values are archived (not deleted) and an audit row names actor + reason.
5. **No behaviour change for unchanged builds:** existing configuration-engine specs pass untouched.

## 5. Rollout and cross-team implications

* Additive migrations only (two nullable columns, one single-row table); no existing column changes meaning.
* Every team that adds a config key benefits: a stale build can no longer destroy their value.
* Teams must keep the operational safeguard until the change is released everywhere, because already-deployed older builds still contain the destructive seeder.
* Environment isolation: tests above run on the isolated PostgreSQL test cluster, never on a shared development database.

## 6. Explicitly out of scope here
Changing any configuration value, restoring archived values, altering key definitions, or touching accounting policy semantics.
