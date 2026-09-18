# ADR-059 — HR / Workforce Management: Phase 0 Architecture & Implementation Contract

**Status:** **APPROVED** — Phase 1 implementation authorized. Wave 2 of the
ADR-053 Long-Term Completion Charter (Wave 1 Financial Control → **Wave 2
HR** → Wave 3 Payroll → Wave 4 Manufacturing → Wave 5 Enterprise
Expansion). Every fact in the study below is from direct inspection of the
current repository (paths cited throughout), not from memory or the
module's name.

## CTO Ratified Decisions (D1–D4) — binding, not reopened during Phase 1

- **D1 (Department source of truth): Option A.** `hr_departments` is
  **retired**. `OrgUnit(type='department')` becomes the single source of
  truth for departments. No replacement HR department table/entity is
  created — the existing `/hr/departments` API surface is retained as a
  thin, permission-gated view over `OrganizationService`.
- **D2 (Employee ↔ User linkage): Yes, manual only.** `Employee.userId` is
  added as nullable. **No auto-provisioning** — linking an existing `User`
  to an `Employee` is a deliberate, manual Admin action via its own route.
- **D3 (Termination gating): Option B.** Termination is a **direct,
  permission-gated action** under its own dedicated node,
  `hr.employee.terminate` — **no FA-01 approval workflow** for termination.
- **D4 (Numbering): Option A.** `Employee.code` and the department code
  carried onto `OrgUnit` are issued through `NumberingService` — no
  free-text code input from the client.

These four decisions are final for Phase 1. Any ordinary implementation
question is resolved under §16 without reopening D1–D4; escalation is
reserved for a genuine conflict with Core or a ratified ADR.

## 0. What exists today (Items 1–2: audit + gap inventory)

HR was built once, early, as **P9** (`ADR-029` — referenced throughout the
code but the ADR file itself is not present in `docs/decisions/`; likewise
the charter's own `architecture/DAII_ERP_LONG_TERM_COMPLETION_CHARTER.md`
full-detail file does not exist in this repository — both are pre-existing
documentation gaps, noted here, not something Phase 0 fixes). P9's own
stated goal, per its code comments, was narrower than a real HR bounded
context: *prove a new module needs no other module's internals* — so it
was deliberately built with `depends_on: []` and the bare minimum to
demonstrate that. That goal was met; it also means almost nothing a real
HR/Workforce module needs exists yet.

**Backend — exactly these 6 files, nothing else:**
- `backend/src/domains/hr/infrastructure/employee.entity.ts` — `Employee`: `id, code, fullName, departmentId (nullable uuid, hr's own FK), position (free text), hireDate, status, createdAt, updatedAt`.
- `backend/src/domains/hr/infrastructure/department.entity.ts` — `Department`: `id, code, name, createdAt, updatedAt`.
- `backend/src/domains/hr/domain/employee-status.ts` — `EmployeeStatus = 'active' | 'on_leave' | 'terminated'`, a hand-rolled transition table (`active↔on_leave`, either `→terminated`, `terminated` is final).
- `backend/src/domains/hr/application/hr.service.ts` — `createDepartment`, `listDepartments`, `createEmployee` (limit-gated via `LimitService.check('hr.max_employees')`, publishes `employee.created` via `EventBusService`), `listEmployees`, `getEmployee`, `setStatus`.
- `backend/src/domains/hr/interface/hr.controller.ts` — `POST/GET departments`, `POST/GET employees`, `GET employees/:id`, `POST employees/:id/status`.
- `backend/src/domains/hr/hr.module.ts` — imports only `AuthenticationModule`, `EventsModule`, `PermissionModule` (plus the always-global Entitlement/Limit modules). **Zero import from any `src/domains/*` sibling** — confirmed by direct read, matching the module's own doc comment.

**Frontend — exactly 3 pages:**
- `frontend/src/pages/covers/HrCover.tsx` — KPI landing page (total/active employee counts, department count), `roles: ['admin']` only (`hasRole('admin')` gate, hardcoded in the component itself, not the sidebar).
- `frontend/src/pages/hr/HrEmployees.tsx` — list + create form + status-transition buttons. No edit, no delete, no detail/profile view, no department filter/search.
- `frontend/src/pages/hr/HrDepartments.tsx` — list + create form. **No edit action in the UI**, matching a real backend gap (below).

**Permission manifest** (`backend/src/foundation/module-registry/manifests/hr.manifest.ts`): `hr`, `hr.employee{.view,.create,.edit}`, `hr.department{.view,.create,.edit}`; one feature code (`hr.employee_directory`, default-on, non-toggleable); one limit key (`hr.max_employees`); one config key (`hr.default_employee_status`); public contract lists `CreateEmployee`/`CreateDepartment` commands, 3 queries, and the `employee.created` event.

