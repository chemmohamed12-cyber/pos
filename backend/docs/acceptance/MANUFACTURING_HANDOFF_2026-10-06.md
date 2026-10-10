# Manufacturing — Closed and Handed Off (2026-10-06)

**MANUFACTURING = CLOSED** (CTO Final Acceptance, M10). Any new development is a separate, documented scope — not an extension of M10.
Evidence: `MANUFACTURING_M10_CLOSURE_REPORT_2026-10-06.md` (+ `MANUFACTURING_INTEGRATION_MATRIX_2026-10-06.md`). Implementation: commit `5011691` (+ the Manufacturing parts of `1517d81`).
Backups/evidence are retained unchanged: `C:\DAII-BACKUPS\manufacturing-rollout-20261006-074056\` (mirror `D:\DAII-BACKUPS\…`).

## H1 — Dev runtime (owner: whoever runs the `:3500` backend)
- The running process is the **pre-rebuild** `dist/main.js`; `/api/manufacturing/{boms,routings,work-centers}` still return 404 there.
- Restart the backend from the latest build (`npm run build` is already done in the working tree), then smoke test as **Alpha** (`full-suite`) and **Gamma** (no package): Manufacturing appears in navigation; Work Centers / BOMs / Routings / Assembly / Work Orders open.
- Beta and Delta (`commerce-core`) correctly do **not** show Manufacturing.
- Do not reset credentials or data.

## H2 — ACCOUNTING GAP — WIP CONTROL ACCOUNT (owner: Accounting; **not** fixable inside Manufacturing)
The `ifrs-sme` chart template has no active postable account with `controlFunction = 'wip'`. A Company that imports the template gets Manufacturing Financial Events (`material_issued`, `material_returned`, `finished_goods_received`) **Rejected** with: *no active postable account has controlFunction "wip" — assign one first*.
Accounting to decide: standard account code · `controlFunction = wip` · inclusion in the `ifrs-sme` template · provisioning/import behaviour · real-PG verification. Evidence then returns to integration-matrix rows 4, 5, 7. Gated by D10 for accounting fixes.

**H2 update (2026-10-06, Accounting) — IMPLEMENTED/VERIFIED at real-PG level; browser/UAT pending.** D10 is closed. Decision: `1150 Work in Process`, `controlFunction = wip`, asset, always in the `ifrs-sme` template; importer unchanged; no data migration into existing charts (recovery for already-imported Companies = create/assign a `wip` account, then re-drive the REJECTED events). Proof: `wip-control-account.company-isolation.spec.ts` 8/8 (template-only chart → issue/return/FG output post Dr/Cr exactly per ADR-061 §13; WIP reconciliation `matched`, drift 0). Full record and the rows 4/5/7 evidence: `decisions/WIP-CONTROL-ACCOUNT-TEMPLATE-2026-10-06.md`. The isolated provisioner no longer hand-inserts 1150.

## H3 — Platform migration registry (owner: platform/release)
`backend/src/database/enabled-modules.ts` `MIGRATION_TAGS` lists 6 tags (`core, sales, inventory, logistics, finance, hr`) and omits `accounting, attendance, commission, manufacturing, payroll, procurement, targets`. Verify future company provisioning and entitlement-driven migration selection (`tagsForModules`, Release Engine `migration-datasource`) treat them correctly. Not a reason to reopen Manufacturing.

## H4 — D3 (owner: D3)
Company DBs already carry D3 migration rows from original provisioning — Alpha 1, Beta 1, Gamma 2, Delta 2 (`AddManualReceiptCostAndReasonCode1789860000000`, `SeedManualReceiptTerminology1789870000000`); the platform `daii_dev` has none. State was identical before and after the Manufacturing rollout. Reconcile against the "D3 not approved" decision. Not touched by Manufacturing.

## H5 — Other non-blocking follow-ups
Dead `inventory.assembly` feature flag (Inventory manifest) · no platform-wide client route guard · `perm.*`/`role.*` display terminology · WIP reconciliation / Closing Audit UI · mobile layout and full RTL review · operator-role browser E2E (proven at real-PG permission level only).
