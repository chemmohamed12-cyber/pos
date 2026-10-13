# T-30 (WP-INV-09 sibling probes) — clean snapshot of d68fd10e31c84c105428011f7ebcbb1b15b2e9fb — 2026-10-14

Clean `git archive` of the commit, one fresh `npm ci` (through the CI script), then T-30 through `biz-run.js --only T-30` on the dedicated cluster 127.0.0.1:5546 (disposable databases `daii_test_biz_t30_*`, all dropped; post-cleanup proof in `t30-run/post-cleanup.json`).
| Gate | Result | Evidence |
|---|---|---|
| CI script (install, build, lint, structure, doc-links, unit, db-guard) on this commit | **Overall PASS** (install 56 s, build 72 s, lint 62 s, structure, doc-links, unit 200 s, db-guard 15 s) — `summary.md` prints `commit: unknown` (script limitation on an archive; the commit is pinned by `SOURCE_COMMIT.txt` and `DAII_SOURCE_COMMIT`) | `ci/` |
| T-30 | jest exit 0; **14 cases: 8 PASS · 6 FAIL-DEFECT · 0 BLOCKED** — the 6 are candidate defects of the plain-manager idiom (S1-A, S1-C-A, S1-D-A, S2-A) and of `releaseReservation` (S3-A, S3-B); see `DAII-N02-SIBLING-PROBES-RESULTS-2026-10-14.md` | `t30-run/` (header: commit = this commit, `dirtyPaths: []`, `clean-git-archive-snapshot`; manifest verified, 5 files OK) |
Not run on this commit: the isolation regression, ambient suites and the other business steps — nothing they exercise changed (the commit adds one test-only spec and one line in the runner's step list); their evidence remains the `8ec6de4` runs. Two earlier working-tree runs of the same spec (harness error; then a probe flaw: database-wide negative-stock count) were deleted and are not evidence.
