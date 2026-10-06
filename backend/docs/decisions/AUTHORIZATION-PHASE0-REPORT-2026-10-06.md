# Authorization Phase 0 — Preparation Report (read-only) — 2026-10-06/07

**Phase 0 produces evidence only. No code, schema, migration or data mutation was made. No push. Production = HOLD. `daii_dev` was not touched.**
Evidence base: source scans of `backend/src` and `frontend/src`; SELECT-only queries on the **isolated** environment (control plane `bv_cp` + three READY Company DBs, PostgreSQL 127.0.0.1:5656); read-only GET timing on the isolated backend (3601). Reproducible tools: `backend/docs/decisions/phase0-tools/` (`p0-scan.js`, `p0-db.js`; the DB tool refuses a shared database without an explicit CTO authorization). Detailed tables: `AUTHORIZATION-PHASE0-APPENDICES-2026-10-06.md` (Appendices A–E).

**Limits of this evidence (stated up front):** the isolated environment is small (3 READY Companies, 4 memberships, 2 identities) and was built for verification; it is a *rehearsal* dataset, not the real estate. The real shared environment (`daii_dev`, and later production data) has **not** been inspected — doing so needs a CTO decision (§14); the read-only tools are ready to run there.

**Stop-condition check (CTO rule):** *cross-Company exposure, Protected-Baseline regression, privilege escalation, business-policy ambiguity → STOP → REPORT.* Phase 0 found **no new regression and no exploitable escalation**, but it did surface items the CTO must see **now** (they are reported, not worked around, and are covered by the Blueprint phases): **F-1** the ambient Organization tree is readable by any authenticated user (AZ-03, already known); **F-2** a Company admin can attach *any existing identity by UUID* to the Company without that user's consent, and the 404/201 difference is a UUID-existence oracle (low exploitability, real design gap — Blueprint §3/§21 I8); **F-3** tenant-type endpoints still live outside the Company plane (integrations, media — new findings AZ-13/AZ-14). None changes a decision already approved; all need CTO acknowledgement at Gate closure.

---

## 1. Legacy Role Mapping

Source: Appendix A (89 true role call-sites in 22 backend files), Appendix B (107 frontend usages in 43 files), live grants from the Company DBs. Per legacy key: what it is today, what it holds, where it is checked, and the **proposed** mapping (Map → Dual-check → Migrate → Retire; nothing is removed in Foundation).

| Legacy key | Real meaning today | Grants held (DB) | Call-sites (BE) | FE uses | Proposed mapping |
|---|---|---|---|---|---|
| `admin` | all-powerful bypass: ambient = platform super-admin; Company = module-wide `editable` on every entitled module + `core.company.*` + platform nodes | 22 grants incl. `core.config/entitlement/limit`, `system.release*` | **67** (bypass in sales orders, shipment, returns, fulfilment, warehouse tx, customers REVIEWER, media, scope; `@RequireRole` on 9 controllers; nav) | 79 | Ambient → `platform_super_admin`. Company → **new** `company_admin` (administration authority) for *new* Companies; existing rows relabelled **"Legacy Administrator (Operational)"** (type `legacy`, grants unchanged). Bypass sites → capability `*.override` per domain via `hasLegacyOrCapability`. |
| `sales_rep` | workflow designation (creates/submits orders); also assigned by `SalesService` when a rep is created | 1 (`inventory.reservation.create`) | 4 (+ `SALES_REP_ROLE`) | 8 | template `sales.rep` + workflow capability `sales.order.submit` / `.resubmit`; rep designation stays a *role assignment*, not a permission |
| `sales_supervisor` | workflow approver: sales-order supervisor stage; returns authorize; shipment | **0** (authority is the key itself) | 12 | 1 | workflow capabilities `sales.order.supervisor_approve/_reject`, `returns.authorize`, `logistics.shipment.supervise` |
| `sales_manager` | workflow approver: manager stage; price override; customers REVIEWER | 3 (`sales.customer.assign/edit`, `sales.price_list`) | 10 | 13 | `sales.order.manager_approve/_reject`, `sales.order.price_override`, `sales.customer.review` (+ keep the 3 node grants) |
| `warehouse_worker` | executes fulfilment/picking/returns receiving; shipment board viewer | 5 (`inventory.assembly/movement/reservation/transaction/stock_count`) | **20** | 8 | `inventory.fulfillment.execute`, `inventory.transaction.submit`, `returns.receive`, `logistics.shipment.board.view` (+ keep node grants) |
| `warehouse_supervisor` | warehouse-transaction approve / post / reverse / recall | **0** | 9 | 4 | `inventory.transaction.approve/post/reverse/recall` (new nodes; `reverse` becomes Critical) |
| `inventory_controller` | warehouse-transaction submit / approve / post / recall; stock counts | 1 (`inventory.stock_count`) | 9 | 4 | same capabilities as above, minus `reverse` |
| `finance` | finance module + released-order edit + shipment reviewer + customers REVIEWER | 7 | 5 | 7 | role = template `finance.*` (module `finance`); `sales.order.released_edit`, `logistics.shipment.review`, `sales.customer.review` as workflow capabilities |
| `driver` | nav-only (`/shipments`) | **0** | 1 | — | `logistics.shipment.view_own` |

