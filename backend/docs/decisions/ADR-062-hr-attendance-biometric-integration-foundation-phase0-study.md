# ADR-062 — HR Attendance & Biometric Integration Foundation: Phase 0 Architecture Study

**Status:** Proposed (Phase 0 — study/design only). Preparatory roadmap
item under Wave 2 (HR), positioned explicitly as a bridge toward Wave 3
(Payroll) — **not** a reopening of HR Phase 1 (ADR-059, CLOSED/PASS) and
**not** the start of Payroll. No code, migration, schema, or frontend
change is authorized by this document. Every fact below is from direct
inspection of the current repository, not assumed from the request's own
framing.

**Governance for this document:** Resolve → Study → Document → Verify →
**STOP**. Implementation is not authorized by this study; it begins only
after a separate, explicit Phase 1 contract is ratified, exactly as
ADR-059 preceded HR Phase 1.

## 0. Current State — VERIFIED / INFERRED / UNVERIFIED

**VERIFIED (direct repository inspection):**

- **Zero existing attendance/biometric/punch/timeclock code anywhere.** A
  full-repository search for `attendance|biometric|fingerprint|punch|
  timeclock` returns only unrelated matches (`computeInstallationFingerprint`
  — a licensing/entitlement hash, nothing to do with employees). This is
  genuinely new ground, not a rediscovery of something partially built.
- **No `attendance` module code is even reserved.**
  `RESERVED_MODULE_CODES` (`module-manifest.type.ts`) lists `manufacturing,
  pos, projects, assets, operations, payroll` — `attendance` is absent
  from both the reserved list and the built list. This is a genuine,
  disclosed gap the roadmap has not yet accounted for (Open Decision
  D-ATT1, §11).
- **A mature, directly-reusable Adapter/Connector pattern already
  exists**: `backend/src/foundation/integrations/` (built for e-commerce
  store connectors, e.g. `qr_store`). Its shape:
  - `CONNECTOR_TYPES` (`connector-types.ts`) — a plain string-array
    registry; adding a new connector type is a code change, never a
    migration.
  - `IntegrationConnector` entity — generic (`id, connectorType, name,
    status, config: jsonb, lastConnectedAt`); `config` holds non-secret
    settings only.
  - `IntegrationCredential` entity — the secret, kept in its **own** table
    (AES-256-GCM ciphertext via `CredentialCipherService`), never mixed
    with `config`, never returned in plaintext after setup, revoked rows
    kept for audit rather than deleted.
  - `IntegrationProductMapping` entity — `(connectorId, daiiProductId) ↔
    externalProductId`, unique both directions, survives unrelated field
    changes on either side.
  - `IntegrationSyncLog` entity — `(connectorId, direction, eventType,
    externalReference, status, detail)`, with a real, live idempotency
    pattern already proven in `IntegrationsService.receiveOrder`: before
    any write, check for an existing `success` row with the same
    `(connectorId, eventType, externalReference)` and return the cached
    result marked `duplicate: true` if found.
  - `StoreConnectorAdapter` — the one interface every connector type
    implements (`testConnection`, `publishProduct`, …), so the service
    layer never branches by connector type.

  **This is precisely the shape §7/§8 of the request asks to design —
  it should be extended/mirrored, not reinvented.**

- **A mature, generic Excel import/export foundation exists**:
  `backend/src/foundation/excel/excel.service.ts`. `buildTemplate`,
  `buildExport`, and `parseWorkbook` (header-text-matched, not
  column-position-matched, so a reordered sheet doesn't silently corrupt
  data) are the ONE shared implementation every domain's import goes
  through — confirmed via `CustomersController`'s use of it
  (`import-template`, `import` routes). `ImportSummary<T>` (`totalRows,
  succeeded, rejected: {row, errors}[], warnings`) is the established
  result shape.
- **No "preview without commit" step exists anywhere.** `CustomersService.
  importRows` (the closest real precedent) validates and commits
  row-by-row in one pass — parse → validate → create, no dry-run stage.
  A true Preview (§3) would be new, though small: reusing the same
  `parseWorkbook` + the same per-row validation logic, minus the final
  commit call.
- **FA-01 (`ApprovalEngineService`) and `AuditService` are exactly as
  documented in ADR-059** — reusable as-is for attendance corrections/
  approvals and sensitive-action audit trails, zero new mechanism needed.
