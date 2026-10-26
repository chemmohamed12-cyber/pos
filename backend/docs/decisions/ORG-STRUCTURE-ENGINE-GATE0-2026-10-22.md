# Enterprise Organizational Structure Engine — Gate 0 (Architecture & Gap Audit)

**Date:** 2026-10-22 · **Status:** DRAFT FOR CTO DECISION — documentation only. No code, migration, data or configuration was changed. Branch `feature/org-structure-gate0` (from integration tip `eabd3fd`), not pushed, not merged.
**Method:** read-only inspection of the source at `eabd3fd` and read-only counts on the shared development databases (`daii_dev` :5433 and its four registered company databases). Nothing was written anywhere except this file.

---

## 1. Current organization-structure assessment

### 1.1 What already exists (and works)
| Piece | Where | What it is |
|---|---|---|
| `org_units` | core migration `1755840600000`, `foundation/organization/org-unit.entity.ts` | One self-referential tree per **Company database**: `id, type, name, code?, parentId, createdAt`. `type` ∈ `company | branch | department | team | warehouse` (a `varchar(16)`, validated only in TypeScript). `code` is nullable, unique where present, used only by HR departments. |
| `org_memberships` | same migration | user ↔ unit (unique pair). |
| `access_scopes` | core `1790010000000` (F6) | Explicit grants user → unit, `includeDescendants`. |
| `OrganizationService` | `foundation/organization` | list/create/rename units, assign/remove members, descendants/ancestors walk. **No move, no deactivate/archive, no delete, no type-validity rule, no code rule (except HR).** |
| `AccessScopeService` / `ScopeResolver` | `foundation/scope` | Single definition of "which units may this user work with" (memberships + grants, closure over descendants, one recursive statement per request). `core.scope.unrestricted` = company administrator sees all. A record **without** an org link is visible to everyone. |
| `WarehouseScopeGuard` / `@WarehouseScoped` | 54 uses | Pilot enforcement keyed by the **warehouse's** `orgUnitId`; out-of-scope answers 404. |
| Org screen | `frontend/src/pages/Organization.tsx`, `AccessScopePanel.tsx` | Create unit (type picker), list tree, assign members, grant scopes. |
| HR departments | HR migration `1789710000000` | Departments were retired **into** `org_units` (`type='department'`); `hr_employees.departmentId` points at an org unit. |

### 1.2 Observed state on the dev databases (read-only)
Only **Alpha** has any org data: 5 units — two roots of type `company` (`mother` with child branch `rana`; `Daii` with branches `كتامه` and `طنطا`). 13 warehouses, **0** linked to a unit. 1 vehicle, **0** with a branch. 0 memberships, 0 access grants. Beta/Gamma/Delta: no units at all. (Four other company-named databases on the host are not in the registry and were ignored.)

### 1.3 Findings (gaps in the current structure)
- **G1 — Two roots of type `company` inside one company database.** The tree does not enforce one root per Company; "company" as a unit type duplicates the platform's `companies` row. (Alpha already shows it: `mother` and `Daii`.)
- **G2 — No integrity rules on the tree:** no cycle check, no rule that a `warehouse` unit must sit under a branch, no parent/child type matrix, no uniqueness of names among siblings, no deactivate/archive (a unit referenced by documents can only be orphaned or cascade-deleted: the FK is `ON DELETE CASCADE` — dangerous for a hierarchy that documents point to).
- **G3 — `warehouse` is both an org-unit *type* and a real `warehouses` table.** The warehouse table links to a unit through a nullable `orgUnitId`; the unit type `warehouse` has no owner. Two representations of one concept.
- **G4 — Org references are optional and mostly unpopulated.** Absent link = visible to everyone. That was the right zero-regression default for F6, but it means *today no business record is actually isolated by branch*.
- **G5 — Branch is free text on the vehicle** (`vehicles.branch varchar(128)`, optional, no validation) — see §2.4.
- **G6 — Cost Center is a financial *dimension value*** (`accounting_financial_dimension_values`, type code `cost_center`) with an optional `orgUnitId`; it is already separate from the tree. Good, keep it (see D-3).
- **G7 — No Location entity** beyond warehouse sub-locations (`warehouses.parentWarehouseId`, `kind='operational'` for vehicles / shipping companies).
- **G8 — No Legal Entity concept** other than the platform `companies` row (one Company = one database = one legal entity today).
- **G9 — Scope enforcement covers warehouse-keyed routes only** (F6 pilot). Sales orders / customers still use the older `scope_assignments` ("direct") model; suppliers / treasury accounts use `org_unit` derivation by membership; most others are `unscoped` or derived from a parent.

