# T-29 — PA-43 pilot (read-only need-check protocol + simulated UUID-repair effect) — clean snapshot of 5ecb6c3ecae9983f748e3c34b1e78147b2a35959 — 2026-10-12

Disposable experimental Company database `daii_test_biz_t29_*` on the rebuilt cluster 5546. **A protocol pilot, not a need check of any real database** (that stays STOPPED: no approved read-only role and database list). The UUID repair was never called; no historical row was written.

| Check | Result |
|---|---|
| P1 — Q0–Q6 in a `BEGIN TRANSACTION READ ONLY` session, counts only; a write attempt inside it is refused (25006) | PASS — seeded legacy-like DB: Q1 = 1 non-compliant user id, Q2 = 0, Q3 = 4 audit rows already carrying it in a hashed column, Q4 = 7 rows (seq 1–7), Q5 = 0 repair runs |
| S1 — simulated effect, computed in memory | PASS — 4 of 7 audit rows would have a changed hash input (`actorUserId`); the chain verifies today and would first break at seq 1 because the repair does not recompute `hash`/`prevHash`; the 3 untouched rows would still verify individually |
| N1 — nothing written (fingerprints of `audit_records` and `users` identical before/after; chain still valid) | PASS |

Two attempts, both with all three checks PASS: attempt 1 (`T-29-20261012T050453Z-571d58`) was marked failed by jest because the harness cleanup hit `permission denied to terminate process` at `DROP DATABASE … WITH (FORCE)` (the same harness race as in the isolation run); attempt 2 (`T-29-20261012T050546Z-f5e885`) completed cleanly after dropping the leftover `daii_test_biz_t29_*` databases. An earlier run at `bcfce72` (folder `../bcfce72-audit-regression/T-29`) showed S1 FAIL-DEFECT caused by an over-strict expectation in the spec (written by this session); the spec was corrected and is the version run here.

What this does and does not show: it confirms, on a controlled fixture, the code-path conclusion of the review report (repair would invalidate the hashes of rows referencing a repaired user/org-unit id) and that the Q0–Q6 queries work read-only. It does not show that any real database has such rows, that the repair ever ran, or what the final DEC-25 handling should be. Not an independent acceptance.
