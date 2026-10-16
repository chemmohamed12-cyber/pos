# 1.1.10 compatibility audit against the legacy (1.1.9) deployment engine - 2026-10-16

No hosting or Production access was used by this audit. Evidence: `evidence-2026-10-16-compat/` (scripts, outputs, engine event logs).

## 1. Baselines
- **1.1.9 (protected)**: `D:\DAII-LOCAL-DEPLOY\release-out\Daii-Release-v1.1.9-2026-10-10.zip`, SHA-256 `cff205a63d5eb4fece4715b5e5fe75a5a8fef7a14be1924f09df9b52e385e9f7` (re-hashed at the end of the audit: unchanged), built from commit 3e0b139, 3900 manifest files, 288 migrations. The "legacy engine" is the Release Engine inside that build (`dist/foundation/release/*`, with Company fan-out capability, default `RELEASE_COMPANY_MIGRATIONS=off`), driven by `tools/release-sim/local-deploy-harness.js` (the real engine services; the HTTP layer is excluded).
- **1.1.10**: commit b99964a (+ documentation-only commits), package `Daii-Release-v1.1.10-2026-10-16.zip`, SHA-256 `89b8a9797a0a5ab71db44b0ee29241203b619a33e92a17f3d32838ee42103097`, 4012 manifest files, 299 migrations (+11). Content hash `d9cb0404a6d96c5d81e588a390f4a293f28f84cb86d9567eecb2f4a018024f01`; source checksum `40fb089f02b22f41f7c5eb32239493f43d3b9cfd84b02ee2365bc0b9bab594e6` (see RELEASE-1.1.10-PACKAGE-2026-10-16.md). The package was NOT rebuilt by this audit: no defect required a code change.

## 2. Actual differences (1.1.9 package -> 1.1.10 package)
- Same top level (`MANIFEST.json`, `dist`, `src`, `public`, `package.json`, `package-lock.json`), same manifest schema, `packageType` full, no `minimumCompatibleVersion` in either, `runtimeDependencies` identical (no new runtime dependency), `configuration.schema.ts` identical (no new required environment variable).
- 114 files added, 2 removed (the old hashed frontend bundle), 191 changed. Engine-relevant source changes: `release-execution.service.ts` and `release.controller.ts` only lose unused imports (lint); `SeedDefaultBaseCurrency1789701100000` only renames an unused parameter (migration identity is the timestamp, already applied). `tools/build`, `tools/deploy`, `tools/release-sim`, `main.ts` and `database.module.ts` are unchanged. `package.json` gains 8 npm scripts (test/ci); `package-lock.json` carries the approved lockfile-only security update T1 (commit 8ec6de4; package.json dependencies unchanged).
- Dependency evidence both ways: CI (`npm ci` on the new lock) passed; the simulation ran 1.1.10 on a `node_modules` tree installed for 1.1.4 (older than both locks), so 1.1.10 needs nothing newer than the host's existing tree.

## 3. Compatibility matrix
Isolated simulation: 1.1.9 installed as the ACTIVE slot in `D:\DAII-SIM-1110`; platform and Company databases built by the 1.1.9 code at 288 migrations on the approved test cluster 5546.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Engine upload: PackageValidator accepts 1.1.10, identifies version 1.1.10, status `validated`; separate release row from 1.1.9 | PASS | engine-deploy-*.json |
| 2 | Per-file integrity: a file changed after build is refused (`Checksum mismatch for dist/main.js`); re-upload of an already-deployed version is refused | PASS | negative tests, section 6 of this file |
| 3 | Verified-backup gate, preflight, candidate verification, artifact integrity, environment check, migration preflight | PASS | engine-deploy-C events |
| 4 | Platform DB migrations 288 -> 299: 11 pending found = the 11 shipped, each applied exactly once | PASS | post-check-B.txt |
| 5 | Company fan-out `dry-run`: plan lists the Company and its pending tags, no blockers, nothing touched | PASS | engine-deploy-B-fanout-dry-run.json |
| 6 | Company fan-out `on`: Company 288 -> 299, restore point, verified | PASS | engine-deploy-C-fanout-on.json |
| 7 | Atomic slot swap, restart trigger, LKG commit (ACTIVE 1.1.10, previous slot 1.1.9) | PASS | engine events |
| 8 | Duplicate-execution protection: runner re-run on the fresh DB and on the upgraded Company DB ran 0 migrations; the application never runs migrations at startup (`synchronize:false`, no `migrationsRun`) | PASS | fresh-install.txt |
| 9 | Fresh install with the package's own runner: 299 migrations; fresh and upgraded schemas agree for every 1.1.10 object | PASS | fresh-install.txt, schema-eq.txt |
| 10 | Backend start from the swapped ACTIVE slot, health check, no errors in the log | PASS | smoke-B.txt |
| 11 | Frontend served from the installed slot; served bundle bytes equal the manifest checksums; legacy `check-frontend-bundle.sh` OK (also against `frontend/dist`: no drift) | PASS | smoke-B.txt |
| 12 | Authentication, company selection, Company context; a platform-scope token is refused on Company routes (403) | PASS | smoke-B.txt, workflow-1110.txt |
| 13 | Essential workflows on the deployed build plus the new features (barcode add, duplicate 409, lookup by barcode and SKU, customer contacts/addresses/profile, supplier profile update, PO list by supplier) | PASS (12/12) | workflow-1110.txt |
| 14 | Restart/recovery: kill -9, restart, healthy, smoke passes | PASS | run log |
| 15 | Production-mode boot (`NODE_ENV=production`, the check the 1.1.4 simulation skipped): 1.1.10 and 1.1.9 abort with the identical four invalid-secret messages when given development placeholders, and both boot healthy with valid secrets | PASS (parity) | run log |
| 16 | Application rollback: protected 1.1.9 code on the migrated schema: healthy, login, all 1.1.9 features and writes work; only the 1.1.10-only routes are absent | PASS | smoke-rollback.txt |
| 17 | Protected 1.1.9 artifact unchanged | PASS | sha256 before and after |
| 18 | Host-specific `verify-deploy.sh` (cPanel/Passenger layout, .env, permissions) | NOT RUN | section 7 |

