# D4 — Configuration registry: backward-compatible, non-destructive sync (PROPOSAL — not implemented)

Status: **proposal for cross-team review.** Nothing in this document is implemented. The manufacturing UX program did not change `config-registry.seeder.ts`, the registry tables, or any configuration value (CTO directive: do not make a broad registry change incidentally; do not overwrite or restore archived values without verified intent/ownership).

## 1. Defect (T-M-01) — what is proven

`backend/src/foundation/configuration-engine/config-registry.seeder.ts` rebuilds `config_keys` from the code of the **running build** on every boot:

* keys present in code and not in the table → inserted;
* keys present in both but different → updated;
* **keys in the table that this build's code does not know → the `config_keys` row is DELETED and all its active `config_values` are ARCHIVED** (`archivedAt = now`).

Consequence on a database shared by backends of different versions: a build that predates a key (older registry, e.g. 64 keys) removes the key and archives its values when it boots; the newer build (69 keys) re-inserts the key on its next boot, **but the archived values are not restored**. The evidence is in the audit trail: `configuration.registry.synced` entries alternate between `total=64` and `total=69`, with `removed` lists naming the same keys (including `accounting.manufacturing_scrap_loss_account_code`). Observed effect during this program: the manufacturing scrap-loss account setting was found archived, so scrap posting would have been rejected (now surfaced as a blocking reason by D6).

Why it is dangerous beyond manufacturing: **any** configuration value of **any** team whose key is newer than the oldest backend that touches the shared database can be silently archived.

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
