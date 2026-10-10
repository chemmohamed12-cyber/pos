# Release 1.1.9 — build and verification record (2026-10-10)

Status: BUILT and VERIFIED. NOT deployed. Awaiting the user's deployment approval.

## Package
- File: `Daii-Release-v1.1.9-2026-10-10.zip` (4,983,089 bytes), in `D:\DAII-LOCAL-DEPLOY\release-out\`
- SHA-256: `cff205a63d5eb4fece4715b5e5fe75a5a8fef7a14be1924f09df9b52e385e9f7` (the `.sha256` file and an independent `sha256sum` agree)
- Source commit: `3e0b139` on master, built from a clean detached worktree (0 local changes)
- `build-release.sh --verify`: **VERIFY: PASSED** (3900 manifest files, 0 problems, dist JS syntax 0 bad, served bundle consistent, secret scan clean)
- MANIFEST: version 1.1.9, migrationCount 288

## Contents (1.1.8 + three fixes)
1. Unknown-warehouse guard on PR/PO/SO: unknown `warehouseId` returns 404 before any mutation (`92426fe`).
2. One UTC business-date convention for the subledger/reconciliation path (`3ef67f4`): `dist/foundation/localization/business-date.js` is present.
3. WIP control account 1150 in the `ifrs-sme` template (`352f0df`): it reaches new Companies only, because `importTemplate` refuses a non-empty chart and no migration references 1150.

## Exclusions confirmed
- LA-1 (`company-lifecycle-admission`, scheduler and audit-controller changes) is absent from the package (0 hits in `dist`); it stays uncommitted and on HOLD.

## Tests
- Serial regression (`--runInBand`) on the unified tree: 194/195 suites green. Parallel runs flake on the shared ambient DB; this is a known test-isolation follow-up, not a product defect.

## Not part of this release (separate tasks)
Key rotation, the four bare PROVISIONING companies, the audit-chain evidence at seq 1, the staging lifecycle, LA-1.