- **The `Employee` aggregate (ADR-059, HR Phase 1, CLOSED)** currently has:
  `id, code, fullName, departmentId, position, hireDate, status, userId,
  managerId, employmentType, terminationDate, terminationReason`. No
  attendance-related field exists on it, and this study does not propose
  adding one — mapping is external (§2/§6), matching the
  `IntegrationProductMapping` precedent exactly (never fold a foreign
  system's identifier into the core aggregate itself).

**INFERRED (reasonable extrapolation, not directly observed):** none
material — every claim above was directly verified against source.

**UNVERIFIED (explicitly flagged, not assumed):** any specific biometric
device vendor/protocol (ZKTeco, Hikvision, etc.) — no vendor is named in
the request, and none should be assumed. The adapter contract (§8) is
designed vendor-neutral for exactly this reason.

## 1. Gap Matrix

| Area | State | Note |
|---|---|---|
| Attendance domain (any) | NOT VERIFIED / does not exist | Full greenfield |
| Device/connector adapter pattern | VERIFIED, reusable | `foundation/integrations` |
| Excel/CSV import foundation | VERIFIED, reusable | `foundation/excel` |
| Import "preview" (dry-run) | NOT VERIFIED / does not exist | Small, disclosed net-new capability |
| Approval engine (FA-01) | VERIFIED, reusable | No new mechanism needed |
| Audit trail mechanism | VERIFIED, reusable | No new mechanism needed |
| Employee aggregate | VERIFIED, stable, unmodified by this study | ADR-059 |
| `attendance` module code | NOT VERIFIED / not reserved | Open Decision D-ATT1 |
| Payroll | VERIFIED, does not exist (Wave 3, correctly out of scope) | Confirmed zero payroll code anywhere |

## 2. Proposed bounded context / data boundary

**Attendance is its own bounded context**, not a sub-feature of HR's
Employee-directory concerns and not a stand-in for Payroll — per the
directive's own explicit instruction not to merge these. It sits *between*
HR and Payroll on the data-flow diagram the directive itself specified:

```
Biometric Device / Excel / API / Manual
        ↓
Attendance Raw Records
        ↓
Attendance Processing
        ↓
Approved Attendance Results
        ↓
Payroll Engine
```

Concretely: Attendance depends on HR (to resolve `employeeId` — a plain
uuid reference, the same "no cross-schema FK, no shared internals"
convention every domain in this codebase already follows, e.g. `Employee.
departmentId` into `OrgUnit`). HR has zero dependency back on Attendance.
Payroll (Wave 3, not started) will later depend on Attendance's own
*output* (Approved Attendance Results), never on raw device data — this is
the whole point of the layered pipeline the directive specified, and it is
the correct way to keep Payroll "independent of how the data arrived,"
exactly as requested.

## 3. Raw Attendance model (conceptual — no schema authorized yet)

One row per individual punch/event, preserved verbatim, never mutated
after ingestion (write-once, same discipline as `IntegrationSyncLog` and
the Black Box's own "never updated once complete" convention):

- `id`
- `sourceType` (`biometric_device | excel_import | api | manual`)
- `sourceConnectorId` (nullable — references a connector row, §8; null
  for manual entry)
- `deviceEmployeeRef` (the raw identifier the SOURCE used — a fingerprint
  device's internal user id, an Excel row's employee code column, etc. —
  **not yet resolved to a Daii `employeeId`** at this layer)
- `resolvedEmployeeId` (nullable — filled in once mapping, §6, succeeds;
  null means "unknown device user," a real, expected, non-error state per
  §2's own requirement to handle it, not silently drop it)
- `punchTimestamp` (device/source-reported, kept exactly as received)
- `punchType` (`in | out | unknown` — many biometric devices don't
  reliably distinguish; `unknown` is a legitimate value, not an error)
- `importBatchId` (nullable — links every row from one Excel/API batch;
  null for a single real-time device punch)
- `rawPayload` (jsonb — the untouched original record, for audit/replay;
  mirrors `IntegrationSyncLog.detail`'s "keep the raw thing" discipline)
- `ingestedAt`, `ingestedByUserId` (null for automated device/API ingestion,
  set for manual entry — same `actorUserId: string | null` convention
  `AuditService`/`EventBusService` already use for system-vs-human actions)

**Never updated in place.** A correction is a NEW row (or a Processing-
layer override, §4) with lineage back to the original — the raw record is
evidence, not a working copy.

## 4. Processed Attendance model (conceptual)

Two levels, matching the directive's own vocabulary and deliberately
NOT collapsing them into one table (an attendance *day* is a derived
aggregate over 1+ raw punches, not itself a punch):

- **AttendanceDay** — one row per `(employeeId, calendarDate)`:
  `checkIn`, `checkOut` (both nullable — `missingPunch` is a real,
  first-class state, not an error the pipeline chokes on), `status`
  (`present | absent | on_leave | missing_punch | holiday` — **the exact
  determination of `late`/`early_departure`/`overtime` values is
  UNRESOLVED BUSINESS POLICY, §11** — this study defines the SLOTS these
  concepts occupy, never the thresholds/rules that fill them), `shiftId`
  (nullable — shift assignment is itself dependent on an
  UNRESOLVED BUSINESS POLICY, §11, about how shifts are modeled/assigned),
  `sourceRawRecordIds` (the punches this day was derived from, for
  traceability), `correctionOf` (nullable self-reference — an amended day
  points at what it replaces, never silently overwrites it).
- **AttendanceApprovalBatch / ApprovedAttendanceResult** — the FA-01-gated
  gate the directive's own diagram requires between Processing and
  Payroll. An `AttendanceDay` only becomes payroll-visible once a batch
  containing it is approved — mirrors `ClosingWorkflowRun`'s own "a period
  isn't closed until every gate has passed" discipline from Month-End
  Closing, reused as a pattern, not as code.

## 5. Employee / device mapping model

Directly modeled on `IntegrationProductMapping` (§0), because the shape
is identical — an internal Daii id ↔ an opaque external identifier, unique
both directions, surviving unrelated changes on either side:

- `id`
- `connectorId` (which device/source this mapping belongs to — the SAME
  fingerprint id on two different devices are different mappings, not
  accidentally merged)
- `employeeId`
- `deviceUserRef` (the device's own user/fingerprint id)
- `effectiveFrom` / `effectiveTo` (nullable `effectiveTo` = currently
  active) — this is the answer to the directive's own "device id changes
  without losing history" requirement: **closing** a mapping (setting
  `effectiveTo`) and opening a new one preserves every raw record's
  original `deviceEmployeeRef` resolution history, rather than mutating a
  single mapping row in place and silently reattributing old punches.
- Uniqueness: `(connectorId, deviceUserRef)` where `effectiveTo IS NULL`
  — exactly one ACTIVE mapping per device-side identifier at a time
  (prevents the directive's own "duplicate mapping" concern); a given
  `employeeId` may have multiple active mappings across different
  connectors (one employee, several devices) but never two active
  mappings to the SAME connector.
- **Unknown device user** (no mapping found): the raw record persists with
  `resolvedEmployeeId: null` and is surfaced in an operator-facing
  "unmapped punches" queue — never silently dropped, never blocking the
  rest of the batch.

## 6. Import contract (Excel/CSV — reuses `ExcelService`, §0)

`ExcelService.buildTemplate`/`parseWorkbook` are reused as-is. New,
disclosed capability: a **Preview** step (§0's identified gap) — run the
same per-row validation `CustomersService.importRows` already does
(required fields, employee-mapping resolution, duplicate-punch detection)
but WITHOUT calling any create method, returning the same `ImportSummary<T>`
shape so the operator sees exactly what would happen before committing.

Pipeline: **Excel/CSV template → upload → parse (`ExcelService`) →
preview (validate only) → operator confirms → import (persist Raw
Attendance rows + import batch record) → import audit (`AuditService`) →
failure/error report (the `rejected` array, downloadable) → idempotent
re-import** (same idempotency check as `IntegrationsService.receiveOrder`:
a `(importBatchId-or-file-hash, deviceEmployeeRef, punchTimestamp)` key
prevents the same file being imported twice from creating duplicate raw
records — mirrors `IntegrationSyncLog`'s own proven pattern exactly).

## 7. Integration adapter contract (device-neutral)

One interface, mirroring `StoreConnectorAdapter` exactly:

```
interface AttendanceDeviceAdapter {
  testConnection(config, credential): Promise<{ok, deviceIdentity?, error?}>
  fetchPunches(config, credential, since?: Date): Promise<RawPunch[]>
  // 'since' supports incremental polling; a device with only "dump everything"
  // capability just ignores it and relies on the idempotency key (§6) instead.
}
```

`CONNECTOR_TYPES` gains new entries only by code change (e.g.
`'attendance_device_generic'`, or a specific `'attendance_device_zkteco'`
once a real vendor is chosen) — never a schema migration, exactly matching
the existing `qr_store` precedent. `IntegrationConnector`/
`IntegrationCredential` are reused UNCHANGED — no attendance-specific
columns added to them (a `deviceType`/vendor discriminator lives in
`config`, matching how `qr_store`'s own `apiUrl`/`systemUserId` already
live in `config` rather than as dedicated columns).

## 8. Payroll integration boundary (no policy invented)

Per instruction, this defines the SHAPE only. Payroll (Wave 3, not
started) will eventually consume exactly one thing from Attendance: an
**Approved Attendance Result** per `(employeeId, payPeriod)` — however
Payroll itself defines a pay period, which this study does not assume.
Attendance publishes a domain event (`attendance.period.approved`, same
`EventBusService.publish` mechanism every other domain uses) once a
batch's FA-01 approval lands; Payroll subscribes to it exactly the way
`FiscalPeriodService` subscribes to `approval.request.approved` today —
zero new event mechanism. Attendance never computes pay, overtime pay
rate, or any monetary amount — it hands Payroll *facts* (hours present,
late minutes, absence days — themselves dependent on the UNRESOLVED
BUSINESS POLICY items in §11), never a computed wage.

## 9. Permissions / Audit / SoD

No new mechanism — the existing `PermissionService` ancestor-walk and
`AuditService` are reused exactly as HR Phase 1 reused them. Candidate
nodes (naming only — not authorized for creation yet):

- `attendance.raw_record.view`
- `attendance.import.create` / `.view` (the import action itself)
- `attendance.mapping.create` / `.edit` (device↔employee mapping — its own
  node, matching the "one sensitive action, one node" convention `hr.
  employee.terminate`/`.link_user` already established)
- `attendance.correction.create` (amending a processed day — mirrors
  `hr.employee.edit`'s shape)
- `attendance.approval.approve` (the FA-01 checker side — reuses the
  engine, needs only its own permission node, same as `hr.leave_request.
  approve`)
- `attendance.manual_entry.create` (administrative manual punch entry —
  its own node, since it bypasses every device/import safeguard and is
  exactly the kind of action that needs its own narrow gate)
- `attendance.reprocessing.create` (re-running Processing over existing
  raw records — a distinct, audit-worthy action from either import or
  correction)

**SoD**: import/manual-entry (maker) vs. approval (checker) is the natural
split, identical in shape to HR's leave-request maker/checker split —
FA-01 handles it with zero new infrastructure.

## 10. Migration impact (for the eventual Phase 1 — not authorized now)

Entirely additive, new tables only (no existing HR/Payroll-adjacent table
is altered): raw attendance records, attendance days, approval batches,
device/employee mappings, import batches. `IntegrationConnector`/
`IntegrationCredential`/`IntegrationSyncLog` are reused UNCHANGED (no
migration against them at all) if `CONNECTOR_TYPES` is simply extended in
code, per §7.

## 11. Required business-policy decisions — escalated, not assumed

Per instruction, none of the following are decided by this study; each is
recorded as **UNRESOLVED BUSINESS POLICY**, to be answered before or
during the Phase 1 contract, not invented here:

- **D-ATT1 (architecture, not policy):** should `attendance` be its own
  top-level module code (its own manifest, own `RESERVED_MODULE_CODES`
  entry — currently absent, §0) or a sub-domain under `hr`'s existing
  module code with its own permission subtree? Both are structurally
  possible; this is a genuine "new architectural boundary" decision under
  ADR-053 §16, not an implementation default.
- **Late / early-departure thresholds** — what counts as "late," by how
  many minutes, and does it vary by shift/department/employment type?
- **Overtime definition and eligibility** — which employment types (full-
  time/part-time/contractor, per ADR-059's own `EmploymentType`) are
  overtime-eligible at all, and what threshold defines "overtime"?
- **Absence classification** — how does an `AttendanceDay` with zero
  punches get classified (absent vs. missing_punch vs. approved leave —
  and how does this reconcile with HR's OWN existing `LeaveRequest`,
  ADR-059, which this study deliberately does NOT re-derive attendance
  status from without an explicit decision to link the two)?
- **Shift model** — fixed shifts, rotating shifts, flexible hours? Who
  assigns an employee to a shift, and does that belong to Attendance or to
  HR's own `Employee` aggregate?
- **Multi-punch-per-day handling** — a device recording more than one
  in/out pair per day (breaks, multiple entries) — which pair(s) count?
- **Rounding rules** — does a punch at 08:59 vs 09:01 get rounded, and to
  what granularity?
- **Holiday/weekend calendar** — does one already exist anywhere in this
  codebase for any other purpose (unverified — not found in this study's
  search scope) or does Attendance need its own?
- **Correction authority** — who may amend an `AttendanceDay` after the
  fact, and does every correction require FA-01 approval or only some
  (mirrors ADR-059 D3's own "not every sensitive action needs FA-01"
  precedent, but the actual line is a business decision, not an
  engineering default).

## 12. E2E acceptance scenarios (for the eventual Phase 1 contract)

1. A biometric device connector is registered, tested, and begins
   producing raw punches with `resolvedEmployeeId` correctly populated via
   an active mapping.
2. A punch from an unmapped device user is preserved (not dropped),
   surfaced in an unmapped-punches queue, and correctly resolves
   retroactively once a mapping is created (existing raw records are
   re-resolved, never silently orphaned).
3. An Excel file is uploaded → template-validated → previewed (no writes
   yet) → operator confirms → imported → a re-upload of the SAME file is
   correctly detected as a duplicate and skipped, not double-imported.
4. A device identifier is reassigned (old device retired, new one issued
   to the same employee) — old punches remain attributed correctly; new
   punches resolve under the new mapping; no history is lost or merged.
5. An `AttendanceDay` is manually corrected — the original raw records are
   untouched; the correction is traceable back to what it replaced and to
   who made it.
6. An attendance approval batch is submitted, appears in the existing
   `ApprovalsPanel`-equivalent, is approved by a second user (SoD
   enforced exactly as HR Phase 1 proved live), and only THEN does
   `attendance.period.approved` fire.
7. Unauthorized users are blocked (403-equivalent, permission-resolution
   proof) from import, mapping, correction, manual entry, and approval —
   each its own node.
8. Full regression / clean build / live verification — same bar as every
   prior phase in this program.

## 13. Explicit Non-Goals (this study and the eventual Phase 1)

- **No Payroll implementation, salary calculation, or wage computation of
  any kind.** Payroll remains Wave 3, untouched.
- **No overtime/absence/late policy invented.** Every such rule is §11,
  escalated.
- **No modification to HR Phase 1 or ADR-059.** The `Employee` aggregate,
  its permissions, and its own workflows are read-only inputs to this
  study, never altered by it.
- **No specific biometric vendor selected or integrated.** The adapter
  contract (§7) is vendor-neutral; choosing/building a specific device
  adapter is future Phase 1+ work, contingent on knowing which device(s)
  the business actually uses (unverified, not assumed).
- **No schema, migration, or frontend code.** This document is planning
  only, per the explicit instruction.

## 14. Implementation Phases (proposed, not authorized)

Mirrors the same phased, tested-as-you-build discipline as HR Phase 1:

1. **Phase 1a — Foundation**: raw attendance model, device/employee
   mapping model, manual entry (the simplest source, proves the pipeline
   end-to-end without needing a real device or file format yet).
2. **Phase 1b — Import**: Excel/CSV pipeline (template, preview, import,
   idempotent re-import, failure report) — reuses `ExcelService`.
3. **Phase 1c — Device Adapter**: the `AttendanceDeviceAdapter` contract
   + `CONNECTOR_TYPES` extension, against whichever real device is chosen
   (blocked on an actual vendor decision, §11/§0 UNVERIFIED item).
4. **Phase 1d — Processing & Approval**: `AttendanceDay` derivation (once
   §11's policy decisions are ratified), the FA-01 approval batch gate,
   and the `attendance.period.approved` event Payroll will later consume.

Each phase follows the established Resolve → Implement → Test → Verify →
PASS → Continue discipline; none of them are authorized to begin by this
document.

---

**No code, migration, schema, or frontend change was made to produce this
study.** HR Phase 1 (ADR-059) is not reopened or modified. Payroll is not
started. Production remains HOLD. This document stops at STUDY/VERIFY —
awaiting the CTO's review, resolution of §11's escalated policy items and
D-ATT1, before any Phase 1 implementation contract is written.
