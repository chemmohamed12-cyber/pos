# Canonical shared development database (:5173) and session registry - 2026-10-19

Per CTO Master Directive section 5. Facts below were read from the running processes and configuration on 2026-10-19; no secret is recorded here.

## A. Identity of the stack behind :5173

| Item | Verified value |
|---|---|
| Browser entry | `http://localhost:5173` - Vite dev server, pid 17000, served from the **main checkout** `release-new/frontend` (branch `master` 5e41647 + uncommitted work) |
| API proxy | Vite proxies `/api` to `VITE_API_TARGET` (unset) -> default `http://localhost:3500` (`frontend/vite.config.ts`) |
| Backend | `node dist/main.js` pid 1696, run from the main checkout `release-new/backend` (built 2026-10-19 with the Stage D + Release Center code), env file `backend/.env`, global prefix `/api` |
| Platform database | **`daii_dev`**, PostgreSQL 18.6 at `localhost:5433` (user `daii`) |
| Company databases (registry `database_registries`) | Alpha `company_f3ea8a2e75814dd4b3f708e606a434f9`, Beta `company_0894c2a717f34fceaf6a299530ccf61f`, Delta `company_dfa1105448b84ad8b8ae8d7bd8719353`, Gamma `company_98d3391ce5464c63a3e9fab11e55263c` (all READY) |
| Relation to :3500 | **Same database.** :5173 has no database of its own; it reaches `daii_dev` only through the :3500 backend |
| Migration state | 307 migrations on the platform database and on each Company database; dry-run from the **integration** build (`integration/local-2026-10-16` after the merges) reports **0 pending** on all five (evidence: `dryrun-integration-dist.json`) |
| Test cluster (separate) | PostgreSQL on `127.0.0.1:5546` (pid 24104) - isolated test databases only; never the shared development database |

## B. Usage policy (as decided)
- Reference for shared-data integration checks, Inventory Lifecycle, PO / inventory-filter / BOM screens, Release Center upgrade-path checks that need development data, company isolation checks.
- It is **not** the release or production database. Isolated real-Postgres specs stay on 5546 and are not a substitute for shared-data checks (and vice versa).
- Rules: one schema-changing activity at a time (check the registry below first); record applied migrations and state before any schema change; test data must be clearly labelled; no manual balance repair; no table/data deletion without knowing which checks depend on it; clean temporary test data when safe. Demo state today: no warehouse documents, no stock movements, Alpha has no inventory control account (the reconciliation preview answers 409 by design).
- The main checkout (what :5173 and :3500 serve) is **not** the integration branch. Aligning it is a separate step (see the report): until then it carries the same lifecycle / Release Center code as integration but not the PO picker or item-name-guard changes.

## C. Session / resource registry (state at 2026-10-19, end of merge)

| Resource | Owner | Branch / path | Task | Status |
|---|---|---|---|---|
| Integration worktree | integration / main team (this session) | `integration/local-2026-10-16` (`.claude/worktrees/integration`) | merge + full release gate | gate running |
| Cluster 5546 | this session | regression then business suite from the integration worktree | full gate | **reserved** until the gate ends |
| Ports 3500 / 5173 | this session (backend), main checkout | main checkout | shared dev stack | running |
| Port 5433 (daii_dev) | shared | - | no schema change in progress | free |
| `feature/inventory-lifecycle` | integration | worktree `inventory-lifecycle` | merged | done |
| `feature/po-picker-hotfix` | fork session `local_43afe97d` | worktree `po-picker-hotfix` | merged | done |
| `feature/item-name-guard` | fork session `local_43afe97d` | worktree `item-name-guard` | merged | done |
| Environment cleanup (C: space, pagefile) | fork session `local_44db8299` | `_admin-scripts` | waiting for user permission | no test resources used |

Branch owners are told when their branch has been merged so nobody continues from a stale tip. Before any schema change on `daii_dev` or any use of 5546, the owner checks this table and updates it.
