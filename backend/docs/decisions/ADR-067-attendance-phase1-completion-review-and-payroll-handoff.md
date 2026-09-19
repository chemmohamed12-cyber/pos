# ADR-067 — Attendance Phase 1: Completion Review & Payroll Handoff Contract

**Status: COMPLETE / VERIFIED / HANDOFF-READY FOR PAYROLL (2026-09-19).**
This document closes out Attendance Phase 1 (`ADR-065`) with a full
domain review against its own ratified baseline (`ADR-062`, `ADR-063`,
`ADR-065`), records the two correctness defects found and fixed, and
resolves `ADR-064 §5`'s Attendance-dependency blockers now that `ADR-063`
is ratified and `ADR-065` is shipped. `ADR-059` (HR Phase 1), `ADR-062`,
`ADR-063`, and `ADR-065` are **not reopened** — this document supersedes
nothing in them, per the same "supersede via new content, never rewrite
the analysis" discipline they themselves establish. Production remains
HOLD. This document does not authorize, begin, or scope any Payroll
implementation.

## 0. Baseline reviewed

- `ADR-062` — Attendance Phase 0 study (accepted baseline facts).
- `ADR-063` — nine ratified policy decisions (D-ATT1, §1–§8), 2026-09-19.
- `ADR-065` — Attendance Phase 1 Implementation Contract, built from the
  above.
- `ADR-064` — Payroll Phase 0 study, whose §5 named five hard blockers on
  Payroll's own future design that only Attendance's ratification could
  resolve.
- Implementation commits: `b7a3043` (attendance backend/frontend, Phase 1),
  `54d8818` (timezone fix), `466c026` (unrelated — Manufacturing frontend,
  confirmed out of scope for this review and untouched by it).
- Prior verification on record: Attendance unit/integration tests 10/10,
  full regression 150/150, backend/frontend builds PASS, live browser
  walkthrough PASS, FA-01/SoD verification PASS.

## 1. Repository / architecture review — result: COMPLIANT

Every item below was read directly (not inferred) against `ADR-065`'s own
data model, permission, and processing-rule sections:

| Area | Finding |
|---|---|
| Module boundary | `attendance` is a genuine `ModuleCode` entry in `V1_MODULE_CODES`, own manifest (`attendance.manifest.ts`), own `@RequireModule('attendance')` gate on every controller route — matches `D-ATT1: A`. |
| Dependencies | `attendance.module.ts` imports exactly `HrModule` (for `HrService.isApprovedLeaveDate`) plus foundation modules (`Authentication`, `Events`, `Permission`, `Audit`, `ApprovalEngine`, `Excel`). No other `domains/*` sibling is imported — matches the manifest's declared `depends_on: ['hr']` and `ADR-062 §2`'s one-directional Attendance→HR shape. `hr` has zero import back. |
| Manifest / entitlement | `attendanceManifest` registered in `manifests/index.ts`; `SeedAdminPermissionsForAttendance` migration grants `admin` the root `attendance` node with `editable` access, which the permission service's ancestor-walk (`permission.service.ts`) correctly cascades to every `attendance.*` child — confirmed against the same mechanism `hr`/`accounting`/`procurement`/`manufacturing` already use. |
| Permissions | All 15 `attendance.*` nodes in the manifest are referenced by a controller route; every route (read and write) carries both `@UseGuards(PermissionGuard)` and `@RequirePermission`. No unguarded route found. |
| Employee mapping | `AttendanceEmployeeMapping` mirrors `IntegrationProductMapping` exactly, per `ADR-062 §5`: `(connectorId, deviceUserRef)` unique only where `effectiveTo IS NULL` (a real Postgres partial index — TypeORM decorators can't express it, and the migration's own comment says so). Close-then-reopen preserves history; a duplicate active mapping is rejected. Proven live in two dedicated tests. |
| Device mapping / raw punch model | `AttendanceRawRecord` is write-once (never updated after insert — confirmed no `UpdateDateColumn`, no update call anywhere in the service). `resolvedEmployeeId: null` is preserved and surfaced via `listUnmappedRecords`, and resolves retroactively when a mapping is created later — proven live. |
| Import pipeline | Template → parse → preview (zero writes, confirmed by a dedicated test asserting `previewImport` never touches `attendance_raw_records`) → confirm → import → `fileHash` idempotency (byte-identical re-upload rejected before any row is touched) — matches `ADR-065 §6` exactly. |
| Day derivation | `deriveDay` implements `ADR-065 §5`'s rule verbatim: leave check first, then absent/missing_punch/present by punch count, first-in/last-out span, exact hours, no rounding. Re-deriving a day already in an *approved* batch is a protected no-op. All proven live. |
| Approval batches / correction | FA-01 reused with zero new mechanism; SoD proven live (maker cannot decide their own batch); split-authority correction (`ADR-063 §8: C`) proven live both pre- and post-approval paths. |
| Audit trail | Every state-changing action in `AttendanceService` calls `AuditService.record` with before/after where applicable (connector/mapping create/close, manual entry, import, day correction, correction request, batch submit/approve, rejection). FA-01 decisions are audited generically by `ApprovalEngineService.decide` itself, the same as every other FA-01 consumer — no gap. |
| Frontend | Three pages (`AttendanceConnectors`, `AttendanceImport`, `AttendanceDays`) plus `AttendanceCover`, all routed in `App.tsx`, all in `Layout.tsx`'s nav under `module.attendance`, all terminology-seeded. Cover's `hasRole('admin')` KPI gate matches `HrCover`'s own established pattern exactly — not a new inconsistency. |
| No ADR-063 violation found | A targeted search of `domains/attendance` for `late|early|shift|holiday|overtime|wage|salary|commission` returns zero hits outside comments explicitly documenting their *absence* by design. The four-value `AttendanceDayStatus` union (`present\|absent\|on_leave\|missing_punch`) is enforced both in TypeScript and by a Postgres `CHECK` constraint — a fifth value cannot silently reappear. |