Observations that drive the mapping: (a) **three legacy keys hold zero grants** (`sales_supervisor`, `warehouse_supervisor`, `driver`) — their authority is *only* the key; they cannot be modelled as node roles and need **workflow capabilities** (Blueprint §14); (b) every legacy bypass is `admin`-or-X, so the dual-check helper must treat `admin` (legacy) as satisfying the capability to keep today's behaviour; (c) legacy keys are **seeded into every new Company** (Fresh Co 3/4 were born with all 9) — compatibility, not drift.

**Sign-off needed (per key):** the capability names above are proposals; the CTO/owners confirm before F5.

## 2. Permission → Capability Mapping

Appendix D classifies the 209 nodes (206 + 3 `COMPANY_*` constants) into **View / Manage / Authorize / Critical** bundles per resource and risk: **critical 19 · sensitive 61 · low 115 · platform-critical 7 · platform-read 4**. Heuristic — every row is reviewable. Gaps found (input to F3): treasury has one module-wide node `finance`@`editable` (reads need `editable`; view/cash-in/cash-out/transfer/reverse inseparable); no export nodes outside reports/accounting; templates missing for procurement, payroll, attendance, commission, targets, treasury; workflow-stage duties have **no node at all**; `reverse` exists only for journals.

## 3. Role / Grant Drift Report (isolated environment)

| Check | Result |
|---|---|
| Code templates (`MODULE_ROLE_TEMPLATES`) vs seeded grants, per Company | **0 drift** in Verify Co (29 roles/78 grants), Fresh Co 3 (20/54), Fresh Co 4 (20/54) — templates are intact, none "customized" |
| Ambient vs Company catalog (same role key) | Expected, **structural** differences only: Company `admin` additionally has `core.company.{audit.view,backup.manage,members.manage}`; for Companies whose package lacks a module (Fresh Co 3/4: no hr/logistics/manufacturing/reporting/attendance/commission/payroll/targets) the ambient catalog still holds those roles/grants while the Company catalog does not — i.e. **the ambient catalog accumulates every module's templates regardless of entitlement** (the boot seeder) and is not an authority source for Company routes |
| Company roles carrying platform nodes | `admin` holds `core.config`, `core.entitlement`, `core.limit`, `system.release`, `system.release.backup` — new finding **AZ-15** (not used by Company routes; must not be copied into `company_admin`) |

Drift rule going forward: the Phase-0 SQL (`p0-db.js`) is the drift detector; run it per Company before every migration step.

## 4. Membership / Role Inconsistency Report

