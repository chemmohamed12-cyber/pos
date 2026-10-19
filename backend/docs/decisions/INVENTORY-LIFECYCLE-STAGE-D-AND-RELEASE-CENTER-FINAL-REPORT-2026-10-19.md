# Stage D, C1 regression spec and Release Center - consolidated report (2026-10-19)

Main checkout: master 5e41647, uncommitted work preserved (status 58 -> 134 entries; the C1 patch and the F11 / item-details / warehouse-column work are intact). No reset / clean / overwrite.

## Stage D
- Commits applied (code and tests only, docs/evidence excluded): 18159cd (C2), ee41a58 (C3), b0b4f22 (C4), 925c9ca (C6), 8ef37ae (Stage A), 62610b3 (Stage B). `git apply --check` failed on 2 files (CRLF in main; one import line; the regression list), so by CTO approval a CRLF-aware three-way merge was used: 26 files merged, 21 new, 2 resolved (inventory.controller.ts import line = main's list + Matches, no ValidateIf; regression list = main's list + appended stage specs). Deviation: accounting-policy-config spec update (from a2c9416) included because C4 added the 13th policy key.
- Build: main/backend OK. Migrations: dry-run from main's dist = exactly the 5 expected pending on all 5 DBs; applied to platform + Alpha/Beta/Delta/Gamma (5 each); re-check 0 pending; objects verified (opening-batch table, reference columns, revaluation in kind CHECK, 17 terminology rows) in all five. Rollback rehearsal (up/down/up) on an Alpha copy only; C6 down is unsafe once revaluation rows exist (0 today). No backups, per revised CTO decision.
- :3500 restarted (twice: after migrations, after the Release Center change); :5173 serving. Flags unchanged; no data seeded.

## Test evidence (main checkout, cluster 5546)
- Cumulative regression: 111 specs - 110 PASS, 1 FAIL = release-migration-registry.real-pg.spec.ts (baseline BLOCKED: needs the isolated instance on port 5544). 0 ENOSPC. Log: main-cumulative-regression.log.txt.
- C1 controlled-scenario spec: it was in the list but missing from main (closure commit 4ce6269, not one of the six). It was restored into main (by the peer session at 21:58) and RAN: PASS.
- Business suite T-00..T-31: 27 steps, ALL PASSED, including T-18 schema drift. Log: main-business-suite.log.txt.
- Live smoke on :3500 (14 checks, read-only) 14/14 OK after the final restart; reconciliation preview answers 409 because the demo Alpha chart has no inventory control account (data precondition, not seeded).
- Stage B gate earlier: 44/44, lint 0 errors, tsc 0, unit 436/436.

## Release Center (commit 476f9ab in the worktree; ported to main, same 11 files)
- Root cause: PG_DUMP_BIN / PG_RESTORE_BIN default to bare commands and the local .env set none; the absolute-path rule is intentional and was NOT weakened.
- Done: local backend/.env now sets absolute C:\Program Files\PostgreSQL\18\bin\pg_dump.exe / pg_restore.exe (untracked file); precise diagnostics (names the variable; missing / not a file / not executable; nothing executed); RELEASE_UPLOAD_MAX_MB (default 200) with 413 / 507 messages; .env.example documented.
- Evidence: real GET /release/preflight on :3500 = bin.pg_dump pass, bin.pg_restore pass, overall ok true (bin.npm warns: bare `npm`, non-critical, pre-existing). 12 unit + 3 HTTP tests pass; 163/163 release+config unit specs; lint clean. Tested: valid package, corrupted ZIP, checksum mismatch, undeclared file, missing manifest, bad type, traversal / absolute / .env / node_modules / .sh, size cap over HTTP incl. chunked, missing / bare / directory binaries. Duplicate versions and upgrade paths: existing release-manager and upgrade-resolver suites pass.
- Not touched: hosted/proxy config, temp-storage location (C: temp has little free space - operational risk), protected artifacts, anything published or deployed.

## Remaining risks / not done
- release-migration-registry spec needs port 5544 (not run). pg_restore/pg_dump were never invoked. No decompression-size cap exists in the package validator (hardening proposal). C: drive nearly full (0.1-2 GB free during runs). Write-path behaviours that need flags (enforce / approval-required refusals) are proven by the isolated specs only, not live, because flags stay at defaults. Strict SoD stays off (Gamma and Delta have one admin). Release Center changes are committed on the worktree branch; the main checkout holds them uncommitted.

## Final status by stage
C1 accepted (applied earlier) - C2 applied, verified - C3 applied, verified - C4 applied, verified - C6 applied, verified - Stage A applied, verified - Stage B applied, verified - C5 plan only (no flags) - Release Center implemented and verified locally.