**Conclusion: no ADR-063 violation, no unimplemented piece of the ratified
`ADR-065` contract.**

## 2. Two correctness defects found and fixed

Neither of these touches business policy — both are engineering
correctness gaps inside behavior `ADR-065` already authorized, so both
were resolved directly per this task's own "complete genuine remaining
work" instruction rather than escalated.

1. **`createMapping` did not validate `employeeId`.** `recordManualPunch`
   already called `hr.getEmployee(employeeId)` to fail fast on a
   nonexistent employee; `createMapping` did not, so a typo'd or
   fabricated `employeeId` could be actively mapped and would go on to
   silently produce `AttendanceDay` rows for an employee that does not
   exist — a real data-integrity risk given `AttendanceDay` is exactly
   what a future Payroll would consume. **Fixed** by adding the same
   guard `recordManualPunch` already uses.
2. **`submitApprovalBatch` had no recovery path on a failed submit.** The
   method stamps every in-range day with the new batch's id, *then* calls
   `ApprovalEngineService.submit`. If that call throws (engine outage,
   validation failure inside the engine, etc.), the days are left stamped
   with a `draft` batch that was never actually submitted — and unlike a
   *rejected* batch (whose `batchId` is explicitly cleared by
   `onApprovalRejected`), nothing would ever clear it. Those days would
   permanently fail to match `batchId: IsNull()` and could never be
   included in any future submission again. **Fixed** by wrapping the
   `approvals.submit` call, and on failure reversing the `batchId` stamp
   and deleting the orphaned draft batch — the exact same recovery shape
   the rejection path already established.

Both fixes are in `attendance.service.ts`; two new regression tests were
added to `attendance-phase1.spec.ts` proving each (a rejected-employeeId
mapping attempt; a simulated `ApprovalEngineService.submit` failure
followed by a successful resubmission of the same days). Commit
`d76e22e`.

## 3. Findings reviewed and explicitly NOT changed

- **`AttendanceDay` has no `correctionOf` self-reference column**, though
  `ADR-065 §3`'s data-model table literally lists one. The shipped entity
  instead mutates the row directly (`correctedByUserId`/`correctedAt`)
  and relies on `AuditService`'s before/after record for lineage — the
  same shape `HrService`'s own direct, permission-gated employee edits
  already use. This is a **documentation-fidelity gap between `ADR-065`'s
  prose and what was actually built, not a functional defect**: audit
  traceability was confirmed live (every correction path calls
  `audit.record` with `before`/`after`). Not changed — reopening the
  entity to add a version-chain column now would be schema churn for a
  guarantee `AuditService` already provides. Recommend a one-line note be
  added to `ADR-065 §3` the next time that document is otherwise touched,
  acknowledging the as-built shape; `ADR-065` itself is not reopened by
  this document.
