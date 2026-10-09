# Release 1.1.7 — addendum to the 1.1.6 readiness report (2026-10-10)

**Package:** `D:\DAII-LOCAL-DEPLOY\release-out\Daii-Release-v1.1.7-2026-10-09.zip` — SHA-256 `4e465c26caf3e15f4af34518d24ffb30b56d3347fa88b5a8d2a95d44024ddda8` (4 970 495 bytes). Built from commit `8cd2027` (`VERIFY: PASSED`, 3 888 manifest files, 0 problems, secret scan clean). Not deployed.
1.1.7 = 1.1.6 + (a) `78093b0` recovery of a deploy cut off before the swap, (b) `8cd2027` silent session renewal in the frontend. Nothing else changed (the host-cleanup and staging-lifecycle work is task 1.1.8).

## Why 1.1.7 exists (host evidence, 2026-10-09 EDT)
1.1.6 deploy: started 16:40:26, application process ended ~16:44:40 while the candidate slot `backend.next-a1b8bbd4-…` was being prepared. No migration ran (`release_migration_runs` empty), the active slot (1.1.5) was never replaced, the release row stayed `deploying` and blocks re-upload of 1.1.6. Earlier deploys took 4:05 (1.1.4) and 5:01 (1.1.5) for the same stage — the candidate copy of a 69 049-file / 476 MB tree (260 MB of old `storage/release-staging`, 120 MB of `node_modules.incident-backup-2026-09-15`) inside one HTTP request. The kill itself is unconfirmed (no line in stderr.log; likely a hosting process/resource limit).

## Fixes
1. **Interrupted-deploy recovery** (`reconcileInterruptedDeploys`): a release at `deploying` whose version differs from the running process, with NO migration run, not the LKG and Company fan-out off is recorded `failed` (audit `release.deploy.interrupted`, no actor), so it can be uploaded again. Anything less certain stays for manual review; nothing on disk is deleted. 14/14 spec cases incl. 5 refusals. Effect on the host: when 1.1.7 first boots, the stuck 1.1.6 row is closed automatically — no SQL, no rollback.
2. **Silent session renewal**: the client never used `/auth/refresh`, so the 15-minute access token signed the user out mid-work (and mid-deploy). Now renewed 30 s before expiry and once after a 401, single in-flight refresh, rotated refresh token always stored, logout revokes it; a refused refresh signs out, an unreachable endpoint does not; "not a member" 401s are never retried. Evidence: 8/8 logic cases on the compiled client + end-to-end against the real backend with a 15 s token (request after expiry succeeds without sign-out, Company claim preserved, rotated-out refresh token refused 401). Browser screens not exercised.

## Full regression (HEAD `8cd2027`, isolated PostgreSQL 5544, nothing else running)
**185 suites passed, 1 failed, 1 skipped (187) · 1301 tests passed, 1 failed, 1 skipped (1303).**
- Skipped by design: `t0-clean-company-baseline`.
- Failed: `procurement/application/grni-posting.spec.ts` ("GRNI and AP reconciliation matched…" → `drift_found`). **Pre-existing, time-window defect, not caused by 1.1.7:** it ran at 00:16–00:35 Cairo, inside the known 00:00–03:00 Cairo day-boundary window (documented in the Authorization closure report §10.5; the UTC business-date fix is not in this tree). It passed in every earlier full run today (21:00–23:30 Cairo) on the same code, and it fails identically on commit `33aae63` (F6, before all of today's work) when run now. Re-running it after 03:00 Cairo is the confirming check (not yet done). Not fixed here: the fix is a separate, uncommitted change.

## Risks / open items (unchanged unless stated)
- Audit chain break at production `seq 1`, the 503 root cause, exposed secrets, pool mode on real cPanel: OPEN, need host evidence (see the 1.1.6 report).
- Deploying 1.1.7 still runs as one request of ~4–5 minutes through the same engine; it can be cut off again. Lighten the tree first (host cleanup list, approved approach), deploy at a quiet time, do not retry blindly. A cut-off leaves 1.1.5 serving and no data change.
- SQL statements per request: still not measured.
- Task 1.1.8: staging lifecycle/retention (delete staging after terminal states, clean `upload-*`, retention, `RELEASE_STAGING_PATH` off-tree, exclude staging from the candidate copy, never delete when status cannot be verified); consider async deploy and `MEDIA_STORAGE_PATH` off-tree.