* Control-plane memberships (`roleKey`) vs Company `user_roles`: **0 inconsistencies** across the 4 memberships / 3 READY Companies; **no orphan** Company `user_roles`; **no** identity without a membership; **no** identity without an ambient role.
* **Structural inconsistency by design (will appear as soon as multi-role exists):** membership holds **one** `roleKey`; Company `user_roles` can hold several; the last-admin guard counts admins from the **membership mirror**, not the Company DB. Both are addressed by Blueprint §4.1/§4.4 (Company DB becomes source of truth; guard moves to the Company DB).
* Two Companies are in `PROVISIONING` with a **FAILED** registry entry (Fresh Co, Fresh Co 2): they have no memberships and are never operational — recorded so migrations skip them explicitly.
* The `users` table exists in Company DBs through schema parity; production code never writes it; `bv_co` holds 2 rows (no production code path inserts them — origin is the verification setup; Fresh Co 3/4 have 0). Not an authority source.

## 5. Ambient Organization Data Inventory

Isolated environment: ambient `org_units` **0**, `org_memberships` **0**, `scope_assignments` **0**; Company DBs: org units **0** and org memberships **0** in all three; Company `scope_assignments`: Verify Co 1 (`sales_order`), others 0. **Nothing to migrate here.** The real estate (`daii_dev`/production) is unknown → CTO decision §14. Reminder (audit, corrected): org-unit scope is enforced only for treasury accounts; Company-side org units can currently only be created through the ambient controller, so Company org tables are effectively empty everywhere.

## 6. Platform Authorization Inventory

Appendix C: 12 controllers (77 routes) outside the Company plane plus the installation controllers, each with current guard and proposed `platform.*` node. Summary: **platform authority = one ambient role (`admin`)** guarding `installation/*`, `release`, `plans`, `admin`, `integrations`, `organization` writes; node-gated (ambient) controllers: `config`, `limits`, `entitlement`, `release` (both role *and* node). Ambient admins observed: both test users. New findings: **AZ-13** `integrations/*` (15 admin-only routes + QR intake) are tenant-type functionality in the ambient plane; **AZ-14** `media` (upload/download, JWT only, admin check in the controller) is outside the Company plane; the `admin/sales-reps` route is a Company concept served from the ambient catalog.

## 7. `hasRole()` Migration Inventory

Appendix B: **107 usages in 43 files** — render gates 61, derived flags 19, other 13, logic branches 5, role-list displays 9. Literals: `admin` 79, `sales_manager` 13, `sales_rep` 8, `warehouse_worker` 8, `finance` 7, `inventory_controller` 4, `warehouse_supervisor` 4, `sales_supervisor` 1. Source of the roles: `/auth/me` → **ambient** roles (AZ-02). Proposed migration order (to confirm in F1): administration and approval screens first, then procurement/treasury, then sales/warehouse, then the rest; each row converts to `can(capability)`.

## 8. Hard-coded Role Call-site Inventory (backend)

Appendix A: **89 true call-sites / 22 files** (after filtering module-code and node-name uses of `finance`/`sales_rep`): `admin` 67 · `warehouse_worker` 20 · `sales_supervisor` 12 · `sales_manager` 10 · `inventory_controller` 9 · `warehouse_supervisor` 9 · `finance` 5 · `sales_rep` 4 · `driver` 1. Heaviest: `navigation-registry.ts` 16, `integrations.controller.ts` 15, `sales-orders.service.ts` 11, `shipment.service.ts` 8, `returns.service.ts` 7, the two action→roles maps (`order-action-roles.ts`, `warehouse-transaction-action-roles.ts`), `admin.controller.ts`. Each is a unit of F5 work with its own regression matrix.

## 9. Role Template Classification

Per Company (isolated): **Verify Co** — 1 system (`admin`), **20 template** (accounting 2, finance 3, hr 2, inventory 3, logistics 3, manufacturing 3, reporting 1, sales 3), **8 legacy** (driver, finance, inventory_controller, sales_manager, sales_rep, sales_supervisor, warehouse_supervisor, warehouse_worker), 0 custom. **Fresh Co 3 / Fresh Co 4** — 1 system, **11 template** (accounting 2, finance 3, inventory 3, sales 3), 8 legacy, 0 custom. `customized` (grants ≠ template) = **0** everywhere. Note the key `finance` (legacy, 7 grants) coexists with template roles `finance.manager/clerk/viewer` — name collision to resolve in the template catalog (display names, not keys). Classification rule for migration: `admin`→system (alias `company_admin`/legacy admin per §10), template keys→`template@v1`, the 8 legacy keys→`legacy`, anything else→`custom` (none today).

