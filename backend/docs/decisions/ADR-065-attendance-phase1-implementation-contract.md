# ADR-065 — Attendance Phase 1: Implementation Contract

**Status:** RATIFIED basis (`ADR-063`'s nine decisions ratified by the CTO,
2026-09-19) → this document is the resulting build contract. Built
strictly from `ADR-062` (Phase 0 study) + `ADR-063` (ratified policy
decisions) — no new policy is introduced here. HR Phase 1 (`ADR-059`,
CLOSED/PASS) is not reopened. Production remains HOLD; this contract
authorizes implementation of Attendance Phase 1 only.

## 0. Ratified decisions this contract implements (ADR-063)

| # | Ratified | Consequence for this build |
|---|---|---|
| D-ATT1 | **A** — standalone module | New `attendance` module_code, own manifest, own `@RequireModule('attendance')` gate, `attendance.*` permission namespace |
| §1 | **C** — no late/early calc | `AttendanceDay.status` has no `late`/`early_departure` value in Phase 1 |
| §2 | **B** — hours as a fact only | `AttendanceDay.hoursWorked` is computed and stored; no wage, rate, or payable amount anywhere in this module |
| §3 | **B** — reconcile against approved LeaveRequest | Attendance reads HR's approved `LeaveRequest` rows (new, additive, read-only method on `HrService`) to classify `on_leave` days |
| §4 | **A** — no Shift entity | No `shiftId`, no shift assignment, no per-shift anything |
| §5 | **A** — first-in/last-out span | `checkIn` = day's earliest punch, `checkOut` = day's latest punch, `hoursWorked` = their difference |
| §6 | **A** — exact timestamps | No rounding anywhere |
| §7 | **B** — defer holiday/weekend calendar | Weekends/holidays with no punch and no approved leave are classified `absent` — an accepted, disclosed consequence, not a defect |
| §8 | **C** — correction split by batch status | A day not yet in an *approved* batch: direct, permission-gated correction. A day in an *approved* batch: FA-01-gated correction (reuses the engine exactly as leave requests do) |

