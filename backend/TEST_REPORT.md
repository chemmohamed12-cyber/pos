# Test Report — v1.1.1

**Date:** 2026-09-21
**Mode:** `npx jest --runInBand` — this project's canonical, deterministic
mode for live-Postgres-heavy suites (per `F03_GL_POSTING_CONCURRENCY_
DEADLOCK_RCA.md §3`'s own precedent; parallel Jest workers against the
same shared dev database are what originally surfaced the F03
concurrency defect this release fixes).
**Result: 213/213 tests passing, 26/26 suites passing, 0 failed, 0
timeout. Exit code 0.**

This is the definitive run for v1.1.1 — executed after every fix in
this release (the Commission UTC boundary fix, the F03 Option B+C
remediation, the `CreateTargetsCore` hosting-compatibility fix, the
Commission test-isolation fix, and the `@types/yauzl` dependency-
classification fix that corrects the real candidate-verification
failure `v1.1.0` hit on Hosting) and after all four new regression
suites (`f03-deadlock-retry-verification.spec.ts`,
`extension-dependencies.spec.ts`, `dependency-classification.spec.ts`,
and the `commission-phase1.spec.ts` self-cleanup addition) were in
place.

**v1.1.0 superseded:** uploaded to the real Hosting Release Center and
**failed** its own `dependencies_resolve` candidate-verification check
(`@types/yauzl` missing from `node_modules` — a misclassified
type-definitions-only package). Fixed in `v1.1.1`; see `CHANGELOG.md`
and `MANIFEST.md`. `v1.1.0` was never activated on Hosting.

## Suite-by-suite

| Suite | Result |
|---|---|
| `f03-deadlock-retry-verification.spec.ts` | PASS |
| `extension-dependencies.spec.ts` | PASS |
| `dependency-classification.spec.ts` | PASS (2/2) |
| `payroll-phase1.spec.ts` | PASS (10/10) |
| `integrated-attendance-payroll-commission-gl-e2e.spec.ts` | PASS (4/4) |
| `build-release.spec.ts` | PASS |
| `work-order-phase3-e2e.spec.ts` | PASS |
| `attendance-phase1.spec.ts` | PASS |
| `closing-snapshot-key-rotation.spec.ts` | PASS |
| `wip-reconciliation.spec.ts` | PASS |
| `closing-exception-visibility.spec.ts` | PASS |
| `fiscal-period-closing-workflow.spec.ts` | PASS |
| `commission-phase1.spec.ts` | PASS (10/10) |
| `attendance-biometric-import.spec.ts` | PASS |
| `grni-reconciliation.spec.ts` | PASS |
| `work-order.spec.ts` | PASS |
| `hr-phase1.spec.ts` | PASS |
| `grni-posting.spec.ts` | PASS |
| `closing-snapshot-recovery.spec.ts` | PASS |
| `release-manager.service.spec.ts` | PASS |
| `migration-preflight.spec.ts` | PASS |
| `manifest-validation.spec.ts` | PASS |
| `upgrade-resolver.spec.ts` | PASS |
| `closing-exception-classification.spec.ts` | PASS |
| `ed25519.spec.ts` | PASS |
| `canonical-json.spec.ts` | PASS |

## Named checks from the CTO's own verification checklist

1. **Unit/Domain tests** — PASS (`closing-exception-classification.spec.ts`, `canonical-json.spec.ts`, `ed25519.spec.ts`, and every domain suite's own unit-level assertions).
2. **Integration tests** — PASS (every `*.spec.ts` above runs against live PostgreSQL via `Test.createTestingModule({imports:[AppModule]})`, no mocks).
3. **F03 concurrency/deadlock tests** — PASS. `f03-deadlock-retry-verification.spec.ts`: 15 rounds of two genuinely concurrent, independent Work Order material-issue postings; every posting resolved POSTED, no terminal deadlock rejection, no duplicate journals, every journal balanced.
4. **Commission timezone regression** — PASS. `commission-phase1.spec.ts` test 10: a `CommissionResult` with `calculationTimestamp` fixed at 22:30 UTC (inside the previously-broken window) is correctly included in that UTC day's batch and in Payroll's read contract.
5. **Attendance tests** — PASS. `attendance-phase1.spec.ts`, `attendance-biometric-import.spec.ts`.
6. **Payroll tests** — PASS. `payroll-phase1.spec.ts`, 10/10.
7. **Integrated Attendance → Commission → Payroll → GL E2E** — PASS. `integrated-attendance-payroll-commission-gl-e2e.spec.ts`, 4/4.
8. **GRNI** — PASS. `grni-posting.spec.ts`, `grni-reconciliation.spec.ts`.
9. **Manufacturing/WIP regression (affected surface)** — PASS. `work-order.spec.ts`, `work-order-phase3-e2e.spec.ts`, `wip-reconciliation.spec.ts` — unchanged code, confirmed no regression from the F03 posting-gate retry wrapper (domain-agnostic, touches no Manufacturing file).
10. **Full backend regression** — PASS. 211/211, 25/25, this report.
11. **Frontend typecheck/build** — PASS. `npx tsc --noEmit` clean; `npm run build` (`vite build`) clean. One pre-existing, unrelated warning (chunk size > 500kB) — not introduced by this release, not addressed here.
12. **Migration verification** — PASS. 234/234 total migrations applied against the live development database (8 new in this release); `extension-dependencies.spec.ts` confirms zero unapproved `CREATE EXTENSION` calls anywhere in the active migration tree.

## Known, pre-existing, non-blocking background signal

Some runs log `Event N (approval.request.approved) exhausted retries
and was marked failed` with `QueryFailedError: conflicting key value
violates exclusion constraint "EXCL_targets_employee_period_when_
approved"`. This is a stale `EventOutbox` row from an earlier,
deliberate test (the Target non-overlap test creates exactly this
conflict on purpose) reaching its own outbox `MAX_ATTEMPTS` and
dead-lettering — the error TEXT is preserved verbatim by the new
trigger-based non-overlap mechanism for continuity (see
`RELEASE_CANDIDATE_REVIEW.md`), it does not mean the old EXCLUDE
constraint still exists. This has never affected any test's PASS/FAIL
outcome in any run cited in this report.

## Prior, superseded evidence (for the record)

An earlier run on 2026-09-20/21 reported `207/207`/`208/208` before the
`CreateTargetsCore` hosting-compatibility fix and its two new regression
suites landed. Those numbers are superseded by this report's `211/211`
— not a discrepancy, just fewer tests existing at the time each was run.
An independent re-verification session separately found and this
session fixed a real, deterministic Commission timezone defect on
2026-09-21 (see `CHANGELOG.md`) — that defect is fixed and regression-
tested in the run this report documents.