## 10. Company-Admin Critical-Permission Analysis

Appendix E. **A Company admin today reaches all 19 Critical operational nodes** (journal reverse, fiscal-period reopen, AR/AP/cash/fixed-asset/inventory adjustments, closing-exception resolve, fixed-asset post, invoice cancel, supplier-invoice void, employee terminate, stock-count adjust, return adjust, BOM/routing/work-center delete, payroll approve + disburse) because the role holds module-wide `editable`. It also holds 11 platform-plane nodes (AZ-15).
**Conflict found between amendments A2 and "no silent permission loss":** 67 hard-coded `admin` literals make `admin` load-bearing; tightening it in place would change sales-order, shipment, returns, fulfilment and warehouse behaviour. **Recommended resolution (for the CTO Gate, decision D17):** introduce `company_admin` as a *new* system role key for new Companies; keep the existing `admin` rows verbatim as "Legacy Administrator (Operational)" in existing Companies; migrate the `admin` literals to capabilities (F5) before any Company retires the legacy role; enforce the anti-self-elevation rule in Role Management from day one. Net effect: no existing admin loses anything; new Companies get the tightened model immediately; narrowing existing Companies becomes a deliberate, audited Company action.

## 11. Authorization Performance Baseline (isolated backend, current build, single client, 30 samples/endpoint after warm-up)

| Endpoint (guard chain) | p50 ms | p95 ms | max ms |
|---|---|---|---|
| `/health` (none) | 2.6 | 4.1 | 4.2 |
| `/auth/me` (JWT + ambient roles) | 7.7 | 11.6 | 75 |
| `/memberships` (Company + 1 node) | 8.4 | 12.8 | 13.9 |
| `/accounting/accounts` (Company + module + node) | 9.7 | 11.3 | 11.8 |
| `/sales-orders` (Company + module, no node) | 9.8 | 13.0 | 13.1 |
| `/procurement/purchase-orders` (Company + module + node) | 8.6 | 11.4 | 13.8 |
| `/approvals/requests` (Company + node) | 8.4 | 10.7 | 20.8 |
| **`/me/navigation`** (Company roles + 57 node checks) | **93.8** | **168.2** | 173.3 |

Reading: the authorization overhead on a normal guarded request is small (≈ 6 ms above the unguarded health call, in line with ~5–6 indexed queries: membership, Company, then roles → role ids → grants). **The one hot path is `/me/navigation`: ~10× slower**, because `NavigationService` runs one `hasAtLeast` (3 queries) for each of the 57 permission-gated registry items — measured ≈ 172 statements per call, matching 57 × 3. The Blueprint's request-scoped `AuthorizationContext` (§22) fixes this *first*, and `/auth/me` capabilities/preview would otherwise multiply it. Caveats: single local client, small dataset; the generic per-statement counter I tried (database transaction counters) was unreliable apart from the navigation case and is **not reported**. **Proposed acceptance budget (CTO to confirm):** guarded endpoints not above baseline p95 + 25 %; `/me/navigation` and the new `/auth/me` must be ≤ baseline (target materially lower) once the request-scoped context lands.

## 12. Final Verification Matrix

