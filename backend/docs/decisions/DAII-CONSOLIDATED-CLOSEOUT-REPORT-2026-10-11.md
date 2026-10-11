# DAII — Consolidated closeout report (Team 3) — 2026-10-11

Prepared by Team 3 (documentation and coordination) under the Mandatory Sequential Closeout Directive. Baseline: repository HEAD `1b694f5` (clean tree except untracked `_release-output/` files), after `a5e656a`, `29e0247`, `1b694f5`. This is the single closeout report; the registers (`DAII-WORK-PACKAGE-DEPENDENCY-REGISTER`, `DAII-CTO-DECISIONS-AND-BLOCKERS`, `DAII-MASTER-EXECUTION-PLAN`, `DAII-INDEPENDENT-REVIEW-EVIDENCE-PACKAGE-INDEX`) were updated instead of issuing phase reports.

**Official status (unchanged): N-02 OPEN · PA-33 OPEN · PA-43 OPEN · CI NOT GREEN · RELEASE NOT APPROVED.**

Vocabulary: **IMPLEMENTED** = a commit contains the change. **VERIFIED** = clean-snapshot evidence of that commit exists (here produced by the same verification track that wrote the fix, unless stated). **INDEPENDENTLY ACCEPTED** = a reviewer who meets the independence rule has recorded a decision. **No item below is INDEPENDENTLY ACCEPTED.**

Team 3's limits in this closeout: product code and database-backed tests are outside Team 3's mandate (documentation and coordination only; it has no database access and may not certify independent closure). Phases 1 and 3 therefore belong to other tracks and are reported as found.

