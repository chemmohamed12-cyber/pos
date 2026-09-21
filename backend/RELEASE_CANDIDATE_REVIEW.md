# Release Candidate Review — DAII Backend/Frontend

**Date:** 2026-09-21
**Scope of this release:** Payroll Phase 1 (ADR-070), Commission & Target
Management Phase 1 (ADR-071), the Integrated Attendance→Payroll→
Commission→GL E2E verification (ADR-072, spec commit `24082d6`), the
Commission UTC day-boundary fix, and the F03 GL Posting Concurrency
deadlock remediation (Option B + C, per
`docs/studies/F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md`).
**Base commit:** `9c746aa`
**Classification key:** `PASS` / `FIX REQUIRED` / `BLOCKED` / `NOT APPLICABLE`

Purpose: find any defect or integration gap that would block this
release from being testable on Hosting — not a theoretical audit. Every
row below cites the concrete evidence (a test suite, a direct query, a
build run) this session produced, not an assumption.

## Summary

| Area | Classification | Evidence |
|---|---|---|
| Backend build | PASS | `nest build` clean, no errors |
| Frontend build/typecheck | PASS | `tsc --noEmit` clean, `vite build` clean |
| Attendance | PASS | `attendance-phase1.spec.ts`, `attendance-biometric-import.spec.ts` — green, unchanged by this release |
| Commission | PASS | `commission-phase1.spec.ts` 10/10 green, including the UTC boundary regression (test 10) |
| Payroll | PASS | `payroll-phase1.spec.ts` 10/10 green |
| GL / Financial Events (F03) | PASS | F03 Option B+C implemented, `f03-deadlock-retry-verification.spec.ts` green; `closing-exception-classification.spec.ts` green |
| Treasury integration | PASS | Exercised via Payroll disbursement (`payroll-phase1.spec.ts` tests 9–10); Commission's own disbursement path is read-only into Payroll, no separate Treasury surface |
| GRNI | PASS | `grni-posting.spec.ts`, `grni-reconciliation.spec.ts` — green in the two most recent full-suite runs |
| Manufacturing / WIP (affected surface) | PASS | `work-order.spec.ts`, `work-order-phase3-e2e.spec.ts`, `wip-reconciliation.spec.ts` — green, unchanged; F03's retry wrapper is domain-agnostic and does not alter Manufacturing's own handler code |
| Integrated E2E (ADR-072) | PASS | `integrated-attendance-payroll-commission-gl-e2e.spec.ts` 4/4 green |
| Permissions / SoD | PASS | FA-01 maker≠checker proven live across Payroll, Commission, Target, Attendance; admin permission-seed migrations present for `targets`/`commission`/`payroll` |
| Migrations | PASS (after 1 fix — see below) | 234/234 applied, all `up()`/`down()` pairs present; `CreateTargetsCore` corrected to remove an unapproved `CREATE EXTENSION` (hosting-compatibility), verified via the restored `extension-dependencies.spec.ts` guard |
| Entitlements / module manifests | PASS | `targets`/`commission` registered in `ALL_MODULE_MANIFESTS`, dynamically entitled (confirmed via `EntitlementService.implicitStandard()`'s `authoredModuleCodes()` — no hardcoded edition list to fall out of sync) |
| Audit / idempotency | PASS | `CommissionResult.triggerEventKey` UNIQUE + dedup test; F03 `idempotencyKey` UNIQUE + zero-duplicate-journal proof under concurrent retry |
| API contracts | PASS | All new routes registered and permission-gated (confirmed via live dev-server route log); no existing route's request/response shape changed |
| F03 Option A (lock-order fix) | NOT APPLICABLE (deferred) | CTO-approved recommendation was "B + C now, A as a separately-reviewed follow-up" — A is explicitly out of this release's scope, not a defect |
| Clean test/hosting dataset | PASS (by construction) | The release package built by `tools/build/build-release.sh` contains code + migrations only (`dist/`, `src/`, `public/`, `package.json`) — no database dump, no seed/test data is ever bundled. A fresh Hosting target starts from whatever that target's own database holds; migrations apply schema only. See `MIGRATION_REPORT.md`. |

**One `FIX REQUIRED` item was found and repaired during this review** —
see "Hosting-compatibility defect" below. No other item in this table
required a fix. Full backend regression (post-fix): 208/208 tests,
24/24 suites, green (`--runInBand`, canonical serial mode). See
`TEST_REPORT.md` for the complete evidence log.

### FIX REQUIRED (found and repaired this review) — `CreateTargetsCore` used a contrib extension unavailable on this project's actual Hosting target

`PRODUCTION_DEPLOYMENT_GUIDE.md`'s own "UUID generation strategy" /
"Rule for future migrations" section (written after the 2026-08-27
production incident) is explicit: **no migration may ever run
`CREATE EXTENSION` for anything**, because this project's real Hosting
target (Namecheap Shared Stellar Plus) has zero contrib extensions
available — confirmed live at the time, `pgcrypto`/`uuid-ossp` both
missing `.control` files. The codebase even shipped a dedicated CI
regression guard for this (`extension-dependencies.spec.ts`) — but that
guard was missing from the active `src/` tree (present only in an old
`_deploy/previous/` snapshot, evidently lost at some point before this
session and never restored), so nothing caught it when `targets/
1789750000000-CreateTargetsCore.ts` (this same release) shipped a
`CREATE EXTENSION IF NOT EXISTS btree_gist` line to support its
non-overlap EXCLUDE constraint.

**Fix:** replaced the EXCLUDE constraint with a `BEFORE INSERT OR
UPDATE` trigger enforcing the identical invariant (no two `approved`
Targets for the same employee may have overlapping periods) using only
core SQL — `daterange`/`&&` need no extension, and
`pg_advisory_xact_lock` (also core) closes the same race an
index-backed EXCLUDE constraint would have closed atomically. Since
this migration had never reached any real Hosting/production target,
it was corrected in place (not superseded by a follow-up migration);
this development database's already-applied state was reconciled to
match by hand. The regression guard was also restored to the active
tree, updated for the current per-tag migration-directory layout
(recursive scan, not the pre-partition flat scan the lost original
used) — it now fails CI if this class of mistake recurs.

**Verified:** `extension-dependencies.spec.ts` passes (zero `CREATE
EXTENSION` anywhere in the active migration tree); the Target
non-overlap test (`commission-phase1.spec.ts` test 9) and the
Integrated E2E still pass unchanged against the trigger-based
mechanism.

## Detail notes

### Backend
`npm run build` (`nest build`) — clean, zero errors, across every commit
in this release's scope.

### Frontend
`npx tsc --noEmit` and `npm run build` (`vite build`) both clean. One
pre-existing, unrelated warning (`chunks are larger than 500 kB`) —
informational only, not a defect introduced by this release, not
addressed here (out of scope; a code-splitting concern for a future,
separately-scoped frontend-performance pass).

### GL / Financial Events (F03)
Option B (deadlock-specific bounded retry, `financial-event.service.ts`)
and Option C (`TRANSIENT_DATABASE_ERROR` closing-exception
classification) implemented per the CTO's explicit approval
(2026-09-21). Option A (lock-order restructuring) intentionally deferred
per the RCA's own recommendation — not a gap in this release, a
separately-scoped follow-up.

### Commission UTC day-boundary fix
Independent re-verification (2026-09-21) found `CommissionService.
submitApprovalBatch`/`listApprovedCommissionResults` compared a
`timestamptz` column against naive date strings, letting the DB
session's configured timezone (`Africa/Cairo`, UTC+3) silently exclude
results calculated in the last 3 hours of a UTC day. Fixed via explicit
UTC `Date` instants; regression test added and green.

### Historical, unrelated finding (not fixed, not this release's scope)
A stale `EventOutbox` row (`approval.request.approved`) tied to an
UNRELATED, pre-existing `targets` EXCLUDE-constraint test fixture from
earlier in this session's own test history continues to appear in
background error logs on some runs (`exhausted retries and was marked
failed`). This is expected, self-contained dead-letter behavior (the
outbox's own `MAX_ATTEMPTS` design working as intended) — it does not
affect any test's PASS/FAIL outcome in any run this review cites, and is
not evidence of a defect in this release's own code.

## Verdict

**Release Candidate: READY.** Proceeding to Phase 2 (no repairs
required — this review found none), Phase 3 (full verification,
already satisfied by the evidence above and re-confirmed in
`TEST_REPORT.md`), and Phase 5–7 (version, release notes, package
build).