---

## 2. Proposed data model and relations

Principle: **extend `org_units`, do not replace it.** All existing rows, FKs (`orgUnitId` on 17 tables), the F6 scope CTE and the HR departments keep working unchanged.

### 2.1 Entities and how each stays distinct
| Concept | Proposed representation | Why distinct |
|---|---|---|
| **Legal Entity** | Stays the platform `companies` row (one DB per Company). Not a tree node. A future multi-legal-entity-per-database case is explicitly **out of scope** (decision D-1). | Owns books, tax registration, fiscal years. |
| **Branch** | `org_units.type='branch'`, child of the root. | Operational/reporting unit. |
| **Department** | `org_units.type='department'` (already so). | Functional unit; employees point at it. |
| **Team** | `org_units.type='team'` (exists). | Optional sub-grouping. |
| **Location** | Not an org unit. Physical places stay on `warehouses` (+ operational sub-locations). Optional later: `locations` table with `branchOrgUnitId`. | A place is not an owner. |
| **Warehouse** | Stays `warehouses`; its `orgUnitId` (exists) names the **owning branch**. The `warehouse` unit *type* is **frozen** (no new use; kept for compatibility). | Inventory master data. |
| **Cost Center** | Stays a financial dimension value (type `cost_center`); gain a *validated* optional `orgUnitId` (branch/department it belongs to). | Accounting dimension, not hierarchy. |

### 2.2 Additive changes (all nullable / defaulted, behaviour-preserving)
On `org_units`: `status` (`active|inactive`, default `active`), `sortOrder`, `phone/address` (optional), `managerUserId` (optional), `effectiveFrom/To` (optional), a **type check constraint** and a **single-root rule per Company** (partial unique index on the root), `code` generated by the numbering engine for all types (existing HR codes untouched). `ON DELETE CASCADE` on `parentId` → `RESTRICT` plus deactivate-instead-of-delete.
New small tables only if approved: `org_unit_closure` (materialized descendants, only if measurements justify it — the recursive CTE is currently one statement per request; keep as is until measured).
Business tables: add **`branchOrgUnitId`** (the *org context stamp*) to the transactional documents listed in §3, populated **server-side** from the resolved context, never from a free client field. Existing `orgUnitId` columns stay and keep their meaning.

### 2.3 Relations
`Company(1) → root org unit(1) → branches(n) → departments/teams(n)`; `warehouse.orgUnitId → branch`; `employee.departmentId → department`; `user ↔ unit` via memberships and access scopes (unchanged); `cost_center value.orgUnitId → unit`; document `branchOrgUnitId → branch` (stamped).