**Concrete, verified gaps (not opinions — each traced to a specific file):**

1. **`hr.department.edit` is declared in the manifest but wired to no route.** `hr.controller.ts` has no `PATCH/POST departments/:id` at all — a department's name can never be changed once created. This is the exact class of defect `hr.controller.ts`'s own comment describes fixing for `.view` nodes under SEC-07 ("declared but nothing was wired to") — just not yet done for `.edit`.
2. **`HrService` never calls `AuditService`.** Every other domain built in this program (`FiscalPeriodService`, `ClosingExceptionService`, `GrniReconciliationService`, `CustomersService`, …) records an audit entry for every state-changing action. `createEmployee`, `createDepartment`, and `setStatus` do not. This is a plain platform-convention gap, not a policy question — Phase 1 should close it as a matter of course.
3. **`employee.created` has zero subscribers anywhere in the codebase** (confirmed by full-repo grep). The one integration point HR was ever given is currently a dead signal.
4. **No `Employee ↔ User` link of any kind.** `Employee` has no `userId` column; `User` (`backend/src/foundation/identity/user.entity.ts`, via `UsersService`) has no `employeeId`. Today's "Sales Rep" concept (`UsersService.findByFullName`, used by CRM import) is **purely a `User` + role** — entirely disconnected from `hr_employees`. There is no way, today, to say "this logged-in user IS this employee" or "this employee's manager should receive this approval."
5. **Two unrelated "department" concepts already exist in this codebase.** `OrgUnit` (`backend/src/foundation/organization/org-unit.entity.ts`) already declares `type: 'company' | 'branch' | 'department' | 'team' | 'warehouse'` as a self-referential tree, with `OrgMembership` (`userId ↔ orgUnitId`) driving user-scoping elsewhere in the platform. `hr_departments` is a second, completely separate flat table with zero relationship to `OrgUnit`. This is precisely the "separate modules, duplicated concept" failure the charter (ADR-053) was written to prevent, and it already exists — see Open Decision D1 below.
6. **No numbering-service integration.** Every other business document in this system with a human-facing code (`PO-2026-000001`, invoice numbers, GR numbers) is issued by `NumberingService.getNextNumber` (`backend/src/foundation/numbering/numbering.service.ts`) — a transactional, concurrency-safe sequence. `Employee.code` and `Department.code` are raw free-text input from the create form, with only a DB-level unique index as protection (no format, no collision-safe issuance, no year-scoping).
7. **No manager/reporting-line, no leave-request workflow, no approval integration, no compensation fields (correctly — that is Payroll's scope, not HR's), no legal-entity linkage, no employment-history, no document/attachment storage, no self-service of any kind.**

**Payroll**: confirmed entirely unbuilt. `'payroll'` exists only as a reserved `business_domain`/`PermissionActionVerb`-adjacent enum value in `backend/src/foundation/module-registry/module-manifest.type.ts` — no manifest file, no module, no entity, nothing else references the word anywhere in `backend/src`. Wave 3 has not started in any form.

## 1. Dependency mapping (Item 3)

| Dependency target | Current state | What HR (Wave 2) needs from it |
|---|---|---|
| **Accounting** | Zero coupling today | None in Wave 2 itself (Payroll, Wave 3, is where GL posting happens) — but Wave 2 must define the *shape* of the eventual integration boundary now so Wave 3 doesn't have to redesign HR's aggregates (Item 6, below). |
| **Employees/Departments** | This *is* the module | N/A |
| **Permissions** | Ancestor-walk `PermissionService`, already used correctly by `hr.controller.ts` | Unchanged mechanism — new nodes only for new capabilities (leave request/approve, employee edit, department edit), no new mechanism. |
| **Approvals (FA-01)** | Generic `ApprovalsService.submit(...)` + `POST /approvals/requests/:id/decide`, reused identically across AR/AP/Cash-Bank/Fixed-Asset/Fiscal-Period/GRNI this program | HR needs its first-ever use of this engine (e.g. a leave request, or a sensitive employee-status change) — a genuinely new consumer, but zero new engine code, exactly per ADR-053 §1 ("extend the existing ERP Core... never duplicate or bypass it"). |
| **Legal Entity/Organization boundaries** | `OrgUnit`/`OrgMembership` (Foundation, see gap 5 above) | This is the single largest open dependency question in this study — see Open Decision D1. |

## 2. HR bounded context and aggregates (Item 4)

Proposed aggregates for Wave 2 (Employee/Workforce Administration only —
**not** Payroll, which owns its own aggregates in Wave 3 and is deliberately
out of scope here):

