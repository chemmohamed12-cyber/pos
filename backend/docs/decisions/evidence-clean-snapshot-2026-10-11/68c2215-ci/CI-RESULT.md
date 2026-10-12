# CI on a clean `git archive` of 68c2215 (code identical to ece3ae8; only the regression list file differs) — reviewer run, 2026-10-12
SOURCE_COMMIT 68c2215c910bc9525cf993ed1439588d8649f183. Database-free; no test cluster used.
| step | result |
|---|---|
| install (npm ci, offline) | PASS |
| build | PASS |
| lint | PASS — **0 errors, 5 warnings** (redundant eslint-disable directives in `src/foundation/testing`: biz-harness-smoke, biz-support, t09, t10 and one more; the LA-1 errors are fixed by 0406f11) |
| structure | PASS |
| doc-links | first run FAIL = **snapshot artefact**: the snapshot contained only `backend/`, so links to `../docs`, `../frontend` could not resolve (log kept: `ci-run-backend-only-snapshot.log`). Re-run on a full-tree `git archive` of the same commit: `82 files, 112 references, 0 unresolved` → PASS |
| unit | PASS (59 suites / 430 tests, per the unit step) |
| db-guard | PASS |
The CI script's own summary shows "FAIL" only because of the backend-only doc-links artefact and prints `commit: unknown` (no `.git` in a snapshot). The official CI status is NOT changed by this note.
