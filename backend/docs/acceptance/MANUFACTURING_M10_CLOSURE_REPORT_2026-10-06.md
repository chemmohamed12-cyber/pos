# Manufacturing — Full Module Completion: M10 Closure Report (2026-10-06)

Directive: CTO MASTER DIRECTIVE — MANUFACTURING FULL MODULE COMPLETION. Authority for deltas: ADR-061 Addendum 1.
Rule honoured throughout: **no Manufacturing-specific entitlement/package/permission mechanism** — everything runs on
Package → Entitlement → Company Capability → User Permission → Effective UI.

## Verdict
**MANUFACTURING — FINAL CLOSURE (see section 7).** CTO ruling accepted the M10 functional verification; the single gate (existing-dev migration) was authorized and executed on 2026-10-06. The `wip` control-account item is Accounting-owned and tracked separately (7.5). Sections 1-6 are the original M10 report as written; section 5 gating item 1 is now closed by section 7.

## 1. Capability table (M1 → final)

| Capability | Backend/Entity | API | Permission | Company isolation | Package dep. | Frontend | Navigation | E2E | Status |
|---|---|---|---|---|---|---|---|---|---|
| Products ↔ manufacturing eligibility | derived: active BOM (A3), enforced at WO create; picker shows manufacturable products only | `POST /manufacturing/work-orders` 409 without active BOM | `manufacturing.work_order.create` | ✔ | module | WO create picker | – | master-data spec + browser | **EXISTS** |
| BOM / Recipes | `bill_of_materials.status` active\|inactive (additive), single store via `SALES_BOM_CONTRACT` | `/manufacturing/boms` list/get/create/replace/status/delete | `manufacturing.bom.{view,create,edit,delete}` | ✔ real-PG A/B | `manufacturing` ⇒ `sales`,`inventory` | list · search · create · edit · view · activate/deactivate · delete, unit shown | Manufacturing → Bills of Materials | browser ✔ | **EXISTS** |
| Assembly | `assembleProduct` (D5) unchanged | `POST /inventory/assemble` unchanged | `inventory.assembly.create` | ✔ | module | Assembly page: active-BOM picker, required-qty preview, reference | Manufacturing → Assembly | browser ✔ (ASM-2026-000001) | **EXISTS** |
| Routing / Operations | `routings`, `routing_operations`, `work_order_operations` (snapshot) | `/manufacturing/routings` + WO `…/operations/:id/start\|complete` | `manufacturing.routing.*`, `manufacturing.work_order.operation_execute` | ✔ real-PG A/B | module | Routings page; WO detail operations table | Manufacturing → Routings | browser ✔ | **EXISTS** |
| Work Centers | `work_centers` | `/manufacturing/work-centers` | `manufacturing.work_center.*` | ✔ real-PG A/B | module | Work Centers page (create/edit/activate/delete) | Manufacturing → Work Centers | browser ✔ | **EXISTS** |
| Work Orders (accepted slice) | unchanged lifecycle + routing snapshot + completion guard | existing 11 + 2 | existing 9 + 1 | ✔ | module; feature now structural (A5) | existing + operations section | Manufacturing → Work Orders | browser ✔ full lifecycle | **EXISTS** |
| WIP/FG/Costing/Accounting/Inventory | unchanged (ADR-061) | – | – | ✔ | – | – | – | phase3 e2e (self-seeded drift) | **EXISTS** — see `MANUFACTURING_INTEGRATION_MATRIX_2026-10-06.md` |
| Permission matrix beyond admin | role templates manager / operator / viewer | – | company-scoped | ✔ | – | – | – | real-PG matrix spec | **EXISTS** |
| Package / Entitlement | no new mechanism | – | – | ✔ | closure: `manufacturing` ⇒ sales, inventory | – | nav hidden when not entitled | downgrade/upgrade spec + browser | **EXISTS** |
| Quality · Subcontracting · Scrap · Variance · Labor/Overhead | – | – | – | – | – | – | – | – | **EXCLUDED by ADR-061 §21 / A7** (not gaps) |