## 4. Incompatibilities found
**I-1 (deployment configuration, not a package defect): with the legacy engine's default `RELEASE_COMPANY_MIGRATIONS=off` only the platform database is migrated.** 1.1.10 adds columns to Company-owned tables (customers, products, suppliers) and four Company tables, so on an un-migrated Company DB `GET /customers`, `/products/all`, `/products/lookup`, `/procurement/suppliers` and the matching POSTs answer 500 (reproduced: `smoke-A-engine-deploy-fanout-off.txt`, 6 of 15 checks fail; warehouses, purchase orders and the trial balance still work). With `on` everything passes (`smoke-B.txt`).
Fix: a deployment prerequisite, not a code change (the Company step is already an engine capability; a redesign was not warranted). Deploy with `RELEASE_COMPANY_MIGRATIONS=dry-run` first (the plan must show no blockers), then `on`; or, if fan-out stays off, run the package's migration runner once for every Company database before users return. Re-running is a proven no-op.
No code defect needing a new regression test was found; the migrations are covered by the customer/supplier profile specs, the item master specs and the T-18 schema-drift test, and the engine by the company-fanout specs.

## 5. Migration and rollback results
- Upgrade 288 -> 299 on platform and Company, each of the 11 exactly once; objects present (15 columns, 4 tables); fresh install 299; re-runs 0.
- Rollback: roll back the application only (swap back to the 1.1.9 slot); the schema stays (additive, nullable) and 1.1.9 runs on it (check 16). The `migrations` table keeps the 11 extra rows, which 1.1.9 ignores. No database rollback was performed or recommended: the reversible `down()` chain deletes new data and needs a separately reviewed procedure.
- Known fixture note: in the simulation the platform DB was built core-first then all tags, so it lacks five `IDX_*_createdAt` indexes that exist at 1.1.9 as well (not a 1.1.10 effect), and the fixture Company DB lacks the 15 `users` foreign keys that the test bootstrap removes by design.

## 6. Negative tests
A package with `dist/main.js` changed after the manifest was written (version bumped to 1.1.11 to avoid the same-version refusal) is rejected by the engine as `validation_failed` with the checksum mismatch message. Re-uploading 1.1.10 after it was deployed is refused ("already deployed and live").

## 7. Hosting-specific items not verified by this audit
`verify-deploy.sh` and Passenger/cPanel behaviour (restart file, permissions, `.env` delivery, shared nodevenv symlink, process lifecycle); production secrets and `DATABASE_CREDENTIAL_ENCRYPTION_KEY` continuity; the host's `RELEASE_COMPANY_MIGRATIONS` value and the state of the host's Company databases; two-Company isolation on the host (covered by the isolation regression on the same code); the host's PostgreSQL version. The simulation ran on Windows with a real `node_modules` copy instead of the Linux symlink, and without a process manager.

## 8. Observation from the hosting Release Center (screenshots supplied by the owner, not produced by this audit)
First view: release 1.1.10 held at `health_checking`, header "current version 1.1.9", upgrade check "target is the installed version": the state of a deploy whose process was replaced by the restart after the swap. Second view: current version 1.1.10, release 1.1.10 `succeeded`, all 11 migrations shown applied without error. This matches the engine's boot-time `reconcileInterruptedDeploys` completing the interrupted deploy. The "nothing to upgrade" answer of the upgrade-path check after success is expected. **Action required on the host: confirm the Company databases were migrated** (fan-out `on`, or the runner), because the platform list shown does not prove it (I-1).
