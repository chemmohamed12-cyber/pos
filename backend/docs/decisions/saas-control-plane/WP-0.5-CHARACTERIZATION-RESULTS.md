# WP-0.5a / b / c / d — Test-only Characterization Results

**Authorization:** WP-0.5a/b/c — AUTHORIZED TEST-ONLY (CTO, 2026-10-05). WP-0.5d (CD-1 characterization) — executed under the same test-only constraints because the CTO's CD-1 ruling required "a separate characterization first"; the CTO should confirm this reading (the spec is untracked; discarding it costs nothing).
**Constraints honored:** disposable real PostgreSQL databases only, **on the isolated instance (127.0.0.1:5544)**; no `daii_dev`, no shared dev server; no production code, migration or guard changed; new files untracked and uncommitted; databases dropped and **zero residue verified**; source hashes recorded; discoveries are findings, not fixes.

## 1. Evidence binding (Exact Source State / Hash / Test Run)

| Item | Value |
|---|---|
| Run | 2026-10-05 05:46:36 → 05:50:20, `jest --runInBand`, 4 suites, **17/17 tests PASS** |
| Executed from | a **pinned snapshot root** (copy of `src/` and `dist/` taken 05:40–05:41, `node_modules` junctioned) so no concurrent edit or rebuild by another workstream could alter the run |
| Snapshot anchor (sha256 over `src/**` + `dist/database/migrations/**`, 1,759 files) | `ba5a16beb64a497d33415974df11d9d2aa8c0181bb6ce080b68f4c83113044f1` |
| Live tree at 05:54 | **identical anchor hash**; no file under `src/` or `dist/database/migrations/` has an mtime after 05:41:30 (last `src` write 05:40:28) → no write occurred during the test window |
| Migration digests recorded by every spec at start and end | `src` `140cc986cd46b031`, `dist` `a2f3ffcf266621dd` (unchanged start→end) |
| Git HEAD | `4bb71f8391321b883b40145b2b5fb6c233048fa2` |
| Raw records | `evidence/wp05a.recorded.json` … `wp05d.recorded.json` |
| Residue | `[]` in all four, re-verified |

**An earlier attempt is INVALID EVIDENCE and is not used:** a first run from the live tree (05:35–05:38) failed in setup (`relation "user_roles" does not exist`) because the migration runner loads the **compiled `dist/database/migrations` at call time** and `dist` was rebuilt (directory mtime 05:38; the process that did it was not identified) during the run. Leftover databases from that attempt were mine and were dropped. Lesson recorded for all later work packages: the evidence manifest must cover `dist/database/migrations`, not only `src`.

The characterization is valid **for the anchored state only**. That state contains other workstreams' unratified edits (guards, Approval Engine, Event Engine, Plans); the tests exercise provisioning/migration/seeding/limit/permission code, not those edits, but the binding is to the whole anchored tree.

## 2. WP-0.5a — adding / removing a module on an existing Company database (closes Dossier F-11)

| Observation | Result | Class |
|---|---|---|
| Core-only Company, then re-run the migration pipeline with `['core','sales']` | **succeeds**; 23 sales migrations ran; `customers`, `sales_orders` created | REAL-PG VERIFIED |
| Existing data (roles 9, role_permissions 33, users 1, user_roles 1) | **unchanged** after the add | REAL-PG VERIFIED |
| Re-run with the same tags | **no-op** (0 pending) | REAL-PG VERIFIED |
| "Remove" the module (run with `['core']`) | **no-op — nothing reverted**; tables and data remain | REAL-PG VERIFIED |
| Module role templates on the existing Company | seeding adds 3 roles / 6 grants; the `admin` role gets 0 new grants (it already held every module root) | REAL-PG VERIFIED |
| Add `accounting` alone onto a core-only database (no `finance`/`sales`) | **succeeds** (41 migrations) — **the runner does not enforce module dependency closure**; closure is enforced only where tags are derived from a manifest | RECORDED FINDING |

**Meaning for DP-5/WP-5.2:** upgrade (add a module to a live Company) is technically feasible with the existing pipeline; downgrade is a data-retaining no-op at database level (access removal is entitlement-only). Dependency closure must be enforced by the caller.

## 3. WP-0.5b — `/limits` scope and Company limit editability (executes Dossier F-6)

| Observation | Result | Class |
|---|---|---|
| Platform `admin` passes the `/limits` edit guard with no Company context | yes (permission evaluated on the platform DB) | REAL-PG VERIFIED |
| A Company A administrator, as the route is wired (no Company context) | **denied** | REAL-PG VERIFIED |
| Same user **if** the route had Company A's context | **allowed** — the Company `admin` role (seeded by core migrations) holds `core.limit` | RECORDED FINDING (dormant authority) |
| `PUT /limits/profiles/:key` effect | row lands in the **platform** `limit_profiles`; Company A's `limit_profiles` stays empty | REAL-PG VERIFIED |
| Effect on Company A | platform cap of 1 → platform-side check `{allowed:false,max:1}`; Company A's check/consume (own database) → `{allowed:true,max:null}` **unlimited** | REAL-PG VERIFIED |
| `setProfile`/`clearProfile` signatures | no `manager` parameter (3 / 2 arguments) — **no Company-capable limit edit path at the service level** | VERIFIED |