## 2. Delivered (this directive)
- **Backend:** BOM status + manufacturing BOM facade; Work Centers; Routings; Work Order operation snapshot, in-sequence execution, opt-in completion guard; WO create requires active BOM; manifest v1.1.0 (nodes, structural feature, contract); role templates; 3 additive migrations (`1790000000000`, `…100000`, `…200000`).
- **Frontend:** BOMs, Routings, Work Centers, Assembly pages; operations section on WO detail; manufacturable-product + non-WIP-warehouse pickers; Cover links every area with master-data KPIs; server-driven navigation (5 items); Arabic + English terminology.
- **Docs:** ADR-061 Addendum 1, M1 audit, integration matrix, this report.
- **Tooling:** `backend/tools/maintenance/apply-manufacturing-master-data-migrations.js` — allow-listed (3 migrations only), dry-run default, requires `--backup` + `--evidence`, idempotent. Verified on an isolated copy.

## 3. Verification evidence
- **Typecheck/build:** backend `nest build` ✔ · frontend `tsc` + `vite build` ✔.
- **New real-PG specs (isolated PG :5544):** `manufacturing-master-data.company-isolation.spec` (14 behaviours: eligibility, BOM status, Work Centers, Routings, snapshot, sequence guard, completion guard, A→B deny, Test F) ✔ · `manufacturing-entitlement-permission.real-pg.spec` **11/11** (route coverage reflection: every Manufacturing route has module + registered permission node + PermissionGuard + correct access; dependency closure; Company A allowed / B denied; permission matrix manager/operator/viewer/none; **downgrade keeps data, roles, grants; upgrade restores**) ✔.
- **Regression:** Work Order specs (`work-order.spec`, `work-order-phase3-e2e` — the 2 formerly environment-dependent WIP assertions are now **self-seeded** by a controlled unposted-WIP-layer fixture), `work-order.company-isolation`, `bom.company-isolation` (7/7), navigation, module-registry, plans (incl. `company-packages.real-pg`), `wip-reconciliation` — see final run line in the hand-off message.
- **Browser acceptance (isolated stack: backend :3600 → `daii_test_ui_mfg` @ :5544, Vite :5180; two real Company DBs Factory Co/Shop Co):** created Work Centers CUT/PACK; BOM BIKE-01 (frame×1, wheel×2, units shown); Routing (10 Cut @CUT, 20 Pack @PACK); WO-2026-000001 ×5 — picker listed only the BOM product; release snapshotted components + operations; issue frame 5 / wheel 10 → WIP **900.0000** (= 5×120 + 10×30); starting op 20 first → server message *"Operation 10 must be completed before operation 20 can start"*; FG output 5 → WIP **0.0000**; Complete with open ops → *"2 routing operation(s) are not completed"*; ran ops 10→20; Complete → **Completed**; Assembly ×2 → ASM-2026-000001.
  Package downgrade (`shop`): `/manufacturing/*` **404** ×4, `/me/navigation` has no Manufacturing, **all 6 data tables + 3 role templates intact**; upgrade (`factory`): **200** ×4, identical row counts. Shop Co (never entitled): 404 and zero rows.

## 4. Findings fixed during acceptance
1. Warehouse pickers offered a Work Order's WIP sub-warehouse (`kind = operational`) — filtered out of WO create and Assembly.
2. Cover only linked Work Orders (hidden core features) — now links all five areas.
3. `bom.company-isolation.spec` exact-equality assertion needed the additive `unit` field.

## 5. Remaining gaps — exact
**Gating (formal CLOSED withheld):**
1. **Existing dev databases are not migrated.** `daii_dev` (:5433) and its company DBs (Alpha/Beta/Gamma/Delta) still lack the 3 migrations, so the running dev app (:3500, old build) cannot use the new screens. Tool + runbook are ready; I did **not** touch :5433 (shared server; needs your explicit go). Steps per DB: `pg_dump` → dry-run → `--apply --backup --evidence`; **do not** run a blanket `migration:run` (would also apply the unapproved D3 migrations 1789860000000/1789870000000).
2. **No `wip` control account in the `ifrs-sme` chart template.** A freshly provisioned Company that imports the template gets Manufacturing Financial Events **Rejected** with the clear reason *"no active postable account has controlFunction "wip""* (observed in browser; the isolated-DB provisioner adds account 1150 by hand). Manufacturing cannot post GL for a new Company until Accounting adds/assigns it. Accounting-owned (and gated by D10) — not changed here.

