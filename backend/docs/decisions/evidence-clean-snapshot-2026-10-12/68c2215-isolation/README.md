# Full isolation regression — clean snapshot of 68c2215c910bc9525cf993ed1439588d8649f183 — 2026-10-12

Code identical to the Option B tree (`4d4ed0d` / `1ae0ae7`); the only difference to `ece3ae8` is the regression list file. Rebuilt cluster 5546 (system id 7695619915229547252), namespace `biz_t90_`.
Runner: `node tools/testing/biz-run.js --regression tools/testing/regression-specs-all.txt` (one jest process per spec). The runner records logs, not run headers; provenance is `SOURCE_COMMIT.txt` plus the snapshot being a `git archive` (no dirty paths possible). Log hashes: `LOG-SHA256.txt`. This run supersedes the earlier interrupted run (64/92).

| Measure | Value |
|---|---|
| Spec files in the list | 91 |
| First complete run | 83 executed-PASS · 1 SKIPPED (the runner prints it as PASS) · 6 FAIL · 1 BLOCKED = 91 |
| Jest tests, first run | 598 passed, 1 skipped, 21 failed (all 21 inside the one BLOCKED spec, which refuses to run) |
| The 6 FAIL | fixed-asset, price-lists, commission, fulfillment, supplier-invoice, sales-returns `*.company-isolation`: **all their tests passed (4/7/5/5/9/8)**; the suite failed in global teardown with `QueryFailedError: permission denied to terminate process` at `DROP DATABASE … WITH (FORCE)` (`two-company-real-pg-harness.ts`, `dropDatabase`). Probable cause (not proven): FORCE must terminate every backend of the database and the non-superuser test role cannot terminate a background (autovacuum) worker attached to it — a harness/environment race, not a product failure |
| Re-run of exactly those 6 | after dropping 15 leftover disposable `daii_test_biz_t90_*` databases (exact pattern only): 6/6 PASS, 38 tests, 0 failed |
| Final classification | **89 executed-PASS · 1 SKIPPED (`t0-clean-company-baseline`, opt-in) · 1 BLOCKED (`release-migration-registry.real-pg.spec.ts`, refuses to run unless pinned to the isolated 5544 instance) · 0 FAIL** — the same classes as the earlier counts (520f2e0) |
| Not executed | the SKIPPED and BLOCKED specs did not run their tests |

The first-run teardown failures are recorded, not hidden. The FORCE-drop race and the databases it left behind are an open test-infrastructure item; it was not fixed here. Not an independent acceptance.
