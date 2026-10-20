# DAII 1.1.10 — transferable release package (2026-10-16)

Local release only. Hosting deployment and Production are out of scope and were not touched.

## 1. Identity
- Version: **1.1.10** (backend and frontend package.json and lock files). Protected **1.1.9** package `Daii-Release-v1.1.9-2026-10-10.zip` SHA-256 `cff205a63d5eb4fece4715b5e5fe75a5a8fef7a14be1924f09df9b52e385e9f7` re-hashed after the build: unchanged.
- Source built: commit **b99964a** (`chore(release): version 1.1.10`) on `integration/local-2026-10-16`. Later commits (this report, evidence) change documentation only; the source checksum below is identical at b99964a and at the final HEAD.
- Source checksum (SHA-256 of `git ls-tree -r <commit> -- backend/src frontend/src`): `40fb089f02b22f41f7c5eb32239493f43d3b9cfd84b02ee2365bc0b9bab594e6`.

## 2. Package (location and hashes)
- Location: `D:\DAII-LOCAL-DEPLOY\release-out\Daii-Release-v1.1.10-2026-10-16.zip` (+ `.zip.sha256`), 4012 manifest files, package type `full`, 299 migrations (`migrationRequired: true`).
- **Package SHA-256: `89b8a9797a0a5ab71db44b0ee29241203b619a33e92a17f3d32838ee42103097`** (the exact file delivered).
- A second build from the same commit produced a zip with different container bytes (`9b29f5bc…`, file timestamps) but **identical contents** (`diff -r` empty). The reproducible identity is therefore the content hash: SHA-256 of the sorted per-file SHA-256 list = `d9cb0404a6d96c5d81e588a390f4a293f28f84cb86d9567eecb2f4a018024f01` (4015 files incl. MANIFEST.json, package.json, package-lock.json).
- Component content hashes (same method): `dist` (3003 files) `3c3422f8879775da68f1002c947bcdecfefbd8ff3fc634c0940726f44758e736`; `src` (1004) `0d166353b0c866b0a2b34a69715a441f27e61eb6bab2eee5338533243d1229c0`; `public` (5) `855cea47c112d786ed8b720f33ef5444483cbca4067900cd3e172d6089454367`. Per-file checksums are in the package `MANIFEST.json`.
- The hashes in `LOCAL-RC-PACK-2026-10-16.md` refer to commit 00455ce and are **superseded** by this document.
- Package self-verification (build script): manifest 0 problems, dist JS syntax 0 bad, served bundle consistent, secret scan clean, `VERIFY: PASSED`.

## 3. Verification — all executed on b99964a unless stated
| Gate | Result |
|---|---|
| CI (`tools/ci/ci.sh`: install, build, lint, structure, doc-links, unit, db-guard) | PASS (unit 60 suites / 436 tests, db-guard 50/50) |
| Frontend `npm ci`, `tsc -b`, lint, build | PASS; lint 0 errors, 56 warnings (= baseline) |
| Isolation regression (regression-specs-all.txt, cluster 5546) | **101/102 specs PASS — not 102/102.** The one non-pass is `release-migration-registry.real-pg.spec.ts`, a pre-existing baseline blocker: its own safety assertion demands DB_PORT 5544 (see DAII-FINAL-PHASE-CLOSURE-REPORT-2026-10-14.md). Accepted exception. |
| Business suite T-00..T-31 | ALL REQUESTED STEPS PASSED (exit 0) |
| Browser acceptance (pickers, Item Details, profiles, TB footer) | 12/12 PASS, executed on the integration preview at 00455ce; the later commits changed only two lint-suppression comments, the version metadata and documentation, so it was not repeated; the preview is restarted from the final build (section 6) |
Evidence: `evidence-2026-10-16-rc-1110/` (logs), earlier RC evidence in `evidence-2026-10-16-rc/`.

## 4. Release notes (user-visible)
Purchase orders, purchase approval and new purchase requests reject missing and discontinued items (D7); trial balance footer totals reconcile (gross contract preserved); movement report honours `dateTo`; Products screen shows and edits the item's warehouse; Item Details page with six tabs; item master (categories, item type, default warehouse, reorder level, description, barcodes, BOM panel); scan-or-type item pickers (Enter resolves an exact SKU or barcode) on PR, PO, warehouse form, Inventory filter and BOM; customer profile (fields, contacts, addresses) and supplier profile (fields, contacts, addresses, purchases tab); Arabic and English labels for all of it.

## 5. Migrations — order, status and rollback
- Order (by timestamp, per tag directory, applied by the migration runner / release engine): core 1790014000000; sales 1790015000000, 1790015100000, 1790015200000; core 1790015300000, 1790015400000; sales 1790016000000, 1790016100000; core 1790016200000; procurement 1790016300000; core 1790016400000. The 1790015xxx ones were authored after 1790016xxx ran on the dev database; TypeORM accepts the out-of-order run.
- Status on the experimental `daii_dev` (platform + Alpha, Beta, Gamma, Delta): each of the 11 appears **exactly once** in every `migrations` table (check script in the evidence folder). The three non-idempotent migrations (1790016000000, 1790016100000, 1790016300000) must run once, through the runner only — never by hand or twice.
- Rollback guidance: **roll back the application (re-deploy 1.1.9) and keep the schema.** The new columns and tables are additive and nullable, so 1.1.9 runs unchanged on the migrated schema. A database rollback (each `down()` is reversible, order 1790016400000 → 1790016300000 → 1790016200000 → 1790016100000 → 1790016000000 → 1790015400000…1790015000000 → 1790014000000) deletes all categories, barcodes, item master fields, customer profile data, addresses, contacts and supplier profile fields; use it only through a separately reviewed procedure.

## 6. Local preview
Restarted from the final committed integration worktree: backend :3500 (`daii_dev`), frontend :5173.

## 7. Accepted limitations
F11-TZ (target-host timezone) deferred, no host access; RFQ-award dead-letter retry residual; `release-migration-registry` spec blocked (baseline); no `verify:repo` script; the zip container bytes are not byte-reproducible (contents are); supplier profile has no goods-receipt-by-supplier list; contacts/addresses UI offers add / set-primary-default / remove only; end-to-end receipt→transfer→issue not clicked through in the browser (covered by the business suite).