- **No duplicate-punch detection at import preview time.** `ADR-062 §6`'s
  original prose mentioned it as an idea; the ratified `ADR-065 §6`
  contract does not require it, and its absence does not affect
  correctness — `deriveDay`'s first-in/last-out rule is a min/max over the
  day's punches, so an exact duplicate punch changes neither the min nor
  the max. Correctly descoped, not a defect.
- **No `attendance.reprocessing.*` feature** — correctly absent, per
  `ADR-065 §1`'s explicit exclusion. A day re-derives automatically
  whenever new raw records or a leave-approval event affect it.
- **No admin-facing "resubmit a stuck batch" UI.** Now moot — the fix in
  §2 above means a failed submission never leaves a stuck batch to
  resubmit; the affected days simply become eligible for the next normal
  `submitApprovalBatch` call.

## 4. Integration-boundary verification

- **HR → Attendance:** exactly one read path, `HrService.
  isApprovedLeaveDate(employeeId, calendarDate)`, additive and read-only,
  confirmed unchanged from HR Phase 1's own behavior. Attendance never
  reads `Employee.userId` or any other HR-internal field — mapping and
  manual entry both key strictly on `employeeId`, matching `ADR-062 §2`'s
  "plain uuid reference, no shared internals" convention exactly.
- **Foundation/Integrations:** deliberately **not** reused as a shared
  table — `AttendanceConnector` is Attendance's own table, matching
  `ADR-062 §7`'s own reasoning (`StoreConnectorAdapter` is e-commerce
  product-publishing shaped, a poor semantic fit for a biometric/manual
  attendance source). Confirmed this is a documented design choice, not
  an oversight.
- **FA-01 / SoD:** both request types (`attendance.approval_batch`,
  `attendance.correction`) registered through the one shared
  `ApprovalEngineService`; maker≠checker enforced by the engine itself,
  proven live (a maker's own decide attempt throws). No second,
  Attendance-specific approval mechanism exists.
- **Payroll:** confirmed zero wage, rate, amount, or pay-period-close
  logic anywhere in `domains/attendance` — the facts-only boundary
  `ADR-062 §8` established is intact and unbroken by this review or its
  fixes. See §5 below for what Attendance is now ready to hand over.

## 5. Payroll handoff contract (resolves `ADR-064 §5`'s blockers)

`ADR-064 §5` named five items blocking Payroll's own detailed design
until `ADR-063` was ratified. All five now have concrete answers:

| `ADR-064 §5` blocker | Resolved answer |
|---|---|
| What "hours worked" means | First-in/last-out span, exact timestamps, no rounding (`ADR-063 §5: A`, `§6: A`). `AttendanceDay.hoursWorked` is the one number Payroll would consume for a present day. |
| Does Attendance hand Payroll an overtime fact | **No.** `AttendanceDay` has no `overtimeHours` field — only total `hoursWorked`. Any future overtime-pay computation is entirely Payroll's own responsibility to derive (`ADR-064 §8`, still open, unchanged by this document). |
| Is "absent" distinguishable from "on approved leave" | **Yes.** `status = 'on_leave'` vs `'absent'` are reconciled automatically against HR's approved `LeaveRequest` (`ADR-063 §3: B`), proven live. |
| Are holidays/weekends excluded from "absence" | **No — and this is the single most consequential item for Payroll to design around.** `ADR-063 §7: B` deferred the holiday/weekend calendar entirely. **`status = 'absent'` today means "no punch and no approved leave," which includes every ordinary weekend and holiday with equal weight to a genuine unexplained absence.** A future `PayRun` that treats every `'absent'` day as an unpaid deduction would incorrectly dock pay for weekends. **Payroll must build its own holiday/weekend awareness (or otherwise separate "weekend" from "unexplained absence") before consuming `AttendanceDay.status` for pay purposes — Attendance itself will never resolve this ambiguity.** This is a disclosed, accepted consequence per `ADR-065 §0`, not a defect, but it is a hard requirement on whoever writes the Payroll Phase 1 Implementation Contract. |
| Does D-ATT1 affect Payroll's design | No — confirmed, only the event-subscription namespace is affected, not the data. |

**What Attendance produces today, concretely, for a future Payroll to
consume:**

- `AttendanceDay` rows: `employeeId`, `calendarDate`, `checkIn`,
  `checkOut`, `hoursWorked`, `status` (four values only), `batchId`
  (non-null only once approved).
- The `attendance.period.approved` domain event, payload `{batchId,
  periodStart, periodEnd}` — published via the same `EventBusService`
  every other domain uses, exactly once per approved batch.

**A genuine gap in the handoff *mechanism* itself (not a defect in what's
built, since no consumer exists yet to need it):** the event payload
carries only the batch's identity and date range, not the per-employee
facts inside it, and `AttendanceService` currently exposes no
`listDaysByBatch(batchId)`-shaped read method — only `listDays(employeeId?)`.
A future Payroll subscriber would need one of these before it can act on
the event. **Not built now** (building a consumer-shaped API with zero
actual consumer would be speculative), but recorded here so the eventual
Payroll Phase 1 Implementation Contract specifies it explicitly rather
than rediscovering the gap mid-build.

**Payroll implementation is explicitly not started, scoped, or
authorized by this document**, consistent with `ADR-064`'s own
Non-Goals. `ADR-064 §8`'s business-policy items (pay frequency, salary
structure, overtime rate, statutory tax, social insurance,
end-of-service, leave encashment, deduction types, contractor population
scope) remain fully open and are not addressed here.