| # | Scenario | Phase | Preconditions / data | Environment | Evidence | Pass criterion |
|---|---|---|---|---|---|---|
| V1 | Alpha admin sees/changes only Alpha users; never Beta | F2 | two Companies, overlapping identities | isolated + real-PG A/B spec | spec + browser | response set ⊆ Alpha members; Beta ids absent in API and UI; direct id access to a Beta member → 404 |
| V2 | One identity, two Companies, different roles | F2 | identity in A (Finance Mgr) and B (Sales Mgr) | real-PG + two browser sessions | spec + browser | each Company authorizes only by its own role set |
| V3 | Union / most-permissive; no deny grants | F2/F3 | user with 2 roles | unit | unit | effective = union; level = max |
| V4 | Company admin cannot create/suspend Companies, edit packages, read another Company, manage platform | F4 | `company_admin` token | real-PG + browser | spec | every platform route → 404/403; no cross-Company data |
| V5 | Platform admin without membership cannot read Company data; support access is time-boxed + audited | F4 | platform super-admin token | real-PG | spec | 403/404 without membership; allowed with support membership until expiry; audit rows in both DBs |
| V6 | Entitlement ON/OFF/downgrade | F3 | package change on a canary Company | real-PG + browser | spec + browser | OFF: capability absent from `/auth/me`, editor, preview, route denied; ON: templates created unassigned, **no other user's access changes**, `company_admin` gets only administration nodes; downgrade keeps grants dormant, re-enable restores |
| V7 | Scope pilot: list/detail/create/edit/approve/post/reverse/report/export — in/out of scope, multi-unit, descendants | F6 | 2 branches, 2 warehouses, scoped users | real-PG + browser | spec + browser | in-scope allowed, out-of-scope hidden/404/denied on every operation; **no scope applied outside the 4 pilot domains** |
| V8 | PR/PO maker ≠ checker + approval matrix unchanged; `PolicyService` equals legacy decisions (shadow) | F5/F6 | PR/PO, approval request types | real-PG | spec | zero disagreement in shadow run; ESC-3 tests green |
| V9 | `/auth/me` contract, `can()` parity, legacy `roles` unchanged; **forged/stale `/auth/me` grants nothing** | F1 | stale and tampered claims | contract tests + API | tests | schema valid; backend ignores any client-claimed capability (Zero Trust) |
| V10 | Legacy compatibility: capability diff before/after = ∅ for every user | F3–F5 | snapshot of effective access per user before each step | real-PG | diff report | **no user loses an ability** (STOP otherwise) |
| V11 | Audit completeness + hash-chain verification | F2–F4 | every catalog event | real-PG | spec | all events written with actor/company/target/before/after/context; chain verifies |
| V12 | Template lifecycle: offered, never auto-applied; customized untouched; new-module role unassigned | F3 | template v2 | real-PG | spec | as stated |
| V13 | Role editor: dependency completion; delegation limit; **self-elevation blocked**; last-admin protected | F3 | `company_admin` + role editor | real-PG + browser | spec + browser | cannot add a Critical capability to own/held roles; cannot remove last admin |
| V14 | Effective Access Preview ≡ guard decisions | F6 | sampled (user, action, resource) | property test | test | 100 % agreement over the sample |
| V15 | No identity enumeration in invite flow; **no consent-less attach by UUID** | F2 | existing/non-existing e-mails and ids | API tests | tests | identical responses; attach requires acceptance |
| V16 | Performance vs §11 baseline | F1+ | same harness as §11 | isolated | benchmark | within budget; `/me/navigation` ≤ baseline |
| V17 | Branding: no platform brand on tenant documents; platform brand configurable | N1 | Company profile | browser | browser | tenant prints show Company identity |
| V18 | **A/B isolation for every new endpoint** (hard criterion) | all | two Companies | real-PG A/B spec | spec | passes before a phase is accepted |
| V19 | Protected Baseline regression (NAV-02…14, ESC-3, D1–D10, T0, PRC-01, D7–D9, CUS-01, FA-02, INV-03, journal numbering) | all | affected-area suites | real-PG | suites | green on first run; failures individually explained |

Mapping to the CTO's 12 acceptance questions: Blueprint Addendum C, with V-ids above.

## 13. Migration / Rehearsal Plan (no execution in Phase 0)

