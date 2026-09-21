# Release Notes — v1.1.1

**v1.1.0 superseded** — it failed real Hosting candidate verification
(`@types/yauzl` misdeclared as a runtime dependency) and was never
activated. v1.1.1 fixes only that dependency-classification defect; see
`CHANGELOG.md`. Everything below still describes what's functionally
new in this release.

**Release date:** 2026-09-21
**Type:** Minor feature release — Hosting test candidate (not a
production deployment authorization)
**Base version:** 1.0.10

## What's new

### Commission & Target Management
A full new module pair covering the sales-commission lifecycle:
- **Target Management** — set an Employee's Target for a period, with
  FA-01 approval and non-overlap enforcement.
- **Commission Resolution Engine** — automatically calculates a Sales
  Rep's commission when an Invoice posts or a Collection remits, using a
  Customer-scoped policy when one exists, falling back to the Sales
  Rep's own default policy otherwise. Supports both a flat rate and a
  marginal-tiered rate model (tiers applied against Target achievement).
  Every calculated result is an immutable, auditable snapshot.
- **Commission Approval Batches** — FA-01 maker/checker review before a
  batch of results becomes available to Payroll.
- **Payroll integration** — an employee's Approved Commission Results
  now flow automatically into their next payroll run's net pay.

### Integrated verification
A dedicated end-to-end test proves the full chain — Attendance facts →
day-type classification, and Sales → Commission → Approval — both
correctly converge in a single Payroll Run, post exactly one balanced GL
journal, and that a Payroll Run reaching "posted" is never mistaken for
proof the GL journal actually exists (that's confirmed independently,
from the accounting system's own Financial Event record).

### Reliability fix — GL posting under load
Under concurrent posting activity, the accounting engine's GL-posting
step could occasionally hit a database-level deadlock and reject an
otherwise valid transaction, requiring manual recovery. The posting
engine now detects this specific, transient condition and retries
automatically — the deadlock's own database guarantee makes this safe
(nothing was ever partially recorded). A reviewer looking at any
remaining exception can now immediately tell "this one just needs a
retry" from "this one needs real investigation."

### Bug fix — Commission timing near midnight UTC
A Commission result calculated in the last few hours of a calendar day
(UTC) could be incorrectly excluded from that day's approval batch, due
to a timezone-comparison bug. Fixed; regression-tested.

## Who should test this on Hosting

- Anyone verifying the Commission/Target UI and workflow end to end.
- Anyone verifying Payroll runs that include commission-earning
  employees.
- Anyone stress-testing concurrent GL posting (multiple Payroll runs,
  invoices, or Manufacturing Work Orders posting at the same time).

## What this release does NOT include

- Option A of the F03 remediation (the deeper GL-posting lock-order
  restructuring) — deferred as a separately-reviewed follow-up.
- A `CustomerGroup` entity or Customer-Group-tier commission resolution
  — blocked on a CRM dependency, not part of this release's scope.
- Contractor payroll, automatic tax/gratuity/overtime calculation, or a
  Holiday Calendar — all remain open, explicitly out-of-scope items
  carried from the Payroll/Commission policy decisions (`ADR-067`/
  `ADR-068`).
- Any change to Manufacturing, WIP valuation, or WIP reconciliation.

## Deployment status

This is a **Hosting-test release candidate**, built and verified for
testing purposes. It is **not** an authorization to deploy to
production. See `DEPLOY_INSTRUCTIONS.md` for how to load this package
onto a Hosting test target, and `TEST_REPORT.md` / `MIGRATION_REPORT.md`
for the full verification evidence behind this release.