- **Employee** (aggregate root) — extends the existing entity with: `userId` (nullable, see D2), `managerId` (nullable, self-referential `Employee` FK — the reporting line), `legalEntityId`/`orgUnitId` (see D1), `employmentType` (`full_time|part_time|contractor` — a real gap today), `terminationDate`/`terminationReason` (today `status='terminated'` carries no date or reason at all), and a proper `EmployeeStatusHistory` child table (today a status flip overwrites the single `status` column with no record of when/why/by whom — no audit trail, gap 2 above compounds this).
- **Department** — either absorbed into `OrgUnit` or explicitly linked to it (D1); regardless, gains the missing `edit` capability (gap 1) and a `managerId` (department head).
- **LeaveRequest** (new aggregate) — the first genuinely new HR workflow: `employeeId, leaveType, startDate, endDate, reason, status (draft→submitted→approved|rejected→cancelled)`, submitted via the existing FA-01 engine exactly as `AR/AP adjustments` and `fiscal_period.close` already are.
- **EmploymentDocument** (new, minimal) — out of scope for Wave 2's first cut unless the CTO wants it; flagged as a nice-to-have, not blocking.

Deliberately **not** aggregates of this bounded context: compensation/salary,
payslips, tax withholding, benefits enrollment, time & attendance clocking —
all Wave 3 (Payroll) or later, per the charter's own wave sequencing. Wave 2
must expose exactly enough of `Employee` (a stable, well-identified aggregate
with a real key, a real status history, and a real org/legal-entity
placement) that Wave 3 can attach Payroll to it **without** touching HR's
schema again — that is the concrete meaning of ADR-053 §18's "does not
block or complicate the modules that follow it" for this specific module.

## 3. Workflows and state transitions (Item 5)

- **Employee lifecycle**: extend today's flat `active↔on_leave→terminated`
  into a properly evidenced transition (each change writes an
  `EmployeeStatusHistory` row + an `AuditService.record` call — closing gap
  2). Whether `terminated` needs an FA-01 approval gate (like Fiscal Period
  `close`/`reopen`) or stays a direct `hr.employee.edit` action is Open
  Decision D3.
- **Leave request**: `draft → submitted → approved|rejected`, submitted by
  the employee (requires D2, the User↔Employee link, to know *which*
  employee a logged-in user is submitting for) or on the employee's behalf
  by HR staff if D2 is deferred; decided via the generic
  `POST /approvals/requests/:id/decide` route, exactly mirroring every
  other FA-01 consumer in this codebase — no new approval mechanism.
- **Department edit**: routine, `hr.department.edit`-gated, no approval
  needed (matches every other "edit a master-data record" pattern in this
  system, e.g. Chart of Accounts).

## 4. Financial integration boundary (Item 6 — no policy invented)

Per instruction, this section defines **only the boundary shape**, not any
posting rule, GL account mapping, or payroll calculation policy — those are
Wave 3's decisions, to be made when Payroll is actually specified, exactly
as GRNI's actual posting policy was deferred until ADR-054/057 were ready
to make it.

- HR (Wave 2) should publish **domain events** for the facts Payroll will
  eventually need, using the same `EventBusService.publish` mechanism every
  other domain already uses (e.g. `employee.hired`, `employee.terminated`,
  `employee.status_changed`) — `employee.created` already exists but is
  unconsumed; it should keep meaning "a new employee record now exists,"
  not be repurposed to mean "this employee is now on payroll."
- HR (Wave 2) must **not** define any GL account, control-function, or
  Financial Event type — those belong to Payroll's own future ADR, the same
  way `GRNI_LEDGER_CONTRACT` was Procurement's contract to define and
  Accounting's contract to consume (ADR-054/056/057), not the other way
  round.
- The only thing Wave 2 needs to guarantee is that `Employee` carries a
  stable identity and enough placement data (legal entity/org unit,
  employment type, status with history) that a future Payroll run can
  correctly determine *who* to pay and *which company's* books to post
  against — without Payroll having to reshape HR's schema to get it.

## 5. Permissions and SoD requirements (Item 7)

No new permission *mechanism* — same ancestor-walk `PermissionService`
already in use. New *nodes* needed, following the exact naming/parent
convention `hr.manifest.ts` already established:

- `hr.department.edit` — **already declared, just needs a route** (gap 1) — not a new node.
- `hr.leave_request` (parent `hr`), `.view`, `.create` (employee-side submit), `.approve` (manager/HR-side decide) — mirrors `accounting.fiscal_period.{edit,approve}`'s maker/checker split exactly.
- `hr.employee.terminate` — **ratified D3**: its own separate node from `hr.employee.edit`, direct action, no FA-01 (mirrors `accounting.closing_exception.annotate_test_artifact` being deliberately split from `.resolve` for the same "one sensitive action gets its own node" reason established in ADR-051/058).
- `hr.employee.link_user` — the manual Employee↔User linking action (**ratified D2**) gets its own node for the same reason: a narrow, identity-sensitive action distinct from ordinary `hr.employee.edit`.