## 1. Task by task
| Phase | Task | Owner | Final state at HEAD `1b694f5` | Evidence |
|---|---|---|---|---|
| 1 | T-04 alone | Verification track | **NOT DONE.** No test-only split and no individual run is committed (the combined spec `t03-t04-concurrency.biz.real-pg.spec.ts` is unchanged). T-03/T-04 results exist only inside the combined step: 20 PASS on `71e5f5e` and `f881e53` | `71e5f5e-final/`, `71e5f5e-reviewer-rerun/` |
| 2 | WP-INV-10 / H5-D1 | Verification track; reviewer | **IMPLEMENTED** (`03900acb`) and **VERIFIED** on a clean snapshot (author's track); **not independently accepted.** Coverage review by Team 3 in §2 below: no re-run needed; four residuals listed for the reviewer | `29e0247`: `0390ac-wp-inv-10/` (folder name lacks a zero; full hash in `SOURCE_COMMIT.txt`) |
| 3 | LA-1 / CI | LA-1 owner | **NOT DONE.** `npm run lint` re-run by Team 3 on the clean working tree at `1b694f5` (read-only): **3 errors, 5 warnings**, identical to the earlier diagnostics: `installation-audit.controller.ts` 5:10 `RolesGuard` and 6:10 `RequireRole` unused; `company-lifecycle-admission.real-pg.spec.ts` 5:1 restricted cross-domain import of `preliminary-hold-expiry.scheduler`. This is a working-tree run, not clean-snapshot evidence. **CI NOT GREEN** | command `npm run lint` in `backend/`, output summarised here; earlier logs `test-03/evidence/ci-run-n02-*.log` |
| 4 | Independent reviewer | Coordinator → CTO | **NOT APPOINTED.** No name was received. The pack is ready: `DAII-INDEPENDENT-REVIEW-EVIDENCE-PACKAGE-INDEX-2026-10-11.md` (independence register, checklists, profile) and the verification track's `test-program/INDEPENDENT-REVIEW-EVIDENCE-PACK-2026-10-11.md`. No finding was reviewed independently; none is closed | — |
| 5 | WP-AUD-09 / PA-43 | Audit/Architecture | **NEED NOT ESTABLISHED.** No approved read-only role and no database list is documented, so the check was not started. The approval request is prepared (Annex A). No UUID repair was run and no historical record was touched | trace and protocol `DAII-WP-AUD-09-…-PROTOCOL-2026-10-11.md` |
| 6 | WP-AUD-08 / DEC-01b | CTO | **Decision prepared (§3); nothing implemented, no sequence or record touched.** Waiting for the CTO | `DAII-WP-AUD-08-SEQUENCE-LAG-GUARD-DESIGN-2026-10-11.md`, `test-program/WP-AUD-08-…`, T-26 `9b52e46-t26/` |

## 2. Phase 2 — WP-INV-10 coverage check against the published evidence (no re-run)
Requirement → evidence in `0390ac-wp-inv-10/` (clean snapshot of `03900acb`, `dirtyPaths: []`, manifest sha256 re-computed OK):
| Requirement | Evidence | Style |
|---|---|---|
| Complete rollback after a failing custody transfer | H5-3: state, tracking events, transitions, movements and reservations all unchanged (previously FAIL-DEFECT at plain, now PASS) | plain and transaction |
| No reservation lost | H5-3b: active quantity 6 → 6 after the failure | plain and transaction |
| Retry succeeds | H5-3b: retry OK; state `picked_up`, 4 movements, 2 custody reservations, quantity 6 | plain and transaction |
| Concurrency | H5-1 (8-way pickup) and H5-2 (8-way deliver): one winner, seven 409, no duplicate movements | plain and transaction |
| Outer-transaction rollback | H5-4: nothing persists, 0 events published | caller's transaction |
| Legal path | H5-5: pickup → depart → arrive → deliver; 5 transitions, 4 movements | company manager (e.manager) only |
| Illegal and unauthorized | H5-6: 409 on an illegal edge, 403 for a stranger (driver action and non-driver action), no side effects | company manager only |
| Callers through the real services | six regression specs (shipment, delivery, returns ×4) PASS; unit 59/430; guard 50/50 | transaction (DeliveryService) and controller routes |
Conclusion: the published evidence covers every listed requirement; no additional run is justified. **Residuals for the reviewer (not blockers):** (R1) H5-5/H5-6 were run through one manager style; the other style is covered by the delivery regression only. (R2) No HTTP/controller-level test of the pickup route with the real controller. (R3) Event effects are asserted through a recorder, not a real outbox (a failure while publishing `shipment.delivered`/`failed`/`returned` at a plain manager is not separately injected). (R4) The pre-check read of the waybill still runs outside the transaction (unchanged behaviour). The fix and the test it is judged by are in one commit, which is why acceptance rests on the clean-snapshot run, not on the commit message.

## 3. Phase 6 — WP-AUD-08 / DEC-01b: one recommendation
**Recommendation: approve the pre-check fail-closed design with lag checks (Team 3 design, B′ + C), and keep audited automatic repair as a possible later addition rather than the first implementation.**
| Reason | Basis |
|---|---|
| Integrity outranks availability for an audit chain, and the silent failure (L2) is the dangerous one | T-26 MEASURED: L2 appends successfully and the chain breaks at the new row; L1 is loud (duplicate key) |
| No realistic trigger exists today: one writer path, and `pg_restore` carries sequence values; a lag needs an import, a manual reset or a DEC-02 recovery | VERIFIED by reading; restore not exercised |
| Automatic `setval` would hide an unexplained import or restore error, mutates sequence state outside the transaction and needs UPDATE rights on the sequence | design comparison in the brief (DEC-01b) |
| Fail-closed needs no extra privilege and no record of its own; it makes the anomaly impossible to miss | design §2–§4 |
Risks of the recommendation: a lagging Company is blocked until an operator realigns the sequence (needs a named owner and runbook before enabling); one extra read on the audit write path (bounded by the existing advisory lock; measured by test G-9).
Acceptance tests (merged from both designs): T-26 L1/L2 flip to refusal with the identifiable error and no row written; sequence unchanged after refusal; 10 repeated attempts do not drift; 20–40 concurrent writers under lag produce no duplicate-key error and no out-of-order row; realign then concurrent writers succeed with a valid chain; rollback case; already-broken chains and all existing rows byte-identical; healthy path and T-22/T-23 (golden vector) unchanged; statement-count/latency recorded; the lag check reports in restore, startup and verifier; startup assertion that the audit sequence is increment 1, cache 1; clean-snapshot run of the implementing commit and independent review.
**If the CTO prefers availability:** request the alternative (realign-on-detect) with an added audit record of every realignment; the acceptance tests above apply with the success-path assertions of the verification track's design.
**Decision needed from the CTO:** (a) choose the recommended design or request the audited-repair alternative; (b) name the owner of sequence realignment; (c) separately authorize implementation. Nothing is implemented.

## 4. Findings — IMPLEMENTED / VERIFIED / INDEPENDENTLY ACCEPTED
| Finding | Fix commit | VERIFIED evidence (clean snapshot) | Independently accepted | Remaining |
|---|---|---|---|---|
| N-02 H3 `fulfillReservation` double dispatch (and order-level) | `a798d9d`, `5c5b791` | `71e5f5e-final/` (23/23 clean headers), `71e5f5e-reviewer-rerun/` (6/6): T-21 13 PASS, T-20 H3 PASS, T-03 step 20 PASS | **No** | independent review; sibling methods unprobed (WP-INV-09); no HTTP-level double-confirmation test |
| N-02 H1 limit engine | `5c5b791` | T-24, T-20 H1 PASS on `71e5f5e`; baseline FAIL in `961dacd-t24-baseline-unfixed/` | **No** | independent review |
| N-02 H2 `releaseReservedQuantity` | `5c5b791` | same | **No** | sibling methods with the same idiom unprobed |
| N-02 H4 racing `ProcessEngine.start` | `5c5b791` | same | **No** | relies on the unique index existing in every database |
| N-02 H5 / H5-D1 | `03900acb` | `29e0247` (T-25 11/11, regression 6/6, unit 59/430, guard 50/50) | **No** | independent review; residuals R1–R4 |
| PA-33 / F-AUD-003 | `c764fc5` | T-22/T-23 PASS on `71e5f5e` and the re-run | **No** | independent review; sequence-lag guard undecided; already-broken chains (DEC-02) |
| T-03 / T-04 | none | step 20 PASS inside one combined run | — | T-04 individual run not done |
| PA-43 UUID repair vs audit hash | none | code trace only (NOT test evidence) | — | need not established; DEC-25 final pending |
| N-01 | `23e5ec1` and others | separate stream; not reopened here | not by Team 3 | out of this closeout |

## 5. Decisions still required from the CTO (with recommendation)
| Decision | Recommendation |
|---|---|
| DEC-08: appoint the independent reviewer | Have the coordinator submit a candidate meeting the profile (index §3.2); until then no finding can be accepted |
| DEC-01b: sequence-lag guard | §3: approve the fail-closed pre-check with lag checks; name the realignment owner |
| DEC-25: UUID-repair policy | Keep the interim prohibition; decide finally only after the WP-AUD-09 counts. Approve the read-only request in Annex A so the counts can be produced |
| DEC-02: already-broken chains | Keep separate; no re-hash or rewrite; decide after the PA-43 counts and the reviewer's view |
| LA-1 lint | Instruct the LA-1 owner to deliver the three-error fix as a separate commit (protected files, no guard weakened) |
| Acceptance of the T-04 position | Accept the combined-step evidence as interim only if an individual run cannot be scheduled soon; otherwise require the split |

## 6. What prevents approval of the release (exact list)
1. N-02 OPEN: no independent review of H3, H1, H2, H4 and H5-D1; reviewer not appointed.
2. PA-33 OPEN: no independent review of `c764fc5`; sequence-lag guard undecided (silent failure reproduced on a disposable database); DEC-02 undecided.
3. PA-43 OPEN: the UUID repair could rewrite hashed audit fields; need not established (no approved read-only access); DEC-25 final pending.
4. CI NOT GREEN: 3 lint errors in LA-1 files (measured at `1b694f5`), unfixed.
5. T-04 has no individual run.
6. Protected or blocked test groups remain NOT RUN (see the reconciliation note and the register, WP-LA1-02, DEC-09), and the six adaptation diffs have no line-by-line review.
7. Open payroll/accounting/treasury findings (PA-34/35/36), F-INV-001, capacity and dependency decisions are unchanged and unresolved.
8. No release decision, hosting or production evidence exists in this program.

## Annex A — Request to approve the read-only need check (WP-AUD-09)
To be approved by the CTO/owner; Team 3 cannot grant it. Execution belongs to the Audit/Architecture track.
1. **Role:** a dedicated database role with `CONNECT` and `SELECT` on `users`, `org_units`, `audit_records` and `data_repair_runs` only, `default_transaction_read_only = on`, no write, DDL, function or sequence privileges, no `SUPERUSER`/`CREATEROLE`, expiring after the check. Name: to be assigned by the owner.
2. **Databases (explicit list, non-production only):** to be filled by the owner before approval — for each: database name, server, whether it is the installation/control-plane database or a Company database or a legacy single-database copy, and confirmation that it holds no production data. Production, hosting and protected clusters are excluded.
3. **Scope:** counts Q0–Q6 of the protocol only; no sample ids, no row contents, no `auditNonCompliantUuids`, no `planUuidRepairMapping`, no repair, no verification run that writes.
4. **Evidence to keep:** database names, time, role and read-only status, numeric outputs, server identity, tool version, errors; no connection strings or credentials.
5. **Stop conditions:** the protocol §4.5. If items 1 and 2 are not approved, the status stays **NEED NOT ESTABLISHED**.

## Annex B — Evidence and commits referenced
`c764fc5`, `a798d9d`, `5c5b791`, `03900acb` (fixes); `71e5f5e`, `f881e53` (clean-snapshot runs); `06ef615`, `9b52e46` (T-25/T-26 tests); `29e0247` (WP-INV-10 evidence); `c22f193`, `a5e656a`, `1b694f5` (Team 3 documentation). Evidence folders under `backend/docs/decisions/evidence-clean-snapshot-2026-10-11/`.
