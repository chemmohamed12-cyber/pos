# Changelog

All notable changes to the DAII platform. Dates are UTC. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

## [1.1.1] — 2026-09-21

### Fixed
- **Release candidate-verification blocker.** `v1.1.0` was uploaded to
  the real Hosting Release Center and **failed** its own
  `dependencies_resolve` candidate-verification check:
  `@types/yauzl` — a TypeScript type-definitions-only package, no
  runtime code — was misdeclared under `package.json`'s `dependencies`
  instead of `devDependencies` (every other `@types/*` package in this
  same file was already correctly classified; this was the one
  outlier). A production-only install correctly never installs
  `devDependencies`, so the real `yauzl` package (genuinely needed at
  runtime by the Release Engine's own package validator) resolved fine,
  while the misclassified `@types/yauzl` did not. Moved to
  `devDependencies`; no application/business logic touched. Added a
  permanent regression guard (`dependency-classification.spec.ts`) so
  an `@types/*` package can never again be declared as a runtime
  dependency. `v1.1.0` is superseded and was never activated on
  Hosting — see `MANIFEST.md`.

## [1.1.0] — 2026-09-21

### Added
- **Commission & Target Management (ADR-071).** Commission Resolution
  Engine (Customer → Customer Group [architecturally present,
  functionally inert pending a CRM dependency] → Sales Rep precedence),
  flat and marginal-tiered rate calculation against an Approved Target,
  immutable `CommissionResult` snapshots with a deterministic dedup key,
  FA-01 approval batches, and Target Management (non-overlap enforced via
  a Postgres `EXCLUDE` constraint). Full backend (entities, migrations,
  services, controllers, permissions, terminology) and frontend (cover,
  policies, results/adjustments, batches).
- **Payroll → Commission consumption (ADR-070 §J).** `PayrollService.
  calculate()` now populates `PayrollRunLine.commissionAmount` from an
  employee's Approved Commission Results for the run's period.
- **Integrated Attendance → Payroll → Commission → GL E2E verification
  (ADR-072).** Proves both chains converge correctly in one `PayrollRun`
  and that `PayrollRun.status = 'posted'` is never, by itself, treated
  as evidence of GL posting success.

### Fixed
- **Commission UTC day-boundary defect.** `CommissionService.
  submitApprovalBatch`/`listApprovedCommissionResults` compared a
  `timestamptz` column against naive date-only boundary strings, letting
  the DB session's configured timezone silently exclude a
  `CommissionResult` calculated in the last hours of a UTC calendar day.
  Fixed via explicit UTC instants.
- **F03 GL Posting Concurrency deadlock (Option B + C).** A Postgres
  deadlock (`40P01`) between `numbering_sequences` and `audit_records`
  locks inside the generic journal-posting gate could terminally reject
  an otherwise-valid Financial Event under concurrent posting. The
  posting gate now retries a detected deadlock automatically (bounded, 3
  attempts) — safe by Postgres's own guarantee that a deadlock loser's
  transaction made no persistent change. A new `TRANSIENT_DATABASE_ERROR`
  Closing Audit exception category distinguishes this class from a
  genuine defect requiring investigation. Option A (the deeper
  lock-order restructuring) is a separately-reviewed follow-up, not
  included in this release.
- **Two ProcessEngine/domain-row transaction-safety gaps**, found via the
  Target non-overlap test: `TargetService.onApprovalApproved`/
  `onApprovalRejected` and `CommissionService.onApprovalApproved`/
  `onApprovalRejected` now wrap their ProcessEngine transition and
  entity save in one DB transaction (matching `PayrollService`'s own
  proven shape), so a downstream constraint violation can never leave
  ProcessEngine state ahead of the row it describes.

### Migrations
- `targets`: core schema, admin permission seed, terminology (3
  migrations).
- `commission`: core schema, admin permission seed, terminology, a
  correction to a stale Payroll UI notice (4 migrations).
- `accounting`: widen the Closing Exception `category` CHECK constraint
  to add `TRANSIENT_DATABASE_ERROR` (1 migration).

See `MIGRATION_REPORT.md` for the full applied list and verification.

## [1.0.10] and earlier

Pre-dates this changelog. See git history (`git log --oneline`) for the
full commit-level record — Attendance Phase 1 (biometric import),
Payroll Phase 1 (core, Treasury disbursement, frontend), Manufacturing
Phases 1–3, HR Phase 1, and the full F01–F11 Accounting/Finance build-out.
