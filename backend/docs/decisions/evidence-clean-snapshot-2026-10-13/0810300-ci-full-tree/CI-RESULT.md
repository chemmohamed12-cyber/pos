# Full CI gate on a clean full-tree `git archive` of 0810300f56df0396c44b43daf6b6127bb16a1c70 — 2026-10-13

Same procedure as `../715c22d-ci-full-tree/` (no `.git`, no `node_modules` before, `npm ci` fresh, `DAII_SOURCE_COMMIT` pinned for db-guard's header test; `summary.md` prints `commit: unknown`, a script limitation on an archive). Database-free. This is the HEAD that contains the sequence's only code change: the test-only spec `payroll-gl-runtime-characterization.spec.ts` (compiled by the build and linted; not in the unit list).

| step | result | detail |
|---|---|---|
| install | PASS | 37 s |
| build | PASS | 52 s |
| lint | PASS | 0 errors, 5 warnings (the same five unused-directive warnings; the new spec adds none) |
| structure | PASS | |
| doc-links | PASS | 82 files, 112 references, 0 unresolved, 15 known-external |
| unit (unit mode) | PASS | 60 suites / 436 tests |
| db-guard | PASS | 50/50 |
**Overall: PASS** (exit 0). Source identity: `SNAPSHOT-IDENTITY.json` (tree `8151aa94…`, 4680 files, `dirtyPaths: []`, 0 tracked files differ after the run). Logs are git-ignored (on disk beside this file). This result is for this commit only; the database-backed gates were run on `4dc3862` and are unchanged. "CI green" classification is the CTO's.