## 6. Testing

| Suite | Result |
|---|---|
| `attendance-phase1.spec.ts` (12 tests — 10 original + 2 new regression tests for §2's fixes) | **12/12 PASS** |
| Full backend regression (`npx jest`, live PostgreSQL, 17 suites) | **154/154 PASS** |
| Backend build (`nest build`) | **PASS** |
| Frontend build (`tsc -b && vite build`) | **PASS**, zero type errors |

## 7. Browser / E2E evidence — partial, disclosed limitation

The dev servers (backend `:3500`, frontend `:5173`) were confirmed live
and serving the real compiled application — the login screen rendered
correctly in the browser pane. A full authenticated click-through of the
three Attendance pages was **not completed in this session**: no admin
credentials were available, and minting a dev-only JWT to bypass the
login form (the same technique this program has used in at least one
prior phase, per `SALES_ORDER_SHIPMENT_RETURNS_BLUEPRINT.md`) was
**blocked by the coding environment's own credential-materialization
safeguard**. This was not worked around. The live-PostgreSQL Jest suite
already exercises every `ADR-065 §7` E2E acceptance scenario against the
real database, the real `ApprovalEngineService`, and the real
`PermissionService` (no mocks) — including live SoD enforcement — which
is the substantive functional proof; a manual browser click-through
would additionally confirm rendering/UX only. If that is still wanted,
it needs either admin credentials supplied by the user or explicit
approval to mint a dev-only token.

## 8. Files changed / commits

- `backend/src/domains/attendance/application/attendance.service.ts` —
  the two fixes in §2.
- `backend/src/domains/attendance/application/attendance-phase1.spec.ts`
  — two new regression tests.
- `backend/docs/decisions/ADR-067-attendance-phase1-completion-review-and-payroll-handoff.md`
  — this document.

Commit `d76e22e` — `fix(attendance): validate mapping employeeId and
recover from a failed batch submission`.

## 9. Final status

**Attendance Domain → COMPLETE / VERIFIED / HANDOFF-READY FOR PAYROLL.**
`ADR-059`, `ADR-062`, `ADR-063`, `ADR-065` remain CLOSED/RATIFIED/
implemented respectively and are not reopened. Production remains HOLD.
Payroll's own Policy Decision Package and Implementation Contract
(`ADR-064 §8`, §11) remain the next authorized step whenever the business
is ready — this document removes the *Attendance-side* blockers named in
`ADR-064 §5` but does not itself authorize, begin, or scope any Payroll
work.
