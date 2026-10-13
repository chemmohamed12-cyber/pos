# DAII — Final decision-and-owner register — 2026-10-14

**One register for every outstanding decision, answer, approval and resource; one consolidated request per responsible role (the per-role files in `owner-requests-2026-10-14/` are generated from the same list, so they cannot disagree).** It supersedes `DAII-CONSOLIDATED-OWNER-REQUEST-2026-10-13.md` as the list to send; that earlier document remains as history. **Nothing here is approved; silence is not approval; no name has been invented — roles are titles the CTO assigns.** Items already executed (dependency T1 application; `wages_payable` template fix) are not repeated except where a gate remains.

Kinds: **D** decision/approval · **A** business answer for a Phase 0 contract · **R** resource or access. Status values: PENDING (asked, no answer) · UNASSIGNED (role holder not named) · NOT APPOINTED.

## Index by role

| Role | Items | Count |
|---|---|---|
| `CTO` | C1, C2, C3, C4, C5, C6, C7, C8, C9, C10, C11, C12, C13 | 13 |
| `ACCOUNTING_POLICY_OWNER` | A1, A2, A3, A4 | 4 |
| `PAYROLL_POLICY_OWNER` | P1 | 1 |
| `HR_OWNER` | P2, P3, P4 | 3 |
| `TREASURY_OWNER` | R1 | 1 |
| `MANUFACTURING_OWNER` | M1, M2 | 2 |
| `INVENTORY_OWNER` | M3 | 1 |
| `SECURITY_AUDIT_OWNER` | S1, S2 | 2 |
| `ENVIRONMENT_OWNER` | E1, E2, E3 | 3 |
| `READ_ONLY_OPERATOR` | O1 | 1 |
| `INDEPENDENT_REVIEWER` | O2 | 1 |
| `CAPACITY_APPROVER` | O3 | 1 |
| `LOAD_TEST_AUTHORISER` | O4 | 1 |
| `INTEGRATIONS_MODULE_OWNER` | O5 | 1 |
| `SITE_OWNERS` | O6 | 1 |
| `SECURITY_AND_DEPENDENCY_OWNER` | O7 | 1 |

Total items: **37** across **16** roles.

