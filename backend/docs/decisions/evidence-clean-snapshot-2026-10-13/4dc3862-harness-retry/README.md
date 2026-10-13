# Harness teardown retry (4dc3862) — verification on a clean snapshot — 2026-10-13

Clean `git archive` snapshot of `4dc3862a42c33ab0bf5ff910ec5272193fd6aded` (`DAII_SOURCE_COMMIT` pinned, built in the snapshot, 0 TS errors), rebuilt cluster 5546 (system identifier `7695619915229547252`), test role non-superuser, no databases other than `postgres` before and after.

| Run | Result | Evidence |
|---|---|---|
| T-00 harness smoke (affected test) | PASS 1/1, manifest 7 files OK | `T-00/T-00-20261013T121948Z-7f7769` |
| T-03 alone (`DAII_T0304_PART=T-03`) | PASS 17 checks, manifest 12 files OK, three databases removed, each drop `attempts: 1` | `T-03/T-03-20261013T122032Z-c87467` |
| T-04 alone (`DAII_T0304_PART=T-04`) on the FINAL audit writer (Option B) | PASS 17 checks, manifest 11 files OK, three databases removed, each drop `attempts: 1` | `T-04/T-04-20261013T130800Z-db0ba1` |
| Full isolation regression, 91 spec files, one jest process each, namespace `biz_t90_` | **89 executed-PASS · 1 SKIPPED (`t0-clean-company-baseline`, opt-in) · 1 BLOCKED (`release-migration-registry`, refuses to run without the 5544 pin; its 21 tests are the 21 "failed") · 0 FAIL**; jest tests 598 passed / 1 skipped / 21 failed (all in the blocked spec); **no suite failed in teardown, no re-run was needed** | `isolation-regression-full-run.log` (sha256 in `LOG-SHA256.txt`; `*.log` is git-ignored, the file is on disk next to this README) |

Teardown retry in the wild: the helper recovered **2 real occurrences** of the race in this run (`teardown-retry-observed.txt`): `fixed-asset.company-isolation` and `company-lifecycle-admission.real-pg`, each `permission denied to terminate process` on the first attempt and dropped on the 3rd attempt after 750 ms. On 2026-10-12 the same class of failure failed 6 suites. This shows the retry is effective; it does not prove the cause.

T-04 note: the earlier standalone PASS (`../../evidence-clean-snapshot-2026-10-12/0dd0074-t04-standalone/`) ran on `0dd0074`, which still contains the withdrawn Option A audit writer (`setval`); the Option B writer arrived in `4d4ed0d`. This run is on the final writer and is additional, not a replacement. Not an independent acceptance.
