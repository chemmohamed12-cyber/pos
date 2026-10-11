# Consolidated execution report — WP-INV-07 (H5) + PA-33 sequence-lag baseline + parallel workstreams — 2026-10-11

## 1. Commits (explicit paths, all test/doc only)
| Commit | Scope |
|---|---|
| `06ef615` | `src/foundation/testing/t25-h5-shipment-transitions.biz.real-pg.spec.ts` (new), `tools/testing/biz-run.js` (+1 step). No product code |
| `2efe28c` | `WP-INV-07-H5-SHIPMENT-TESTABILITY-REPORT-2026-10-11.md`, clean-snapshot evidence `evidence-clean-snapshot-2026-10-11/06ef615-h5/` |
| `9b52e46` | `t26-audit-seq-lag-baseline.biz.real-pg.spec.ts` (new), `biz-run.js` (+1 step). No product code, no guard |
| (this commit) | this report and the T-26 evidence `…/9b52e46-t26/` |
Earlier in this session: `ba8b5b9` (reviewer addendum + f881e53 re-run evidence).

## 2. Provenance
Both new evidence sets come from a clean `git archive` of the stated commit (`SOURCE_COMMIT.txt`), `npm ci` offline + `npm run build`, run header `dirtyPaths: []`, databases `daii_test_biz_t25_*` / `…t26_*` created and removed, other databases unchanged. Working-tree dry runs were used only to debug the specs and are not evidence. DB runs were announced as exclusive: peers were idle, no overlapping runs; the cluster is released.

## 3. Results
**T-25 (H5, commit 06ef615):** 8 PASS · 1 FAIL-DEFECT · 0 BLOCKED · 0 SKIPPED. H5-1/2 (8-way pickup/deliver, plain and transaction): exactly 1 success, 7×409, single tracking event, `shipment.delivered` published once. H5-3 transaction, H5-4, H5-5, H5-6: PASS. **H5-3 plain manager: FAIL-DEFECT (new candidate H5-D1)** — see WP-INV-07 report: after a failing custody transfer the shipment stays `picked_up` and a reservation is drained with no counterpart at the custody warehouse (the controller passes the plain manager). Not fixed; fix shape (run the body through `runInTransaction`) needs separate authorization.

**T-26 (PA-33 sequence-lag baseline, commit 9b52e46):** 1 PASS · 2 FAIL-DEFECT (observations).
- L0 healthy chain: PASS.
- **L1 sequence set back below max(seq):** the next audit write fails loudly (`23505 duplicate key audit_records_pkey`); chain unchanged and valid. Effect = availability (every audit-writing operation fails) until the sequence is realigned, no corruption.
- **L2 row with explicit seq (103) above the sequence (valid hash, as an import would carry):** the next append *succeeds* with seq 4 but takes `prevHash` from seq 103 (it reads `ORDER BY seq DESC`), so the stored order (…,3,4,103) disagrees with the link → **chain reports broken at seq 4, silently**. Effect = integrity (silent chain break), no error at write time.
- Conclusion for the recommendation: the lag scenario is **reproducible on current code** with two distinct failure modes. A guard (`GREATEST(nextval, max(seq)+1)` under the audit lock, or a startup alignment check) would address both; it is **not implemented**. Recommendation for the CTO: approve designing the guard as its own package with these two cases as its acceptance tests; the guard does not repair history, so PA-33 (existing broken chains: source of truth, handling, audit trail) stays a separate policy decision. Nothing historical was read from or written to any real database.

## 4. Findings and status
| Item | Status |
|---|---|
| H5 | Measured (no longer BLOCKED): concurrency/rollback/authorization OK; **H5-D1 open defect candidate** |
| N-02 | **OPEN** (H5-D1 added; H3/H1/H2/H4 verified earlier; F-AUD-003 fixed for new writes) |
| PA-33 | **OPEN** (baseline produced; guard not implemented; historical chains untouched) |
| WP-INV-07 | Testability DONE; fix of H5-D1 not authorized |
| WP-LA1-03 (lint) | Not mine and not touched; owner action pending. CI **NOT GREEN** (last measured at `f881e53`: 3 errors + 5 warnings, all LA-1 files; HEAD changed only by tests/docs since, lint not re-run here) |
| Independent review | **Not performed and cannot be self-assigned.** I wrote `runInTransaction` and the fixtures reviewed here, so I do not qualify; Team 3 coordinates only. A named independent reviewer is still required for H3/H1/H2/H4/F-AUD-003 (inputs: `71e5f5e-final/`, `71e5f5e-reviewer-rerun/`, review §7). New T-25/T-26 evidence should be added to their pack |
| Release | **NOT APPROVED** |

## 5. Conflicts of interest
Author of T-25/T-26 and of the earlier `runInTransaction`/probes is this session; shared git identity. Both specs are evidence for the CTO's decision, not closure. Spec doubles in T-25 (recorder event bus, fixed order contracts) limit the claim to the tested shape.

## 6. Decisions needed (only those)
1. Authorize (or not) a fix package for **H5-D1** (product change in `ShipmentService.transitionShipment`, same pattern as N-01/N-02).
2. Authorize designing the sequence-lag guard with T-26 L1/L2 as acceptance tests, separate from the PA-33 history policy.
3. Name the independent reviewer; LA-1 owner to fix lint.
4. Carry-over: F-INV-001 operator, D-04 items, dependency updates, capacity targets/staging.