**Flagged, not Manufacturing-owned (no blocker to closure):**
3. `backend/src/database/enabled-modules.ts` `MIGRATION_TAGS` lists 6 tags and omits `manufacturing`, `accounting`, `procurement`, `payroll`, `attendance`, `commission`, `targets` — affects entitlement-driven migration selection for every one of them.
4. `inventory.assembly` feature flag in the Inventory manifest is dead (API never enforces it).
5. No client-side route guard platform-wide: a direct URL to a module page still renders its shell (API returns 404; nav hides it).
6. `perm.*` / `role.*` display titles are not seeded in terminology for any module (precedent kept).
7. WIP reconciliation / Closing Audit have no UI (Accounting scope).
8. Not exercised in a browser: an operator-role (non-admin) user session, mobile layout, per-page Arabic RTL review beyond Cover/nav. Operator/viewer behaviour is proven at the permission-engine level (real-PG) only.

## 6. Session isolation
Other sessions' uncommitted/committed work was never reverted. My M2/M3 backend core landed inside another session's commit `1517d81`; the remaining changes are exactly the files listed in the hand-off (all mine; shared files `navigation-registry.ts`, `App.tsx`, `bom.company-isolation.spec.ts` diffs contain only my lines). No D3, no Event Engine change, no production deployment, no `daii_dev` writes.