### 2.4 Company vehicles screen (reviewed, as requested)
Current: `vehicles.branch` is optional free text (`CreateVehicleDto.branch?: string`, `ShipmentService.createVehicle(… branch: string|null …)`); the screen (`ShippingMethods.tsx`, add-vehicle form) offers a plain text box; the entity comment itself says "no such concept exists yet". Consequences: typos, no link to the real branch tree, no scope filtering, no report by branch, silently empty (Alpha's only vehicle has none).
Proposed: replace with `vehicles.orgUnitId` (FK-validated, must be an **active branch** the caller may access), a **dropdown of branches** (or auto-selected when the caller has exactly one), **required** for new vehicles in a Company that has branches, validated server-side (`NotFound`/`BadRequest` bilingual), and inherited by the vehicle's auto-created custody sub-location and custody treasury account (so custody stays inside the branch). Legacy text → mapping in §6. The old `branch` text column stays read-only until migration is confirmed.

---

## 3. Module-to-structure mapping (current vs proposed)
| Module | Current org reference | Proposed |
|---|---|---|
| Sales orders / customers | `scope_assignments` (direct, per record); no branch column | stamp `branchOrgUnitId` on order, invoice, shipment; customer keeps assignment model + optional home branch |
| Shipping / shipments / vehicles / shipping companies | none (vehicle: free-text branch) | vehicle `orgUnitId` (§2.4); shipment inherits order's branch |
| Delivery / collections / custody | parent derivation via sales order | unchanged; custody accounts inherit vehicle branch |
| Procurement (PR, PO, GRN, supplier invoices) | PO has `orgUnitId` (nullable); supplier `orgUnitId` | stamp branch on PR/PO/GRN/invoice from the requesting warehouse/branch |
| Inventory / warehouses | warehouse `orgUnitId` (nullable) — F6 scope key | make it the **owning branch** (required for new warehouses when branches exist) |
| Treasury | account `orgUnitId` | unchanged; transactions inherit account's branch |
| Accounting | `orgUnitId` on journal entries/lines, events, fiscal years, fixed assets, GL accounts, recon runs | keep; branch on lines becomes the reporting dimension (validated to descend from entry unit — already coded) |
| HR / payroll | `departmentId` → org unit; no branch | employee gets `branchOrgUnitId`; payroll run per branch optional |
| Manufacturing | none | work centers/work orders get branch via warehouse |
| Approvals | `orgUnitId` on rules and requests | unchanged; add "approver in same branch" condition (later) |
| Reports | per-module, no org filter | org filter + roll-up (§7) |

## 4. Gap and dependency matrix
| # | Gap | Depends on | Risk if skipped |
|---|---|---|---|
| M1 | tree integrity (one root, types, no cycle, deactivate) | none | corrupted hierarchy |
| M2 | server-side org-context resolver (user → default/selected branch → stamp) | M1, auth context | clients choose branch → spoofing |
| M3 | vehicle branch FK | M1, M2 | free-text drift (today) |
| M4 | warehouse owning branch required | M1 | F6 scope has no key |
| M5 | stamping on documents | M2, M4 | reports can't split by branch |
| M6 | scope enforcement beyond warehouse routes | M5 | branch users see other branches' orders |
| M7 | legacy mapping | M1, M3–M5 | wrong/lost attribution |
| M8 | org reports | M5 | none |
| M9 | UI: org admin screen v2, branch picker/context switcher | M2 | usability |

## 5. Permissions and data-scope strategy
- **Reuse the existing system**: permission = *what* (role/rule nodes, `PermissionGuard`, 404 on denial); scope = *where* (`AccessScopeService`, memberships + `access_scopes`). **No parallel mechanism.**
- New permission nodes only for org administration (create/rename/move/deactivate units — today `company.organization.manage` covers all) and for "switch branch context".
- **Org context resolution on the server** (`OrgContextService`): per request, effective branch = explicit selection (header/param) **only if** inside the caller's accessible units, else the caller's single unit, else (several units) the request must select one on write; unrestricted users must still choose a branch for stamped documents. A client-sent branch id is a *proposal*, always validated against the scope closure; failure → 404 (anti-enumeration, same as today).
- Reads: list filters add `branchOrgUnitId IN (accessible)` OR `IS NULL` (legacy = visible, keeping the proven zero-regression rule) until the Owner approves tightening legacy handling (D-5).
- Admin unrestricted rule, last-admin, anti-elevation and F2–F6 rules unchanged.

## 6. Existing-data migration plan (no default-branch assumption)
1. **Inventory only (read-only report):** per Company, list every row lacking a branch in each stamped table, vehicles with free-text branch, warehouses without unit, units of type `warehouse`, duplicate roots.
2. **Mapping proposals, never automatic assignment:** exact-name match of vehicle text → branch name is *proposed*, an owner confirms in a review screen/CSV; unmatched stay `NULL`.
3. **`NULL` stays valid** ("unassigned / company level") — nothing is silently put in a default branch; reports show an explicit "Unassigned" bucket.
4. Apply per Company with a dry-run, counts before/after, reversible (`down` clears only stamps the migration wrote; a `org_migration_log` records each assignment and its source).
5. Gate: no tightening of `NULL` visibility until the unassigned count is zero or the Owner accepts it.
Current volume is tiny (Alpha: 13 warehouses, 1 vehicle, 1 order), so risk is on production data we have **not** inspected — production inventory is a prerequisite for sizing (open item).

## 7. Organizational reporting design
Roll-up by closure (branch totals include descendants); "Unassigned" bucket; reports on the existing read APIs gain `orgUnitId` + `includeDescendants` params; financial reports reuse journal-line `orgUnitId` and the cost-center dimension; operational: sales by branch, stock by branch (via warehouse), shipments/vehicles/custody by branch, procurement by branch, payroll by branch/department. A cached `org_unit_closure` only if measured necessary. Export respects scope.

## 8. Implementation, test and compatibility risk plan (proposed gates, none started)
| Gate | Content | Key tests |
|---|---|---|
| 1 | Tree integrity + status + code; Org screen v2 | real-PG: cycles, single root, deactivate, HR departments untouched |
| 2 | `OrgContextService` + permissions + context switcher | spoofed branch → 404, multi-unit user, unrestricted user |
| 3 | Vehicles + warehouses branch FK (§2.4) | create validated; inherits to custody accounts; legacy text mapping |
| 4 | Stamping on documents (sales→shipping→delivery, procurement) | two-company + two-branch isolation specs |
| 5 | Scope enforcement on lists/details, reports | A/B harness counting every non-200 |
| 6 | Legacy migration tool (dry-run, owner review) | rerun-safe, reversible |
Compatibility risks: `NULL` semantics must stay "visible"; releases must go through the release engine (core migrations fan out to company DBs — the company-migration gate applies); dashboards counting per-user scope; the idempotency of numbering; i18n of new labels (inline [AR, EN] tables, no terminology migration needed). Browser acceptance on an isolated env before any merge. No production deploy, no merge to the main branch without separate approval.

## 9. Decisions needed before any coding
- **D-1** One Company = one legal entity (keep), multi-legal-entity-per-database out of scope?
- **D-2** Freeze unit type `warehouse` (no new use), warehouse ownership by `warehouses.orgUnitId` → branch?
- **D-3** Cost Center stays a financial dimension (with validated optional org link), not a tree node?
- **D-4** Allow a Company with **no** branches (single-branch mode, everything works as today)? Proposed: yes; the vehicle/warehouse branch field becomes required only once ≥1 branch exists.
- **D-5** Legacy `NULL` branch = visible to all until migrated (proposed) vs hidden from scoped users?
- **D-6** Branch stamping source of truth: caller's context at creation (proposed) vs inherit from warehouse/order only.
- **D-7** Make `branchOrgUnitId` required (NOT NULL) on new documents once migration completes?
- **D-8** Vehicle: required branch + dropdown + inheritance to custody sub-location/account (as §2.4)?
- **D-9** Duplicate roots in existing data (Alpha: `mother`, `Daii`) — which is the company root; merge or archive the other?
- **D-10** Authorise a read-only inventory run against the **production** database to size §6 (needs the Owner/CTO; not done).
- **D-11** Which gate to start with after approval (proposed: Gate 1 + the vehicle fix in Gate 3 together as the first visible deliverable).

## Boundaries honoured
No code, schema, data, environment or deployment change; no default-branch assumption; Branch/Department/Location/Warehouse/Cost Center/Legal Entity kept separate; existing permission system reused; org context resolved server-side. Not verified here: production data shape, performance of the recursive scope CTE at large trees, the exact set of screens that list vehicles (only `ShippingMethods.tsx` read).
