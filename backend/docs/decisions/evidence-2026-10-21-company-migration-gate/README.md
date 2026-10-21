# Evidence - Company migration gate (CTO 2026-10-21)
All runs on the dedicated 5546 cluster, namespace `daii_test_biz_t88_*` (dropped afterwards; the database list is as before). No hosted or shared development database was touched.

## 1. Real-PostgreSQL specs (`real-pg-spec-run.summary.txt`)
`company-schema-check.real-pg.spec.ts` 6/6 and `company-fanout.real-pg.spec.ts` 13/13 (incl. the new RESUMABLE and DECOMMISSIONED/STALE cases). Key results: ZERO findings on a healthy Company migrated by the real migrations of every tag (150+ tables checked), ZERO findings for a Company that never had optional modules, a dropped column (`products.itemType`) and a dropped treasury table are reported by name, the check is read-only, an unreachable database is `ran:false` (never clean) and the message carries no password.

## 2. The incident on real data (pre-1.1.11 Alpha snapshot from daii_dev, 308 migrations, restored into an isolated database)
BEFORE: 12 migrations pending, schema check ran over 150 tables and found **14 missing tables** (bank_statement_lines, bank_statement_matches, bank_statements, cash_sessions, customer_payment_reversals, procurement_invoice_policies, purchase_return_lines, purchase_returns, supplier_credit_note_lines, supplier_credit_notes, supplier_invoice_line_receipts, supplier_payment_allocations, ...) and **missing columns on 3 tables** (supplier_invoices x12, purchase_order_lines x2, goods_receipt_lines x2). MIGRATE: 12 ran. AFTER: 164 tables checked, 0 findings.

## 3. End-to-end engine rehearsal (files `rehearsal-*-deploy.json`: every audit event of the release)
Real platform + Company database at the 1.1.10 schema (299 migrations, built from the 1.1.10 package by Treasury's bootstrap), the NEW engine installed as the active slot (labelled 1.1.10), the immutable 1.1.11 zip (sha256 c5d0afa7...) deployed through `tools/release-sim/local-deploy-harness.js`:
| Scenario | Result |
|---|---|
| A `RELEASE_COMPANY_MIGRATIONS=off`, Company behind | status `failed`, `COMPANY_MIGRATIONS_REQUIRED_BUT_DISABLED ... Rehearsal Co (21)`, platform 299, Company 299, no slot change: nothing was changed |
| B `dry-run` | plan only: release back to `backup_verified`, no error, platform 299, Company 299, no previous slot, event `plan_only` |
| C `on` (the SAME release, deployed right after B) | events: plan, gate PASS, company_backups (restore point per Company), company_migration_started/succeeded, fanout_verified, gate PASS (post-migration), swapped, evidence, succeeded; platform 320, Company 320, slot swapped, previous slot kept |
| E1 `on` while a process holds the active directory (the local EBUSY) | migrations completed, activation failed: status `failed`, message `ACTIVATION_FAILED_AFTER_MIGRATIONS ... databases are ahead of the active application, which keeps running`, audit `databasesAheadOfActiveApplication: true`, platform 320, Company 320, active slot untouched |
| E2 the holder stopped, the SAME release re-run | `succeeded`; Company outcome `noop` (nothing repeated); 0 duplicate migration rows in either database; slot swapped |
The Release Center report builder (`company-migration-report.ts`) was fed the real audit rows of C and E1/E2: "Succeeded: 1 Company(ies) checked, 1 migrated, 0 failed." / "Failed: ... The databases are AHEAD of the active application, which keeps running; fix the cause and re-run this release." / "Succeeded: 1 checked, 0 migrated, 0 failed" (noop).
Notes: the slot is the new engine build labelled 1.1.10 because the engine compares the uploaded version with the INSTALLED version (a 1.1.11 slot would refuse 1.1.11); the rehearsal covers the engine that will perform the NEXT upgrade, not the 1.1.10 engine that performed the 1.1.11 one.

## 4. Final regression of the release area (real PostgreSQL / HTTP, namespace t89, after the last code change)
`real-pg-regression-t89.summary.txt`: company-fanout.real-pg 14/14 (incl. UNKNOWN HISTORY), company-schema-check.real-pg 6/6, release-migration-registry.real-pg (H3) 21/21, release-execution-environment-check 9/9, restore-manager-audit-chain.real-pg 3/3, company-migration-runner 5/5, installation-bootstrap.real-pg 8/8, release-upload.http 3/3 = **8/8 specs, 69 tests**. Databases dropped afterwards; the cluster list shows no t88/t89 database.
