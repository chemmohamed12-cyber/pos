# Inventory Lifecycle - Slice C1 evidence report (2026-10-17)

Branch `feature/inventory-lifecycle` (base 85bf825). Scope: CTO decision 2026-10-17, **C1 only** (observational, backward-compatible). Nothing was deployed; no production database, configuration or data was touched. All schema work ran on disposable databases of the guarded test cluster 127.0.0.1:5546. **C2 and later slices are not started and need explicit CTO approval.**

## 1. What C1 delivers

| Area | Delivered |
|---|---|
| Valuation reporting + as-of | `GET inventory/valuation/report` (warehouse / item grouping, `asOf`, F6 warehouse scope, `inventory.valuation.view`); optional contract methods `getValuedPositions`, `checkHistoryConsistency`; additive nullable `inventory_valuation_movements.businessDate` (UTC-date default, legacy rows backfilled from the UTC date of `createdAt`) |
| Cost vs selling price KPI | Warehouse overview returns `totalInventoryValueAtCost` + `valuationAsOf` (null without `inventory.valuation.view`, summed over the caller's visible warehouses only); the screen shows cost as the primary figure, selling price secondary and labelled |
| Reconciliation (read-only) | `GET accounting/inventory/reconciliation-preview` (persists nothing); itemised difference: rounding (exact, per posted line), unposted value (events + outbox), F07 entries without valuation effect, manual/opening journals; `explainedBase` / `unexplainedBase` / `basis` / `classification` on runs. Phase-1 rounding only: no amount changed, **no tolerance** |
| Posting-status visibility | `GET accounting/posting-status`, `GET accounting/financial-events/by-reference`; chip on Overview, GL, TB, Inventory Accounting, Financial Events |
| Continuous refresh | `useAutoRefresh` (focus / visibility / 30 s while visible, single-flight, stale-response discard, back-off, last-good data kept) + "Updated hh:mm:ss" + manual refresh on the same five screens and the new report |
| GL / TB read models | GL lines gain `entryState`, `financialEventId`, `eventType`, `referenceType`, `referenceId`; `GET trial-balance?mode=periodic` (opening / period / closing, parent roll-up, three balance tests); default TB payload byte-for-byte shape unchanged; TB to GL drill-down now keeps the period |
| Navigation | `nav.valuation_report` entry (`inventory.valuation` read) + route `/inventory/valuation-report` |
| Data | 2 additive migrations (inventory, accounting) + 1 terminology seed (core, `ON CONFLICT DO NOTHING`) |

## 2. Acceptance gate (CTO list) - evidence

| Gate item | Result | Evidence |
|---|---|---|
| Real PostgreSQL tests | PASS | `inventory-lifecycle-c1.company-isolation.spec.ts` 14/14 (`evidence-2026-10-17-inventory-c1/c1-spec-run.log`) |
| Company A/B isolation | PASS | test 14: B untouched by every new read, Platform DataSource never requested, B's own empty answers |
| Permissions and F6 scope | PASS | test 12 (cost null without permission; visible-warehouse filter); report controller uses `AccessScopeService`, an invisible warehouse answers 404 |
| Migration up/down/up + idempotent backfill | PASS | `inventory-lifecycle-c1.migrations.company-isolation.spec.ts` 2/2: backfill touches NULLs only, an explicit date is never overwritten, default stamps today (UTC), CHECK constraints enforce the vocabulary, `down` removes exactly what `up` added |
| No duplicate journals on retries | PASS | tests 3, 4, 13 (re-drive twice, flush three times: journal count unchanged) |
| **No writes from reconciliation** | PASS | test 7: table fingerprints before/after for preview, periodic TB, GL, posting status, valuation reads are identical; `reconcile` adds exactly one run row + audit records and nothing else |
| Backward-compatible API / TB contracts | PASS | test 10 golden key sets of the default TB and its rows; run `status` values and CHECK untouched; GL keeps every existing field; `GeneralLedgerController` still constructible with its old arguments |
| Existing regression suite | PASS with 2 known non-C1 results | isolation regression **102/104** (`isolation-regression-run.log`); business suite T-00..T-31 **all 29 steps PASS**, including T-18 schema drift (`business-suite-run.log`); unit tests 60 suites / 436 tests PASS |
| Browser verification | PASS (one defect found and fixed) | section 4 |

### The two non-passing regression entries (neither is a C1 effect)
1. `release-migration-registry.real-pg.spec.ts` - the known baseline exception: it refuses to run off its own isolated port 5544.
2. `area14-company-audit.real-pg.spec.ts` - its 3 tests pass; the **suite** fails in its own `DROP DATABASE ... WITH (FORCE)` teardown with `permission denied to terminate process`; reproduced on a solo re-run. This is a cluster-role permission limit of the teardown, not a product result. (It is a deviation from the 101/102 baseline noted in earlier reports; the spec was not changed by C1.)

### Other checks
- Frontend: typecheck clean, production build OK, oxlint 55 warnings / 0 errors (baseline 56).
- Backend: `tsc --noEmit` clean, eslint 0 errors (5 pre-existing warnings). Navigation specs (nav-closure etc.) PASS with the new entry.
- `db-guard` test: 49/50. The failing one (`every database-capable tool is guarded or classified as an operator tool`) names `tools/maintenance/company-migration-catchup.js` and `company-migration-status.js`, the owner tools committed in 962ecb6 / 8d86e90 before C1; C1 did not touch them. They need classification in a separate change.
- `bash tools/ci/ci.sh` was **not** run as written: its first step is `npm ci`, and in this worktree `node_modules` is a junction into the integration checkout (it would empty the shared modules). Every other CI step (build, lint, structure, doc-links, unit, db-guard) was run individually; doc-links and structure PASS.

## 3. What the C1 spec proves (numbers)
- Clean ledger: `matched`, drift 0.0000, `classification=matched`, breakdown NULL as before.
- Rounding: average cost (20+24)/9 = 4.8889 x 2 = 9.7778 posted as 9.78: difference **-0.0022**, status `drift_found`, classification `explained`, attributed to the warehouse (`rounding` category -0.0022, 1 posting), unexplained 0.
- REJECTED event: 6.00 itemised as unposted value with its reason, posting status `attention`; after re-drive: one journal added, second re-drive deduped, state `current`.
- Pending outbox: 2.00 itemised as pending; state `pending`; posts once after flush.
- F07 entry (GL only, +3.00): itemised as "without valuation effect" -3.00; identity `explained + unexplained = difference` holds.
- Valuation-only change (+2.00, no event, no journal): classification **unexplained**, unexplained 2.00 - the control still raises the alarm.
- As-of: history rebuilt per warehouse/item; a past-date reconciliation compares "then with then" (20 vs 20, matched); a corrupted running state is reported by `checkHistoryConsistency` (and repaired in the test).
- Periodic TB: opening + period = closing per account and in total; roll-up over a group account equals its leaf and totals are never doubled; three balance tests; window before everything is empty; window after everything has closing = opening.

## 4. Browser verification (isolated environment)
Environment: worktree backend (`dist/main.js`, :3603) + Vite (:5603) against disposable databases `daii_test_biz_t97_c1_cp` / `..._c1_co` on cluster 5546 (bootstrap + seed tools); test admin of the bootstrap tool. No shared or production system.
- Overview: cost KPI beside the selling-price KPI, "Updated" stamp, refresh button, chip "Postings up to date".
- **Live refresh and posting status, no reload:** a `processing` outbox row was inserted in the Company database; the chip became "Postings in progress (1 / 0)"; the row was set to `failed`; within **17 s** the same open page showed "Postings need attention (0 / 1)" in the error colour; after deleting the row the chip returned to "Postings up to date" within **16 s**. A request-rate check showed no polling storm (about 1 overview request per interval).
- API probes through the running backend: periodic TB 200 (keys `mode, from, to, rows, totals, balanced, generatedAt`, all three balance flags true); default TB keys unchanged; `mode=zzz` -> 400; posting-status 200; valuation report 200; reconciliation-preview 200 (`matched`); by-reference 200 (`none`) and 400 for a non-UUID.
- Periodic TB toggle rendered the opening / period / closing columns with the three balance badges; the new "Inventory valuation report" appears under Warehouses.
- **Defect found by this step and fixed:** the valuation report page crashed (`Cannot read properties of null (reading 'length')`) because `historyInconsistencies` is a number-or-null in the API but was typed and used as an array. Fixed in `ValuationReport.tsx`; the page then rendered (empty state, the seeded stock has no valuation rows). The data-bearing paths of this endpoint are covered by the real-PG spec (tests 8, 12).
- Limits of this step: the fresh test database lacks older terminology keys (a few labels show their codes, e.g. `field.debit_base`); C1 keys render. No journals exist in that seed, so the GL source columns were verified by the real-PG spec (test 9) rather than visually.

## 5. Deviations and open points (for CTO review)
1. **Classification column** instead of a new `explained` run status (ADR-INV-09 said status). Status vocabulary is unchanged; `drift_found` still fires for any non-zero difference. Recorded in `inventory-lifecycle-gate-b/01-CTO-DECISIONS-2026-10-17.md`.
2. **In-request `dispatchAfterCommit` moved to C2** (already recorded, CTO list did not include it).
3. **Business date of valuation rows** is stamped by a DB default (UTC date); explicit dates are C2.
4. **Known limitation of the attribution:** manufacturing postings and foreign-currency lines are not classified yet; any difference they cause stays `unexplained` (visible, never hidden).
5. The reconciliation preview runs on every Inventory Accounting refresh (30 s while visible); it is a set of SELECTs. If a Company has very large history this should be revisited in C2 (a cheaper per-slice summary or a cache).
6. `area14` teardown permission and the `db-guard` owner-tool classification (section 2) are environmental / pre-existing and need their own owner.

## 6. Deployment note (for when C1 is ever released - not done)
Two **Company-database** migrations (inventory, accounting) and one core terminology seed. They only take effect on Company databases through the release-engine fan-out (`RELEASE_COMPANY_MIGRATIONS=on` procedure) with the owner's Stage-A check first; with fan-out off, the new endpoints would 500 on Company databases that lack the columns (same class as incident I-1). Every migration is additive and reversible.

## 7. Stop
C1 stops here. Awaiting the CTO's explicit decision before C2.