1. **Environment:** the isolated `bv_*` set (3601/5601/5656) is the rehearsal target; one fresh Company per rehearsal is provisioned through the official path so the starting state is realistic. No rehearsal touches `daii_dev`.
2. **Order of rehearsal per phase:** *snapshot* (existing backup facility / `pg_dump` of control plane + Company DB) → *expand* (additive schema) → *backfill* (idempotent, reconcile-never-overwrite) → *shadow* (new decision beside old, disagreements logged) → *canary flag* on **one** Company → capability-diff report (V10) → *verification matrix* → *rollback drill* (flag off, previous build) → document.
3. **Canary order:** Fresh Co 3 (smallest) → Verify Co (richest data) → Fresh Co 4 (clean re-check).
4. **Gates inside a rehearsal:** hash-chain verification before/after audit changes; capability-diff ∅; A/B isolation specs; performance budget; STOP on any cross-Company result.
5. **Data classes to rehearse:** identity+membership; role classification; legacy→capability mapping; ambient org rows (synthetic, since none exist); scope assignments (synthetic); package change (module OFF/ON).
6. **Rollback drills are mandatory** and recorded (flag-off, schema ignored, mirror fields intact, legacy role rows retained).
7. **Real-estate rehearsal** (`daii_dev` clone) happens only after the CTO authorizes a read-only clone/inventory (§14).
8. **Independent project (A7):** DAII operational-data migration (D14) has its own plan and gate; none of the steps above include it.

## 14. Items for the CTO at Architecture-Gate closure

1. **Acknowledge F-1/F-2/F-3** (§ header) and AZ-13/AZ-14/AZ-15 (new findings; they are folded into F1/F2/F4 scopes, listed below).
2. **D17:** resolve A2 ↔ "no silent permission loss" by the new-key approach (§10).
3. **Real-estate inventory:** authorize either (a) a **read-only inventory run of `phase0-tools/p0-db.js` against a clone/snapshot of `daii_dev`**, or (b) the CTO/ops run it and share the JSON — needed before F2 data migration is designed in detail (ambient org rows, real role/grant drift, real membership consistency, number of real admins).
4. **Performance budget** proposal (§11).
5. **Capability names** (§1) and **risk classification** (§2) sign-off owners.
6. **D16** (second approver for Critical grants): Phase 0 suggests *not* mandatory in Foundation (explicit-holder rule + audit is sufficient; add second approval as a policy option in Expansion).

## 15. New / amended findings from Phase 0

| ID | Finding | Folded into |
|---|---|---|
| AZ-13 | `integrations/*` (connectors, mappings, publish, logs; QR intake) are tenant-type functions served from the ambient plane (admin-only) | F1/F4 classification: Company-scoped or explicit platform-only |
| AZ-14 | `media` upload/download served from the ambient plane (JWT only, admin check in-controller) | F1 classification |
| AZ-15 | Company `admin` role carries platform nodes (`core.config/entitlement/limit`, `system.release*`) | F3/F4 (excluded from `company_admin`) |
| AZ-16 | `/me/navigation` ≈ 172 statements/call (57 gated items × 3); 10× a normal guarded request | F1 (request-scoped `AuthorizationContext` first) |
| AZ-17 | New Companies are born with all 9 legacy role keys; Company DB `users` table parity | compatibility note (§1c, §4) |
| AZ-18 | Company admin can attach any existing identity by UUID without consent; 404-vs-201 is an existence oracle | F2 (invitation + acceptance, uniform responses) |
| Corrections | treasury is gated by one module-wide node (not hard-coded roles); org-unit scope is enforced for treasury accounts | audit/inventory/Blueprint updated |

## 16. Phase 0 conclusion

Deliverables 1–13 are produced (sections 1–13 + appendices). The evidence **confirms the Blueprint's direction and phase order**; it adds three refinements (new-key `company_admin` with a legacy admin role for existing Companies; request-scoped context before any new consumer of authorization data; invitation/acceptance instead of attach-by-id) and one data gap (real-estate inventory). **Architecture Gate closure is the CTO's decision on §14. No Foundation phase starts before it.**