**SoD**: the natural maker/checker split is *employee submits leave* vs.
*manager/HR approves it* — already the FA-01 engine's exact shape, so no
new SoD mechanism is needed, only correct node assignment (submit-side
permission ≠ approve-side permission, exactly as every existing FA-01
consumer in this codebase already does).

## 6. Frontend scope (Item 8)

Following the same page/component conventions audited and reused across
ADR-058 (thin pages, `useLanguage`/`api`/`StatusBadge`/`ApprovalsPanel`,
`data-table`/`card`/`btn` CSS classes):

- Fix `HrDepartments.tsx` to add the missing edit action (gap 1).
- Extend `HrEmployees.tsx` with an edit action and a real status-history
  display (once D3/aggregate work lands).
- New: a Leave Requests page (employee submit form + `<ApprovalsPanel
  requestTypeCodes={['hr.leave_request']} decidePath={...} />` reused
  as-is, exactly like every Wave 1 approval consumer).
- New: an Employee detail/profile page (route pattern `hr/employees/:id`,
  which does not exist today — `HrEmployees.tsx` is list-only).
- Sidebar: unchanged group placement (`hr` group already exists in
  `Layout.tsx`), new items added the same way GRNI was added to
  `module.accounting` in ADR-058.

## 7. Migrations and data requirements (Item 9)

**Ratified shape (D1/D4):** `hr_departments` rows are migrated into
`org_units` **preserving their existing primary key** (`INSERT INTO
org_units (id, type, name, code, "parentId", "createdAt") SELECT id,
'department', name, code, NULL, "createdAt" FROM hr_departments`) — because
`hr_employees.departmentId` already stores those same ids, this migration
requires **zero change to any `Employee` row**; the FK simply resolves into
`org_units` instead of the now-dropped `hr_departments` table. `org_units`
gains a new nullable `code` column (additive, backward-compatible with
every existing non-department `OrgUnit` row). `hr_departments` is then
dropped.

Additive changes to `hr_employees`: `userId` (nullable, D2), `managerId`
(nullable, self-referential), `employmentType` (nullable), `terminationDate`
(nullable), `terminationReason` (nullable). New `hr_employee_status_history`
table. New `hr_leave_requests` table. Two new `numbering_sequences` rows
registered (`hr_employee`, `hr_department`) per D4. All additive; no
destructive change to any row that survives the `hr_departments` migration.

## 8. E2E acceptance matrix (Item 10, for Phase 1's own PASS gate)

| # | Scenario | Proof required |
|---|---|---|
| 1 | Create employee → status history row + audit record written | DB assertion, not just "API returned 200" |
| 2 | Edit department name → reflected in employee list's department column | Round-trip through the fixed `.edit` route |
| 3 | Employee submits leave → appears in manager's `ApprovalsPanel` → approve/reject → status transitions correctly | Full FA-01 round-trip, mirroring `fiscal-period-closing-workflow.spec.ts`'s own proof shape |
| 4 | Reject path leaves no side effect (no status change, no phantom approval) | Explicit negative-path test, same discipline as GRNI's reversal/failure-recovery proofs |
| 5 | Permission gate: a role without `hr.employee.edit` cannot change status (403), a role without `hr.leave_request.approve` cannot decide | Mirrors the ADR-058 visibility-filter integration-test pattern |
| 6 | Frontend: live-clicked in browser, no console errors, correct RTL rendering | Same live-verification bar as ADR-058 |
| 7 | Full regression suite still green after the change | Same bar as every Wave 1 phase |

## 9. Decisions — RATIFIED (see top of document)

D1–D4 were escalated per ADR-053 §16 as genuine architectural-boundary /
business-invariant decisions. The CTO has ratified all four (see the
**CTO Ratified Decisions** block at the top of this document). They are
final for Phase 1 and are not reopened during implementation. Everything
else in this document — the aggregate shapes, the reuse of FA-01 for leave
requests, the additive migrations, the permission-node naming, the
audit/numbering gap fixes — follows directly from ADR-053's own "extend
the existing Core, never duplicate it" rule and this repository's own
established conventions, and proceeds under §16 (Resolve → Implement →
Test → Verify → PASS → Continue).

---

Phase 0 study work involved no code, migration, schema, permission, or UI
change. **Phase 1 implementation is now authorized** against this ratified
contract. Production remains HOLD.
