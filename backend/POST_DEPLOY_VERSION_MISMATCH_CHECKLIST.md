# Post-Deploy Verification — v1.1.1 API 404s / Backend Version Mismatch

**Purpose:** confirm whether the Hosting backend process is actually running
v1.1.1, or still the pre-baseline emergency-recovered build, before any
further release action is taken. Read-only checks only — nothing here
modifies Production. Performed by an authorized Hosting operator with
server access; this session has none and cannot execute any step below.

## Why this check

Source-level investigation (this session, read-only) confirmed all 9
reported failing routes exist correctly in v1.1.1 source, are registered
in `AppModule`, and use the correct `/api` global prefix — see the RCA
already sent. The leading hypothesis is that the v1.1.1 **frontend**
bundle was deployed successfully, but the **backend** process was never
actually swapped to v1.1.1's own `dist/` — it is still running the older,
pre-baseline snapshot used during the earlier emergency recovery (that
snapshot's own `package.json` read `1.0.3`, a version that does not exist
anywhere in this repository's git history — the earliest tracked version
is `1.0.10`). Commission, Manufacturing, and the current Attendance import
format were all added to source on 2026-09-19/20, after that recovery
snapshot would have been taken — fully consistent with 404s on exactly
those domains' routes, while older domains (e.g. `procurement/suppliers`)
still resolve.

## Checks (run in order, stop and report after step 3 if it already confirms the mismatch)

1. **What version does the backend process itself report?**
   ```bash
   curl -s https://<host>/api/releases/version
   ```
   Compare to `1.1.1`. Any other value (or a 404/error on this endpoint
   itself) is a strong signal the running process predates the current
   Release Engine's own version-reporting code.

2. **What does the deployed backend's own `package.json` say?**
   ```bash
   cat <ApplicationRoot>/backend/package.json | grep '"version"'
   ```
   Compare to `1.1.1`.

3. **Does the deployed `dist/` actually contain the newer domains?**
   ```bash
   ls <ApplicationRoot>/backend/dist/domains/commission 2>&1
   ls <ApplicationRoot>/backend/dist/domains/manufacturing 2>&1
   ```
   If either reports "No such file or directory", the running `dist/` is
   confirmed pre-dating these domains — the mismatch is proven, no further
   check needed to confirm root cause.

4. **When was `dist/main.js` last modified, and by which deployment?**
   ```bash
   stat <ApplicationRoot>/backend/dist/main.js
   ```
   Compare the timestamp against the actual v1.1.1 deployment time and
   against the known emergency-recovery timestamp, to confirm which event
   actually produced the currently-running file.

## Do NOT (same governance as every prior release/incident action this session)

- Do not manually copy/patch backend files into `<ApplicationRoot>` as a
  fix for this — that repeats the same class of emergency-manual-patch
  problem already flagged as not-a-release-basis in the prior incident.
- Do not force-activate, bypass Candidate Verification, or skip Migration
  Preflight to "just get the backend swapped."
- Do not create v1.1.2 before this is confirmed — if the backend is
  simply not yet swapped to the already-built, already-verified v1.1.1
  package, the correct action is completing that swap through the
  Release Engine's own deploy path, not issuing new source.

## After these checks

Report back the outputs of steps 1–4. If they confirm the backend is not
on v1.1.1, the corrective path is re-running the Release Engine's deploy
for the already-uploaded v1.1.1 candidate/package (or re-uploading it if
it's no longer present, per the same Bootstrap-Verification-first
discipline already in force) — not a new release, not a manual patch.