## 7. FINAL CLOSURE — dev migration gate (authorized by CTO ruling, 2026-10-06)
Sequence executed: BACKUP → DRY-RUN → EVIDENCE CHECK → APPLY (3 allow-listed migrations only) → POST-VERIFY → REGRESSION. No blanket
`migration:run`, no D3, no manual schema change, no production, no Accounting change. Evidence files: `C:\DAII-BACKUPS\manufacturing-rollout-20261006-074056\`
(mirrored to `D:\DAII-BACKUPS\…`): 5 `*.dump` (pg_dump -Fc, each verified with `pg_restore --list`), `evidence/state-pre.json`, `evidence/state-post.json`,
and one `*.manufacturing-master-data.evidence.json` per database.

### 7.1 Migration evidence (5 databases, :5433)
| Database | Role | Migrations before → after | Tables | Result |
|---|---|---|---|---|
| `daii_dev` | Platform | 249 → 252 | 172 → 176 | ✔ |
| `company_f3ea8a2e75814dd4b3f708e606a434f9` | Alpha Trading Co | 249 → 252 | 169 → 173 | ✔ |
| `company_0894c2a717f34fceaf6a299530ccf61f` | Beta Trading Co | 249 → 252 | 169 → 173 | ✔ |
| `company_98d3391ce5464c63a3e9fab11e55263c` | Gamma Trading Co | 250 → 253 | 169 → 173 | ✔ |
| `company_dfa1105448b84ad8b8ae8d7bd8719353` | Delta Trading Co | 251 → 254 | 172 → 176 | ✔ |

Each: exactly `AddBomStatus1790000000000`, `CreateRoutingAndWorkCenterTables1790000100000`, `SeedManufacturingMasterDataTerminology1790000200000`.

### 7.2 Post-migration verification
- **Diff pre/post (automated):** exactly +3 migration rows, +4 tables (`work_centers`, `routings`, `routing_operations`, `work_order_operations`), +1 column (`bill_of_materials.status`); row counts of **every other table unchanged** except `migrations` and `terminology_entries` (46 `mfg.*`/`nav.manufacturing_*` codes). `bill_of_materials`/`work_orders` stayed 0 rows. D3 migration state identical before/after in every DB.
- **Schema/entity:** compiled entities (WorkCenter, Routing, RoutingOperation, WorkOrderOperation, WorkOrder, WorkOrderComponent, BillOfMaterial) `SELECT` cleanly on all 5; `CHK_bill_of_materials_status` present and rejects an invalid status (test rolled back, nothing persisted); work-center code unique index present.
- **Application startup:** a separate instance on :3601 against migrated `daii_dev` booted with **0 errors**; `/api/manufacturing/{boms,routings,work-centers,work-orders}` → **401** (mounted, guarded), unknown route → 404. Instance stopped afterwards.
- **Entitlement (dev):** Alpha `full-suite` (includes manufacturing) · Beta, Delta `commerce-core` (no manufacturing → hidden/404 by package, by design) · Gamma no package (installation entitlement). Alpha's plan was changed by someone else during the day; reported as read.
- **UI on dev:** not driven — the dev admin credential is not available to this session and was deliberately not reset or bypassed. UI behaviour is evidenced by the isolated-stack browser acceptance (§3). **Action for the dev owner:** the running `:3500` process is the pre-rebuild binary (new routes still 404) — restart it, then smoke Manufacturing as Alpha/Gamma.

### 7.3 Regression result (isolated PG :5544, serial)
**39 suites / 300 tests passed, 0 failed** — manufacturing (isolation ×2, entitlement/permission, `work-order.spec`, `work-order-phase3-e2e`), commerce (BOM 7/7, products, price-lists), inventory-warehouse isolation ×3, navigation, module-registry, plans (incl. `company-packages.real-pg`), company (lifecycle, membership, area-6 acceptance), `wip-reconciliation`.

### 7.4 Exact implementation manifest
**Landed in commit `1517d81`** (another session's commit; includes this program's M2/M3 backend): `backend/docs/acceptance/MANUFACTURING_M1_SCOPE_AUDIT_2026-10-06.md` · `backend/docs/decisions/ADR-061-ADDENDUM-1-MANUFACTURING-COMPLETION-2026-10-06.md` (A4 note in `cc49e7d`) · migrations `sales/1790000000000-AddBomStatus.ts`, `manufacturing/1790000100000-CreateRoutingAndWorkCenterTables.ts` · `commerce/{application/bom.service.ts, infrastructure/bill-of-materials.entity.ts, interface/bom.controller.ts, interface/bom.company-isolation.spec.ts}` · `manufacturing/{application/{routing,work-center,work-order}.service.ts, application/manufacturing-wip-ledger.service.ts, infrastructure/{routing,routing-operation,work-center,work-order-operation}.entity.ts, interface/{manufacturing-bom,routing,work-center,work-order}.controller.ts, interface/work-order.company-isolation.spec.ts, manufacturing-company-entities.ts, manufacturing.module.ts}` · `foundation/module-registry/{contracts/sales.contract.ts, contracts/manufacturing-wip.contract.ts, manifests/manufacturing.manifest.ts, role-templates.ts}` · `frontend/src/pages/manufacturing/{WorkOrderDetail,WorkOrders}.tsx` (first part).
**Committed by this session (explicit paths only):** `navigation-registry.ts`, `frontend/src/App.tsx`, `ManufacturingCover.tsx`, `WorkOrderDetail.tsx` / `WorkOrders.tsx` (final), `Assembly.tsx`, `ManufacturingBoms.tsx`, `Routings.tsx`, `WorkCenters.tsx`, migration `1790000200000-SeedManufacturingMasterDataTerminology.ts`, specs (`manufacturing-master-data.company-isolation`, `manufacturing-entitlement-permission.real-pg`, updated `work-order-phase3-e2e`, `work-order.company-isolation`, `bom.company-isolation`), `tools/maintenance/apply-manufacturing-master-data-migrations.js`, the integration matrix and this report. The commit hash is given in the hand-off message.

### 7.5 Accounting `wip` dependency — status: OPEN, Accounting-owned, NOT a Manufacturing blocker
The `ifrs-sme` chart template has no active postable `wip` control account → a new Company's Manufacturing Financial Events are Rejected with an explicit reason until Accounting provides it. **Not fixed inside Manufacturing.** To be opened as **ACCOUNTING GAP — WIP CONTROL ACCOUNT**; Accounting decides: standard account code, `controlFunction = wip`, inclusion in the `ifrs-sme` template, provisioning/import behaviour, real-PG verification; evidence then returns to the Manufacturing integration matrix (#4, #5, #7). All Manufacturing work not requiring GL posting is complete and unaffected.

### 7.6 Remaining non-blocking findings (follow-ups, no re-opening)
1. **Pre-existing, found during this rollout:** Company DBs already contain the D3 migration rows (`AddManualReceiptCostAndReasonCode1789860000000`, `SeedManualReceiptTerminology1789870000000`) — Alpha/Beta 1 row, Gamma/Delta 2 — from original provisioning with the then-current code; the **platform** `daii_dev` does not. Not caused or changed by this rollout (state identical before/after). Needs the D3 owner to reconcile against the "D3 unapproved" ruling.
2. `enabled-modules.ts` `MIGRATION_TAGS` omits 7 tags (incl. `manufacturing`). 3. dead `inventory.assembly` flag. 4. no platform-wide client route guard. 5. `perm.*`/`role.*` terminology. 6. WIP reconciliation / Closing Audit UI. 7. mobile layout + full RTL review. 8. operator-role browser E2E (proven at real-PG permission level only). 9. `:3500` dev app restart needed to serve the new routes.
