# Full CI gate on a clean full-tree `git archive` of 715c22d02cb88f9187cb9f753d55c6e086d5025e — 2026-10-13

Same procedure as `../c80395b-ci-full-tree/`: `bash tools/ci/ci.sh` from `backend/` of the snapshot (no `.git`, no `node_modules` before; `npm ci` fresh), `DAII_SOURCE_COMMIT` set for db-guard's header test; `summary.md` prints `commit: unknown` (script limitation on an archive). Database-free.

| step | result | detail |
|---|---|---|
| install | PASS | 39 s |
| build | PASS | 55 s |
| lint | PASS | 0 errors, 5 warnings (the same five unused-directive warnings; analysed in `../../DAII-FINAL-PROGRAM-CLOSURE-REPORT-2026-10-13.md` §7.1) |
| structure | PASS | |
| doc-links | PASS | 82 files, 112 references, 0 unresolved, 15 known-external |
| unit | PASS | 60 suites / 436 tests |
| db-guard | PASS | 50/50 |
**Overall: PASS.** Logs: `*.log` (git-ignored; on disk beside this file). `git diff 4dc3862 715c22d` outside `backend/docs` is empty. Classification as "CI green" is the CTO's.