**Meaning for DP-6:** a `/limits` edit has no effect on any Company, and every Company is unlimited today (confirmed by execution). If `/limits` ever gains Company context (Area 21), Company admins would hold the permission to edit — a dormant-authority risk for DP-4.

## 4. WP-0.5c — what the initial admin of a UI-created Company can do (**contradicts Phase-0 study finding F4**)

Flow executed: real `DatabaseProvisioningService`, `tags` omitted (every tag → 252 migrations ran), `roleModuleCodes` omitted (`[]`), no entitlement manifest → Company reached READY/ACTIVE.

| Observation | Result | Class |
|---|---|---|
| Three core Company nodes (`members.manage`, `backup.manage`, `audit.view`) | editable | REAL-PG VERIFIED |
| Module permissions | **34 of 34 sales nodes granted** — the `admin` role holds every module root (`accounting attendance commission finance hr inventory logistics manufacturing payroll procurement reporting sales targets`) **without any `roleModuleCodes`** | REAL-PG VERIFIED |
| Platform-style core nodes in the Company database | `core.limit.edit`, `core.entitlement`, `core.config`, `system.release` all **editable**; `core.approval`, `system.release.backup` also present | REAL-PG VERIFIED |
| Re-seed with `roleModuleCodes:['sales']` | **0 additional grants** — the input has no effect on the admin role | REAL-PG VERIFIED |

**Meaning:** the Phase-0 study's F4 ("a UI-created Company's admin receives no module permissions") is **false at runtime**; the core migrations hand the Company `admin` every module root plus platform-style nodes. Consequences for the dossier: (1) entitlement is the only module gate — a package that excludes a module **does not** remove the admin's permission nodes for it (consistent with ADR-055, but the grant is live wherever entitlement falls back to installation-wide: the 16 platform-scoped controllers); (2) plan→permission mapping is not "the missing input"; (3) dormant platform-style authority sits in every Company database (DP-4).

## 5. WP-0.5d / CD-1 — provisioning failure, reactivation bypass, decommission retention

| Topic | Observation | Class |
|---|---|---|
| Failure state | after a failed provisioning (bad admin id → stage `initial-admin`): Company `PROVISIONING`, registry `FAILED`, **absent from the visible list**, still found by id | REAL-PG VERIFIED |
| Resume | calling `provision()` again for the same Company with a valid admin **completes it** (READY/ACTIVE; now listed). The HTTP create route always makes a *new* Company row — no resume path via HTTP (code fact, not executed) | REAL-PG VERIFIED (service) / VERIFIED (code) |
| Reactivation bypass | `reactivate()` on the failed Company → status **READY** while registry stays **FAILED**; **it is listed as visible**; the guard then refuses access (`CompanyDatabaseNotActiveError`) | REAL-PG VERIFIED |
| Decommission | after suspend → decommission: status `DECOMMISSIONED`; **physical database still exists**; registry `ACTIVE`; credential row retained (1); membership retained (1); database still reachable (9 roles read) — no teardown, no retention policy | REAL-PG VERIFIED |

## 6. Findings produced (none fixed; each needs its own decision)

1. **FND-1** — Company `admin` roles hold platform-style `core.*`/`system.release` nodes and every module root (WP-0.5b/c). Dormant today; live if routes gain Company context.
2. **FND-2** — Phase-0 study F4 is contradicted by execution (§4).
3. **FND-3** — The runner does not enforce module dependency closure (§2).
4. **FND-4** — `/limits` edits affect only the platform database; every Company unlimited (§3).
5. **FND-5** — CD-1 behaviors confirmed (§5), including a failed-provisioning Company that can appear as READY and listed.
6. **FND-6** — Evidence hygiene: tests that use the migration runner depend on live `dist/`; manifests must cover it (§1).

## 7. Files created by this work (all untracked, test-only; none committed)

`src/foundation/testing/saas-characterization.helpers.ts` · `src/foundation/testing/saas-provisioning-kit.ts` ·
`src/foundation/database-provisioning/module-add-existing-company.characterization.spec.ts` ·
`src/foundation/limit-engine/limits-scope.characterization.spec.ts` ·
`src/foundation/database-provisioning/ui-created-company-admin.characterization.spec.ts` ·
`src/foundation/database-provisioning/provisioning-lifecycle.characterization.spec.ts` ·
(earlier) `src/foundation/company/company-suspension-access-path.characterization.spec.ts`.
The helper refuses to run unless `DB_HOST=127.0.0.1` and `DB_PORT=5544`.