**Internal consistency check:** no contradiction exists between these
nine. §1:C and §4:A are mutually reinforcing (no lateness policy needs no
shift model). §2:B depends on §5:A for a well-defined "hours worked"
number — satisfied, since both are ratified together. §3:B and §7:B
together fully determine `AttendanceDay.status`'s only four values:
`present | absent | on_leave | missing_punch` (never `holiday` — deferred
by §7). §8:C is directly implementable because `ADR-062 §4`'s
approval-batch model already gives a clean, derivable trigger (is this
day's batch `approved`?).

## 1. Explicit scope boundary for this contract

**In scope:** Raw attendance ingestion (manual entry + Excel/CSV import +
a generic "external source" API surface a future device adapter can call
into), employee/device mapping, `AttendanceDay` derivation per the table
above, FA-01 approval batches, split-authority correction, permissions,
audit, frontend.

**Explicitly deferred (not built in this contract, per "do not expand
scope"):**
- **A real biometric device adapter.** No vendor is known (`ADR-062 §0`,
  still UNVERIFIED). The connector/mapping tables are built generically
  enough to receive one later (mirrors `foundation/integrations`'
  connector shape, per `ADR-062 §7`) — a "generic/manual" connector type
  is the only one seeded now.
- `attendance.reprocessing.*` — no standalone "reprocess historical days"
  feature. Re-deriving a day happens naturally whenever new raw records or
  a leave-approval event arrive for it; nothing here builds an
  admin-triggered bulk reprocessing tool.
- Shift management, holiday/weekend calendars, late/early/overtime pay
  computation, any wage or payroll calculation — all out of scope per the
  ratified decisions above, not to be reintroduced.

## 2. Module registration

- `ModuleCode` (`module-manifest.type.ts`) gains `'attendance'`,
  `V1_MODULE_CODES` gains the entry — same mechanism `manufacturing` used
  under `ADR-061` (a genuinely new module, not a promotion from
  `ReservedModuleCode`, since `attendance` was never reserved — confirmed
  in `ADR-062 §0`).
- New manifest `attendance.manifest.ts`, registered in `manifests/index.ts`.
- `depends_on: ['hr']` — the one real cross-module import this module
  makes (`HrService`, for §3's leave reconciliation) — declared honestly,
  matching this codebase's "declare what you actually import" discipline.

## 3. Data model (entities, `domains/attendance/infrastructure/`)

- **AttendanceConnector** — `id, connectorType ('manual'), name, status, config: jsonb, lastConnectedAt`. Mirrors `IntegrationConnector`'s shape (`ADR-062 §7`) as Attendance's OWN table — not a shared table with `foundation/integrations`, which is scoped to e-commerce store connectors and would be a poor semantic fit (`StoreConnectorAdapter` publishes products; a biometric device does not). Only `'manual'` is seeded as a real connector type in this contract; the shape is ready for a future `'attendance_device_<vendor>'` entry without a schema change.
- **AttendanceEmployeeMapping** — `id, connectorId, employeeId, deviceUserRef, effectiveFrom, effectiveTo (nullable)`. Unique `(connectorId, deviceUserRef)` where `effectiveTo IS NULL`.
- **AttendanceImportBatch** — `id, fileHash, fileName, totalRows, succeededCount, rejectedCount, importedByUserId, importedAt`. `fileHash` (SHA-256 of the uploaded buffer) is the idempotency key — a re-upload of the identical file is detected and rejected before any row is touched (mirrors `IntegrationSyncLog`'s proven idempotency pattern, `ADR-062 §0`/§6).
- **AttendanceRawRecord** — `id, sourceType ('manual'|'excel_import'|'api'), sourceConnectorId (nullable), importBatchId (nullable), deviceEmployeeRef, resolvedEmployeeId (nullable), punchTimestamp, punchType ('in'|'out'|'unknown'), rawPayload: jsonb, ingestedAt, ingestedByUserId (nullable)`. Write-once — never updated after insert.
- **AttendanceDay** — `id, employeeId, calendarDate (unique with employeeId), checkIn (nullable), checkOut (nullable), hoursWorked (nullable decimal), status ('present'|'absent'|'on_leave'|'missing_punch'), batchId (nullable, FK to AttendanceApprovalBatch), correctionOf (nullable self-reference), correctedByUserId (nullable), correctedAt (nullable)`.
- **AttendanceApprovalBatch** — `id, periodStart, periodEnd, status ('draft'|'submitted'|'approved'|'rejected'), approvalRequestId (nullable, FA-01), createdByUserId, createdAt, decidedAt (nullable)`.
- **AttendanceCorrectionRequest** — only populated when §8's FA-01 path is taken (day already in an approved batch): `id, attendanceDayId, approvalRequestId, proposedCheckIn, proposedCheckOut, reason, requestedByUserId, createdAt`. A direct (pre-approval) correction needs no such row — it is applied immediately and audited.

All additive, new tables. No existing HR or Attendance-adjacent table is altered.

## 4. Permission nodes (`attendance.*`)

`attendance`, `attendance.connector.{view,create,edit}`,
`attendance.mapping.{view,create,edit}`, `attendance.raw_record.view`,
`attendance.import.{view,create}`, `attendance.manual_entry.create`,
`attendance.day.view`, `attendance.correction.create` (covers BOTH the
direct-correction path and the maker side of the FA-01 path — the engine
itself enforces maker≠checker, no separate node needed for that split),
`attendance.approval.approve` (FA-01 checker side, mirrors
`hr.leave_request.approve` exactly).

## 5. Processing rule (derives/re-derives `AttendanceDay`)

For a given `(employeeId, calendarDate)`:

1. If HR reports an approved `LeaveRequest` covering this date for this
   employee (§3:B — new `HrService.isApprovedLeaveDate(employeeId, date)`
   read method, additive, does not touch any existing HR Phase 1
   behavior) → `status = 'on_leave'`, `checkIn/checkOut/hoursWorked = null`.
2. Else, gather this employee's raw records for this date with
   `resolvedEmployeeId` set. If none → `status = 'absent'`.
3. Else `checkIn` = earliest punch, `checkOut` = latest punch (§5:A). If
   only one punch exists → `status = 'missing_punch'`, `hoursWorked =
   null`. If 2+ punches → `status = 'present'`, `hoursWorked = (checkOut -
   checkIn)` in hours, exact (§6:A, no rounding).

Re-running this rule for a day already in an *approved* batch is exactly
what §8:C's FA-01 correction path exists to gate — the rule itself never
silently re-runs against approved data outside that flow.

## 6. Import contract (Excel/CSV)

`ExcelService.buildTemplate`/`parseWorkbook` reused as-is (`ADR-062 §6`).
New: a genuine **Preview** — parse + per-row validation (required fields,
`AttendanceEmployeeMapping` resolution) WITHOUT any write, returning the
same `ImportSummary<T>` shape `CustomersService.importRows` established.
Pipeline: template → upload → parse → preview → confirm → import (creates
one `AttendanceImportBatch` + N `AttendanceRawRecord` rows, and
re-derives every affected `AttendanceDay`) → audit → failure report → a
byte-identical re-upload is rejected via `fileHash`, not silently
re-imported.

## 7. E2E acceptance (subset of `ADR-062 §12`, scoped to this contract)

1. Manual entry creates a raw record → correct day derivation.
2. Excel import: template → preview (no writes) → confirm → import →
   re-upload of the same file rejected.
3. An unmapped device reference is preserved with `resolvedEmployeeId:
   null`, surfaced, and resolves retroactively once mapped.
4. A device/employee mapping is closed and reopened without losing history
   (old raw records still resolve to the original employee).
5. An approved `LeaveRequest` day is classified `on_leave`, not `absent`.
6. A batch is submitted, approved by a second user (SoD proven live, same
   as HR Phase 1), and only then is `attendance.period.approved`
   published.
7. Correcting a day BEFORE its batch is approved: direct, audited. AFTER
   approval: creates an `AttendanceCorrectionRequest`, requires a second
   user's FA-01 approval, applies only on approval.
8. Unauthorized users are blocked from every sensitive action.
9. Full regression, clean build, live browser verification.

## 8. Next step

Implementation proceeds directly from this contract — Foundation →
Import → Processing/Approval → Correction → Frontend, tested at each
stage, no further planning gate per instruction. Production remains HOLD.
