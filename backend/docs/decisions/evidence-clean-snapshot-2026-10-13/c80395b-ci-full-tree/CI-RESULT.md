# Full CI gate on a clean full-tree `git archive` of c80395bb5281a78185f5ba1a6ca65a6d28984d6f — 2026-10-13

`bash tools/ci/ci.sh` from `backend/` of the snapshot (no `.git`, no `node_modules` before the run; `npm ci` installed fresh), `DAII_SOURCE_COMMIT=c80395bb…` set so db-guard's evidence-header test can pin the commit. Database-free (no cluster contacted). `summary.md` still prints `commit: unknown` (script limitation on an archive); the commit is this folder's `SOURCE_COMMIT.txt` and the variable above.

| step | result | detail |
|---|---|---|
| install (`npm ci`) | PASS | 53 s |
| build (`nest build`) | PASS | 57 s |
| lint | PASS | **0 errors, 5 warnings** (the same five "Unused eslint-disable directive" warnings as on `68c2215`/`89508b1`; analysis in `../../DAII-HANDOVER-CLOSURE-REPORT-2026-10-13.md` §3; no suppression removed) |
| structure | PASS | |
| doc-links | PASS | 82 files, 112 references, 0 unresolved, 15 known-external |
| unit (unit mode) | PASS | 60 suites / 436 tests (59/430 before; +1 suite / +6 tests = the teardown-retry spec) |
| db-guard | PASS | 50/50 node tests |
**Overall: PASS** — one run, one commit, every step the project script enforces. Logs: `*.log` (git-ignored; on disk beside this file), `summary.md`, `doc-links.json`.

Scope: this result is for the commit above only. The database-backed gates (isolation regression 91 specs, T-03, T-04, T-00) ran on `4dc3862`; the code and test files of `4dc3862` and `c80395b` are identical (the commits between and after change documentation and evidence only). The classification "CI green" is the CTO's; the official status in the program documents is not changed by this file.