## `CTO`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| C1 | DEC-02 already-broken audit chains | Sign the policy: accept-and-annotate under a break register; no historical audit row is modified, re-hashed or re-ordered; any repair needs a separate written approval naming the database, with verified backup and independent review. (Exact wording: decision package, DEC-02.) | SECURITY_AUDIT_OWNER (co-approval) | DAII-DECISION-PACKAGE-2026-10-13.md; DAII-DEC-01B-AND-DEC-02-AUDIT-CHAIN-DECISIONS-2026-10-13.md | WP-AUD-05/07; Phase 1 gate | PENDING |
| C2 | DEC-25 UUID repair vs audit hash; PA-43 need check | Approve (a) the interim prohibition stays, (b) the read-only need check on an attached explicit database list with the read-only role of Annex A, (c) final handling decided after the counts. Attach the role and the database list (resource D1). | SECURITY_AUDIT_OWNER (co-approval); ENVIRONMENT_OWNER | DAII-DECISION-PACKAGE-2026-10-13.md; DAII-PA43-WP-AUD-09-STATUS-2026-10-13.md | PA-43; DEC-02 inventory | PENDING |
| C3 | DEC-01b realignment function holders and the independent-reviewer requirement | Name the holders of AUDIT_DB_OPERATOR, AUDIT_CHANGE_APPROVER, AUDIT_INDEPENDENT_REVIEWER, AUDIT_OPS_ESCALATION_OWNER (at least three different people; the reviewer must be independent of the guard, runbook and verification). The assignment grants no permission to realign any database. | SECURITY_AUDIT_OWNER | DAII-DEC-01B-AND-DEC-02-AUDIT-CHAIN-DECISIONS-2026-10-13.md §1 | any future realignment (none permitted now) | PENDING |
| C4 | Independent reviewer (WP-REV-01) — also for the T1 lockfile diff | Nominate an eligible reviewer (not in the independence register; profile in the review pack), or record the continued deferral. Review scope: code review and test-evidence review per finding; plus the T1 packet. | — | DAII-INDEPENDENT-REVIEW-SCOPE-AND-READINESS-2026-10-13.md; evidence-clean-snapshot-2026-10-13/t1-review-packet/ | acceptance of N-02, PA-33, WP-INV-10, WP-AUD-08, T1 | PENDING |
| C5 | DEC-10 F-INV-001 real usage measurement | Name the operator and the databases; later decide the 410 release from the measurement (not from synthetic data). | READ_ONLY_OPERATOR | DAII-F-INV-001-OPERATOR-KIT-2026-10-13.md | release of the 410 contract | PENDING |
| C6 | D-04 integrations Company-scoped | Authorise implementation or keep on hold; answer the plan's [REVIEW] items (routing source, back-fill marker, unrouted-connector behaviour, authorization-model change); name the module owner. | INTEGRATIONS_MODULE_OWNER | DAII-D04-AND-ENVIRONMENT-READINESS-2026-10-13.md | PA-20 | PENDING |
| C7 | LA-1 remaining sites (DEC-19) | Assign an owner per call site (10 sites in 6 files) and answer the three design questions: Q-L1 revoke/role change while a Company is not READY; Q-L2 package role-sync while not READY; Q-L3 the view-context request path. | site owners | DAII-LA1-REMAINING-SITES-TRACKER-2026-10-13.md | PA-41 | PENDING |
| C8 | Capacity targets, staging host, load-test authorisation (DEC-11) | Sign or replace the workload assumptions and acceptance targets; provide a staging-like host and a separate load-generator machine; name the load-test authoriser. No test runs before all three exist. | CAPACITY_APPROVER; ENVIRONMENT_OWNER; LOAD_TEST_AUTHORISER | DAII-D04-AND-ENVIRONMENT-READINESS-2026-10-13.md §2–3 | PA-24 / PA-26 | PENDING |
| C9 | T2 owner and scope (DEC-20) | Name the T2 owner. T2 is NOT authorised by this request; scope as outlined (NestJS major, bcrypt 6, react-router 7, Jest 30) needs a separate approval per upgrade. | SECURITY_AND_DEPENDENCY_OWNER | DAII-DEPENDENCY-T2-OUTLINE-2026-10-13.md | security gate (tar critical) | PENDING |
| C10 | CI classification | Classify the documented CI result (runs on 715c22d, 0810300, 8ec6de4) for the official status line, which still reads "CI NOT GREEN". | — | evidence-clean-snapshot-2026-10-13/*-ci-full-tree/, 8ec6de4-final-verification/ci/ | release gate | PENDING |
| C11 | Template: grni and fixed_asset (separate question) | Record the accounting decision first: grni option A/B/C; fixed_asset direction (B/D etc.). Nothing is added until recorded. Also: open or decline the H2-R recovery audit for Companies provisioned before the fixes. | ACCOUNTING_POLICY_OWNER | DAII-TEMPLATE-GRNI-AND-FIXED-ASSET-PROPOSAL-2026-10-14.md | new-Company procurement posting; existing-Company recovery | PENDING |
| C12 | DEC-06 business date | UTC or Cairo (fixtures for both are computed). | — | DAII-PHASE-0-FIXTURE-CATALOG-2026-10-13.md | H0-5; attendance/commission/payroll fixtures | PENDING |
| C13 | T1 final acceptance prerequisites | Assign (a) the reviewer of the exact lockfile diff (with C4) and (b) the person with host access for the proxy compatibility check; approve a coordinated time for any `npm ci` in the shared development tree. | ENVIRONMENT_OWNER | evidence-clean-snapshot-2026-10-13/t1-review-packet/; DAII-T1-HOST-PROXY-CHECK-PROTOCOL-2026-10-14.md | T1 final acceptance | PENDING |

## `ACCOUNTING_POLICY_OWNER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| A1 | H0-4 payroll posting shape (DEC-03) | Posting amount (gross; gross + commission; later tax/insurance split), disbursement entry and partial/failed disbursement, wages-payable reconciliation and closing-audit category. Measured today: journal = gross only; commission in no journal; disbursement posts nothing. | CTO (co-signs DEC-03) | DAII-PHASE-0-CONTRACTS-…; evidence-clean-snapshot-2026-10-13/3bf740b-wp-pay-01/ | PA-34/35; Phase 1 | PENDING |
| A2 | DEC-04 commission account and timing; H0-8 reversal | Expense account, recognition timing, and reversal on void/return/credit (automatic vs reviewed queue) with the payroll cut-off interaction. | — | DAII-PHASE-0-CONTRACTS-…; FX-H08 | PA-35/38 | PENDING |
| A3 | M0-2 costing | Is standard costing, variance accounting or labour/overhead absorption required (today: moving average, material only). | MANUFACTURING_OWNER | DAII-PHASE-0-CONTRACTS-… | PH0-GATE | PENDING |
| A4 | grni / fixed_asset template (with C11) | Account code/name for GRNI (proposal: 2115) or the alternative; fixed_asset: pre-create disposal gain/loss/clearing accounts or not. | CTO | DAII-TEMPLATE-GRNI-AND-FIXED-ASSET-PROPOSAL-2026-10-14.md | C11 | PENDING |

## `PAYROLL_POLICY_OWNER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| P1 | H0-1 / DEC-05 statutory payroll scope | Jurisdiction; overtime, income tax, social insurance, other deductions, end-of-service rules; rates, caps, brackets, effective dates; table owner and signatory. | legal | DAII-PHASE-0-CONTRACTS-… | PA-16 | PENDING |

## `HR_OWNER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| P2 | H0-2 calendar, absence, lateness, unpaid leave | Holiday/working-day calendar owner; pay effect of absence, lateness, unpaid leave, missing punches; whether employees without an approved attendance batch are paid. | PAYROLL_POLICY_OWNER | DAII-PHASE-0-CONTRACTS-…; FX-H02 | PA-37 | PENDING |
| P3 | H0-3 payslip | Content, numbering, approval, access, print/export, retention. | — | DAII-PHASE-0-CONTRACTS-… | PA-16 | PENDING |
| P4 | H0-7 HR master (DEC-18) | Which of contracts, documents, leave types/balances, shifts, loans, end-of-service are confirmed. | PRODUCT_OWNER | DAII-PHASE-0-CONTRACTS-… | PA-40 | PENDING |

## `TREASURY_OWNER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| R1 | H0-6 disbursement (DEC-24) | Payment instrument (bank file and format, cash, wallet), data held per employee, partial payment, rejection and re-issue. | ACCOUNTING_POLICY_OWNER | DAII-PHASE-0-CONTRACTS-… | PA-34 | PENDING |

## `MANUFACTURING_OWNER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| M1 | M0-3 scrap / rework / by-products — answer first | Is physical scrap expected in target use? (a short Work Order can only be closed by a material return, which would re-inflate stock and cost if the shortfall was real scrap). | — | DAII-PHASE-0-CONTRACTS-…; FX-M03 | live data-correctness exposure | PENDING |
| M2 | M0-1 planning and M0-5 capacity scheduling | Contract with Sales (demand) and Procurement (requisitions); finite-capacity scheduling required or deferred to Wave 5. | PRODUCT_OWNER | DAII-PHASE-0-CONTRACTS-… | PH0-GATE | PENDING |

## `INVENTORY_OWNER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| M3 | M0-4 lot/serial | Confirmed or withdrawn; interface with movements, reservations, returns, valuation. | PRODUCT_OWNER | DAII-PHASE-0-CONTRACTS-… | PA-06 | PENDING |

## `SECURITY_AUDIT_OWNER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| S1 | Co-approval of DEC-02 and DEC-25 (C1, C2) | Co-sign C1 and C2; confirm the independence conditions for the DEC-01b reviewer function. | CTO | DAII-DECISION-PACKAGE-2026-10-13.md | C1, C2, C3 | PENDING |
| S2 | H0-9 salary-data visibility (DEC-23) | Who sees salary data and at what granularity under the existing authorization model. | HR_OWNER | DAII-PHASE-0-CONTRACTS-… | PA-16 | PENDING |

## `ENVIRONMENT_OWNER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| E1 | Read-only role and explicit database list (resource D1) | Create the read-only role (CONNECT + SELECT on users, org_units, audit_records, data_repair_runs; read-only default; no write/DDL/superuser; expiring) and supply the list of databases (name, server, kind, no production data). | DBA | DAII-PA43-WP-AUD-09-STATUS-2026-10-13.md §4.2 | PA-43, DEC-02 inventory | PENDING |
| E2 | Staging host and load generator (resource D3) | Provide the staging-like host and a separate load-generator machine; record the topology. | LOAD_TEST_AUTHORISER | DAII-D04-AND-ENVIRONMENT-READINESS-2026-10-13.md | PA-24/26 | PENDING |
| E3 | T1 host proxy compatibility check | Perform H1–H5 of the protocol read-only and record PASS/FAIL/NOT DETERMINABLE with the exact source identity. | SECURITY_AND_DEPENDENCY_OWNER | DAII-T1-HOST-PROXY-CHECK-PROTOCOL-2026-10-14.md | T1 final acceptance | PENDING |

## `READ_ONLY_OPERATOR`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| O1 | F-INV-001 collector run (resource D2) | Run the collector and summarizer per the kit on every in-scope Company database, both periods; return the files. | — | DAII-F-INV-001-OPERATOR-KIT-2026-10-13.md | C5 | PENDING |

## `INDEPENDENT_REVIEWER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| O2 | Review (once appointed) | Record a decision per finding and per track; for T1, the four questions of the packet. | — | DAII-INDEPENDENT-REVIEW-SCOPE-AND-READINESS-2026-10-13.md; t1-review-packet/ | all independent acceptances | NOT APPOINTED |

## `CAPACITY_APPROVER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| O3 | Capacity targets | Sign or replace the proposed assumptions and targets (agent assumptions today, not requirements). | CTO | test-program/CAPACITY-DECISION-BRIEF-FOR-CTO-2026-10-11.md | C8 | PENDING |

## `LOAD_TEST_AUTHORISER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| O4 | Load-test authorisation | Be named, and authorise load against the staging host only. | CTO | test-program/STAGING-CAPACITY-PROFILE-2026-10-11.md | C8 | PENDING |

## `INTEGRATIONS_MODULE_OWNER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| O5 | D-04 module ownership | Accept ownership, review the plan, answer the [REVIEW] items with the CTO. | AUTHORIZATION_OWNER | DAII-D04-AND-ENVIRONMENT-READINESS-2026-10-13.md §1 | C6 | UNASSIGNED |

## `SITE_OWNERS`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| O6 | LA-1 call sites | Each owner wires their site(s) per the tracker and adds the per-site spec. | CTO | DAII-LA1-REMAINING-SITES-TRACKER-2026-10-13.md | C7 | UNASSIGNED |

## `SECURITY_AND_DEPENDENCY_OWNER`

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| O7 | T2 plan and T3 acceptances | Own the T2 plan once authorised; sign the T3 acceptances; co-own the T1 host check (E3). | CTO | DAII-DEPENDENCY-T2-OUTLINE-2026-10-13.md | C9 | UNASSIGNED |

## Rules that apply to every item
No name, permission or answer is assumed. A decision pending does not stop unrelated work. No real-database repair or realignment, production change, or restricted operation is performed without the explicit authorisation named in the item. The same question is not asked twice: a role that has already answered is referenced by ID, not re-asked.
