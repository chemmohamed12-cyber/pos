# Manufacturing — Phase M1 Scope & Architecture Audit (2026-10-06)

Baseline: Work Orders vertical slice (ADR-061, backend `a1c929c`, frontend `466c026`) + uncommitted Area 21 company-scoping on top (other session; **not touched/reverted**).
Authority for deltas: `ADR-061-ADDENDUM-1-MANUFACTURING-COMPLETION-2026-10-06.md`.

## Capability matrix (status BEFORE this program)

| Capability | Backend/Entity | API | Permission | Company isolation | Package/Entitlement | Frontend | Nav | E2E/regression | Status |
|---|---|---|---|---|---|---|---|---|---|
| Products ↔ manufacturing eligibility | no field (derived from BOM) | none | – | n/a | – | none | – | none | **MISSING** (derived indicator + WO-create validation) |
| BOM / Recipe | commerce `bill_of_materials`/`bom_components` (flat, int qty, no status) | `/bom` GET/GET/POST/DELETE (sales module) | reads **unguarded**; writes `sales.catalog.edit` | YES (Area 21, uncommitted) | `sales` module | `Bom.tsx` (edit-in-row, no read view/search/status) | Catalog group, admin-role only | `bom.company-isolation.spec` | **PARTIAL** |
| Assembly | `assembleProduct` D5-remediated | POST `/inventory/assemble` | `inventory.assembly.create` | YES | `inventory`; feature flag declared but **dead** | panel inside MovementCenter only | none of its own | none specific | **PARTIAL** |
| Routing / Operations | none | none | none | – | – | none | – | none | **MISSING** (ADR-061 A1) |
| Work Centers | none | none | none | – | – | none | – | none | **MISSING** (ADR-061 A1) |
| Work Orders | `work_orders`/`work_order_components` | 11 handlers | 9 nodes | YES | module + feature (off by default) | list/detail/cover | server nav, feature+perm gated | 2+9+8 specs | **EXISTS** (feature axis to remove — A5) |
| WIP / FG / Costing / Accounting | F08 pooled cost, 3 financial events, `wip` control fn | – | – | YES | – | trail on detail | – | phase3 e2e, wip-reconciliation 6 | **EXISTS** |
| Month-End WIP reconciliation | `WipReconciliationService`, `MANUFACTURING_WIP_CONTRACT` | accounting `wip` ctrl | `accounting.wip.*` | YES | – | **no UI** (accounting-owned) | – | 6 specs | **EXISTS (backend)** — UI is Accounting's scope, flagged |
| Quality / Subcontracting / Scrap / Variance | none | none | – | – | – | – | – | – | **EXCLUDED** (ADR-061 §21, D2/D3) — documented, not built |
| Role templates (non-admin roles) | none for manufacturing | – | only `admin` | – | – | – | – | – | **MISSING** |
| Package-engine integration tests (entitle/downgrade/upgrade) | module registered in manifests | – | – | – | engine generic | – | – | none manufacturing-specific | **MISSING (tests)** |

## Findings that drive the plan
1. Manufacturing is already a first-class Package-Engine module (manifest in `ALL_MODULE_MANIFESTS`, `depends_on: sales,inventory` → closure applied by `PlanService`). **No registration step and no new mechanism needed**; the work is (a) removing the dead second axis (feature flag), (b) adding nodes to the manifest, (c) tests.
2. New Company-DB tables arrive only via migrations (`runMigrationsForDatabase`, reads compiled `dist/`); new companies get them automatically, **existing company DBs need an explicit additive rollout** (M9).
3. Frontend gating is server-driven (`/me/navigation`); new pages need nav-registry items (module + permissionNode), routes, terminology, and graceful 404 handling — no new client capability mechanism.
4. Real gaps in current slice: BOM reads unguarded; `createWorkOrder` does not validate product/BOM; WO UI actions are state-gated only; `inventory.assembly` flag dead; no `perm.*`/`role.*` terminology for manufacturing.
5. Latent (not Manufacturing-owned, flagged): `database/enabled-modules.ts` `MIGRATION_TAGS` omits `manufacturing`.

## Phase plan (CTO execution order)
M2 master data (BOM→Assembly→Routing/Operations→Work Centers) · M3 Work Order integration (routing snapshot, operation execution, completion guard, create validation) · M4 inventory/WIP/FG/costing verification · M5 integrations matrix · M6 permissions + isolation · M7 package/entitlement tests incl. downgrade/upgrade · M8 navigation/UI · M9 full regression, real-PG, browser · M10 closure.
