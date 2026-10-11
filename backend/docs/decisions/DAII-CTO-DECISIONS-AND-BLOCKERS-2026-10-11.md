# DAII — CTO Decisions & Blockers Brief — 2026-10-11

**Status: PROPOSED planning artefact for CTO review. Not an approval, not an authorisation, not a release decision.** Release status: **NOT APPROVED**.
Part C of the planning package. Companions: `DAII-MASTER-EXECUTION-PLAN-2026-10-11.md` (A) and `DAII-WORK-PACKAGE-DEPENDENCY-REGISTER-2026-10-11.md` (B). This brief **consolidates** the roadmap's existing decisions `DEC-01…DEC-24` (`DAII-MASTER-DEVELOPMENT-ROADMAP-2026-10-11.md`, `50b3fc1`, §9); **no new decision IDs are created** and no decision is renumbered. Where work needs a fact rather than a decision, it appears in §3 as a technical investigation tied to a work package, not as a decision.

**Team 3 does not decide.** In particular it does not invent business policy, statutory payroll rules, accounting treatment or financial behaviour. Where an option is listed it is documented in an existing record (cited); where none is documented, the brief says "none documented". Options listed are not recommendations unless marked as another party's recommendation.

## 0. Evidence updates since the roadmap that affect decisions

| # | New evidence | Effect on decisions |
|---|---|---|
| EV-1 | The verification track committed clean-snapshot evidence for `b591d1f` (`1dea0db`, `a33f769`): business suite T-00…T-22, T-20 H3 flipped to PASS in plain and transaction style, 16/16 reservation-path isolation specs, unit 59/430, guard 50/50, headers pinned (`dirtyPaths: []`). T-21 case H and T-22 rollback case remain FAIL-DEFECT (PA-33, by design of the probes) | DEC-08: the independent reviewer now has the evidence to review (no longer waiting for evidence, only for a named reviewer). DEC-01: PA-33 is now confirmed on a clean snapshot, not only on a working tree |
| EV-2 | The verification status record (`VERIFICATION-DIRECTIVE-STATUS-2026-10-11.md`) is committed | DEC-09: the guard groups (6 helper specs, 3 role-creating specs) are stated in a committed record; the audit-document update (WP-DOC-02) is unblocked |
| EV-3 | No committed product-source change after `b591d1f` | Audit cutoff and findings remain valid |
| EV-4 | PA-33 fix committed as `c764fc5` (verification session `cece860d`, 13:27); the CTO confirmed the 04:46Z authorization narrowly (applies only if the actual diff conforms); Team 3 scope review finds it conforms (`DAII-PA33-DIFF-SCOPE-REVIEW-2026-10-11.md` (Team 3, uncommitted)); working-tree-tested only, not clean-snapshot verified, not independently accepted; existing chains untouched | DEC-01 confirmed narrowly (no longer an open question for this exact diff); DEC-02 stays open and independent |
| EV-5 | Two peer-session N-02 reviews are committed (`N-02-FULFIL-RESERVATION-INDEPENDENT-REVIEW-2026-10-11.md` (commit `c804845`) and `N-02-F-AUD-003-AND-REMAINING-INDEPENDENT-REVIEW-2026-10-11.md` (commits `89a0a2a`, `5104e1e`, `66c63b9`)); the CTO ruled the disclosed conflict means they do not satisfy the independence gate; remaining N-02 findings H1, H2, H4 implemented in `5c5b791` (authorised, working-tree PASS, clean snapshot and review pending); H5 BLOCKED | DEC-08: remainder authorisation confirmed by the CTO; reviewer for the fulfil fix still to be named (not the patch author, not the author of `runInTransaction`) |
| EV-6 | Lint FAIL (3 errors) at `a33f769`/`5c5b791` in LA-1 files from `60b9bdf`; fix authorised within LA-1 scope (WP-LA1-03); not attributed to N-02 | none (no decision needed) |
| EV-7 | Commits `a798d9d` and `60b9bdf` were created by the Team 3 session at the user's instruction (provenance disclosure, plan EV-8) | Input to the independence assessment in DEC-08 |
| EV-8 | Clean-snapshot pipeline of the tree `71e5f5e` published (`f881e53`, `520f2e0`): business T-00…T-24 exit 0, 89 executed-PASS + 1 skipped + 1 known BLOCKED failure of 91 isolation specs, unit 59/430, guard 50/50 | Evidence received for the PA-33 and N-02 code; reviewer still to be named (DEC-08); DEC-01b (guard) and DEC-02 open |
| EV-9 | CTO decisions of 2026-10-11 (nine items) recorded in the plan EV-10; reviewer independence rule added to DEC-08; sequence-lag guard proposal prepared | DEC-01b, DEC-08 |

## 1. Classification and index

**Type legend.** **C** = CTO decision. **B** = business-owner decision (accounting, statutory, product, treasury, HR owners; the CTO may be a co-signatory). **C+B** = joint. Technical investigations that feed decisions are in §3.

| ID | Type | Accountable owner | Blocks (packages) | Priority to answer |
|---|---|---|---|---|
| DEC-01 | C | CTO | WP-AUD-03, 04; (via AUD) WP-INV-08, PAY-05 rollback case, ACC-06, REL-01 restore drill | 1 |
| DEC-02 | C+B | CTO + security/audit owner | WP-AUD-05, AUD-07 | 2 |
| DEC-03 | B (+C) | Finance/accounting owner, CTO co-sign | WP-PAY-02…08, P0H-04, HR-05, HR-07 | 1 |
| DEC-04 | B | Finance/accounting owner | WP-PAY-02, COM-01, P0H-04, P0H-08 | 1 |
| DEC-05 | B | Business/legal owner (jurisdiction) | WP-P0H-01/02, HR-05, Phase 1 HR exit | 2 |
| DEC-06 | C | CTO | WP-ACC-05, P0H-05, HR-03 fixtures | 2 |
| DEC-07 | C | CTO | WP-N01-01, N01-02 | 3 |
| DEC-08 | C | CTO | WP-INV-02, INV-04, INV-05, INV-06 | 2 |
| DEC-09 | C | CTO / guard owner | WP-SEC-05, VER-02, ENB-02 | 3 |
| DEC-10 | C | CTO (names operator) | WP-FIV-01…03 | 3 |
| DEC-11 | C | CTO | WP-REL-01 | 4 (Phase 2) |
| DEC-12 | C | CTO | WP-P2-07 | 4 |
| DEC-13 | C | CTO | WP-ACC-06 | 3 |
| DEC-14 | C+B | CTO + Finance | WP-ACC-09 | 3 |
| DEC-15 | B | Finance/accounting owner | WP-ACC-09 | 3 |
| DEC-16 | C+B | CTO + Finance | WP-ACC-03 | 3 |
| DEC-17 | B | Finance/accounting owner | WP-ACC-07 | 3 |
| DEC-18 | B | Product/business owner | WP-P0H-07, P0M-*, ACC-08, P2-02/04/07 | 3 |
| DEC-19 | C | CTO + site owners | WP-LA1-01 | 3 |
| DEC-20 | C | CTO | WP-SEC-03, SEC-04 | 2 |
| DEC-21 | C | CTO | any numeric quality score (not a package) | 4 |
| DEC-22 | C+B | CTO + Manufacturing owner | WP-P0M-01…06 | 3 |
| DEC-23 | C+B | CTO + HR owner | WP-SEC-02 (final), P0H-03, P0H-09 | 3 |
| DEC-24 | C+B | CTO + Treasury owner | WP-P0H-06, HR-07 | 3 |
| DEC-25 | C+B | CTO + security/audit owner | WP-AUD-09 | 3 |

Priority 1 = unblocks a P0 stream; 2 = unblocks Phase 1 critical items or a security gate; 3 = needed during Phase 1 design or review; 4 = Phase 2 or governance.

## 2. Decision records

Format: **Question** · **Owner/type** · **Affected packages** · **Documented options** (with source) · **Consequence of deferral** · **Evidence required before deciding** (and who can supply it).

### DEC-01 — Authorise the audit-chain fix (core component)
- **Question.** May the audit write path (`foundation/audit/audit.service.ts`) be changed so that the sequence value hashed equals the sequence value stored, with no change to the hash format and no rewrite of existing rows?
- **Status.** **Confirmed narrowly by the CTO**: the authorization of 2026-10-11T04:46Z applies to the described `audit.service.ts` change only if the actual diff conforms. Team 3's conformity review (`DAII-PA33-DIFF-SCOPE-REVIEW-2026-10-11.md` (Team 3, uncommitted)) finds that the committed diff (`c764fc5`) conforms to every stated condition; the change is working-tree-tested only, not clean-snapshot verified and not independently accepted; closure gates remain (WP-AUD-06/07). This confirmation covers nothing beyond that exact change.
- **Open sub-question (DEC-01b, no new ID).** Whether to add a sequence-lag guard and which option (A self-healing, B fail closed, C check outside the write path, D accept); proposal `DAII-F-AUD-003-SEQUENCE-LAG-GUARD-PROPOSAL-2026-10-11.md`; **no implementation** until decided.
- **Owner/type.** CTO (C). **Affects.** WP-AUD-03, AUD-04, AUD-06, AUD-07, AUD-08; indirectly INV-08, PAY-05, ACC-06, REL-01.
- **Authorization provenance (found by Team 3, not decided by it).** A CTO directive delivered in session `cece860d` on 2026-10-11T04:46Z ("N-02, F-AUD-003, and Independent Closure Review", item 2, "F-AUD-003 — authorized, narrowly scoped remediation") authorises local remediation of F-AUD-003 with the constraints listed in the plan EV-4. It is not recorded in the repository, and the later planning directive to Team 3 says the uncommitted change is not authorized merely because it appeared in another working tree. **Resolved by the CTO:** confirmed narrowly (see Status above); the change was committed as `c764fc5` before the conformity condition was applied, which is recorded here and is not a Team 3 decision.
- **Documented options.** (a) Authorise as proposed in the N-02 report §6: draw the next serial value under the existing chain lock, hash it, insert with it; verification already tolerates gaps. (b) Decline: accept that rollbacks after audit writes break verification and document the operational consequence. (c) A different design (for example, stop hashing `seq`): documented only as an alternative Team 3 notes would change the hash input and invalidate verification of existing history; not proposed.
- **Consequence of deferral.** Any rollback-heavy verification (T-21 case H, payroll disbursement rollback, restore drills) stays unable to demonstrate chain validity; every new Company can acquire a broken chain through ordinary failures; closing-snapshot and support-audit claims remain unverifiable after such a failure.
- **Evidence required.** Already available: reproducer T-22 FAIL-DEFECT on a clean snapshot of `b591d1f` and on a working tree; root-cause reading (`MAX(seq)+1` hashed, serial stored). Needed: WP-AUD-01 confirmation note (Team 3, read-only); WP-AUD-02 inventory of existing breaks (informs DEC-02).

### DEC-02 — Handling of already-broken audit chains
- **Question.** For Companies whose chain already fails verification, do we accept and annotate the break, or authorise a repair procedure (with backup, reviewer and evidence)?
- **Owner/type.** CTO with the security/audit owner (C+B). **Affects.** WP-AUD-05, AUD-07.
- **Documented options.** (a) Accept and annotate: record the first broken sequence and cause, keep rows untouched. (b) Authorised repair procedure: only with a verified backup and independent review; **no in-place rewrite without separate approval** (roadmap P0A-5). No further options are documented.
- **Consequence of deferral.** The fix can ship but existing Companies keep an unverifiable chain with no recorded policy; restore verification for them stays ambiguous.
- **Evidence required.** WP-AUD-02 inventory (how many Companies, where the first break is, whether breaks are all rollback-caused). Supplied by: verification track on non-production databases with authorised read-only access.
- **Related, separate finding PA-43 / DEC-25.** The active UUID-repair core lists `audit_records.actorUserId` and `organizationId` among the references it rewrites; these are audit-hash inputs (code reading only; need unknown). It is tracked separately and is not part of this decision.

### DEC-03 — Accounting shape of payroll
- **Question.** What exactly is posted for a payroll run and its disbursement: posting amount (gross; gross plus commission; later tax and insurance split), accounts, treatment of partial or failed disbursement, cost-centre allocation, and what the reconciliation and closing audit must check?
- **Owner/type.** Finance/accounting owner, with CTO co-signature (B). **Affects.** WP-PAY-02…08, P0H-04, HR-05, HR-07, P1-01.
- **Documented options.** Documented intent only, not options: ADR-070 posting `Dr Salaries & Wages / Cr Wages Payable` and disbursement `Dr Wages Payable / Cr Treasury Account`; ADR-072 describes the posting as "gross pay + resolved commission". The code differs from both (PA-34, PA-35, confirmed by reading). Whether the documented intent is the approved policy is the question. No tax/insurance accounts are specified (ADR-067 §E ratified only the boundary).
- **Consequence of deferral.** Payroll stays unfit for go-live; Phase 1 HR cannot be implemented without speculation; the fix would otherwise encode a guess about accounting.
- **Evidence required.** WP-PAY-01 runtime validation (confirms or refutes PA-34/35/36); the accounting owner's written treatment. Team 3 cannot supply the policy.

### DEC-04 — Commission expense account and recognition timing
- **Question.** Which account carries commission expense and when is it recognised (at payroll posting, at payment, or earlier on approval), and what is the reversal rule when the underlying invoice is voided or returned?
- **Owner/type.** Finance/accounting owner (B). **Affects.** WP-PAY-02, COM-01, P0H-04, P0H-08, HR-07.
- **Documented options.** None documented. ADR-071/072 say Commission never posts on its own and is consumed by payroll; account and timing are not specified.
- **Consequence of deferral.** Commission cost stays absent from the ledger (PA-35); reversal behaviour (PA-38) stays manual.
- **Evidence required.** The ADR-071 reading of the adjustment/cut-off intent (technical investigation under WP-COM-01) plus the owner's policy.

### DEC-05 — Statutory payroll rules
- **Question.** Which jurisdiction(s) and which rules apply to overtime, income tax, social insurance, other deductions and end-of-service; what are the rate tables, effective dates and cut-offs; who signs them off?
- **Owner/type.** Business/legal owner (B). **Affects.** WP-P0H-01, P0H-02, HR-05, Phase 1 HR exit.
- **Documented options.** None. ADR-067 §D/§E ratified that these are not computed in Phase 1 and left them "genuinely unresolved, not simulated".
- **Consequence of deferral.** Payroll remains a gross-pay model (PA-16); Phase 1 HR exit cannot be reached.
- **Evidence required.** Written rules and tables from the owner; Team 3 will not infer them.

### DEC-06 — Business-date rule
- **Question.** Is the system's business date UTC or Africa/Cairo, applied through one helper for attendance, commission, payroll periods and the sub-ledger?
- **Owner/type.** CTO (C). **Affects.** WP-ACC-05, P0H-05, HR-03 fixtures.
- **Documented options.** (a) UTC business-date helper, already used in the sub-ledger/reconciliation path (`3ef67f4`). (b) Cairo business date (the project record lists moving to Cairo as an open decision). No other option documented.
- **Consequence of deferral.** The timezone class (PA-14) stays open; events within three hours of Cairo midnight can fall on the wrong day silently.
- **Evidence required.** WP-HR-03 serial regression re-run result; fixtures at 23:30–03:30 Cairo.

### DEC-07 — Independent N-01 reviewer
- **Question.** Who reviews the evidence behind the recorded local-scope N-01 closure, and who is the sign-off authority?
- **Owner/type.** CTO (C). **Affects.** WP-N01-01, N01-02.
- **Documented options.** Criterion only: a reviewer who is neither the author of `23e5ec1`/`7097796` nor a producer of the evidence. The recorded closure was by the code's author; CTO sign-off was stated as pending.
- **Consequence of deferral.** N-01 stays "closed by the owner, sign-off pending"; Phase 1 gate evidence rule (reviewer ≠ author) cannot be shown for the foundation.
- **Evidence required.** None new: the `a6002fa` clean-snapshot bundle and the N-01 report §6A/§7 exist. Scope is not expanded to multi-instance, hosting or production.

### DEC-08 — N-02 remainder and reviewer of the fulfil fix
- **Question.** (1) Who is the independent reviewer of the fulfil-reservation fix (evidence now exists on `b591d1f`)? (2) Is remediation authorised for H1 (limit engine), H2 (`releaseReservedQuantity`), H4 (racing `ProcessEngine.start`) and H5 (shipment transitions), each separately?
- **Status.** Part (2) is **decided**: the CTO's directive authorises local investigation and scoped remediation of the remaining N-02 findings (H1, H2, H4 implemented in `5c5b791`, H5 still BLOCKED). Part (1) is **open**: the CTO ruled that the committed peer reviews do not satisfy the independence gate (the reviewer wrote the transaction rule the patch uses), so a reviewer who authored neither the patch nor the rule is to be named; Team 3 discloses that its own session created commits `a798d9d` and `60b9bdf` (plan EV-8) although it authored neither the patch nor `runInTransaction`.
- **Independence rule (CTO, 2026-10-11, item 3).** The reviewer must have no connection to the paths under review: did not write the fix, did not write the helper it uses (`runInTransaction`), and did not take part in committing the changes. Team 3 does not certify independent closure of these items. Other decided points: sibling probes and the H5 fixture are authorised without logic change (WP-INV-09, WP-INV-07); T-03/T-04 are re-run individually on a quiet cluster only after the cluster is released and the pipeline has ended.
- **Owner/type.** CTO (C). **Affects.** WP-INV-02, INV-04, INV-05, INV-06 (INV-07 is a fixture, not blocked).
- **Documented options.** Proposed next steps in the N-02 probes report: apply the shared transaction rule to the limit service and reservation methods (H1/H2); idempotent `start` with `ON CONFLICT DO NOTHING` (H4); build the H5 fixture or probe via the existing spec. Authorise or decline each finding independently.
- **Review criteria already stated by the CTO (session `cece860d`, 2026-10-11T04:46Z):** reviewer independent of the patch author (shared-cluster access or a separate session alone is not proof); exact fix commit and tested snapshot identified; code and evidence inspected for lock ordering, transaction ownership, re-read after locking, rollback, retries, duplicate movements, reservation consistency and deadlocks; findings, limitations and residual risks documented; explicit statement on the fulfillReservation criteria. Latest status: peer-session reviews are committed (`c804845`, `89a0a2a`, `5104e1e`, `66c63b9`); it calls itself evidence for the CTO's decision and not an acceptance, discloses an independence conflict (the reviewer wrote the `runInTransaction` rule the patch calls), concludes the patch is minimal and correct as written, and lists open items: quiet-cluster re-run of T-03/T-04, a decision on an inferred deadlock residual, and F-AUD-003 as separate. Whether it satisfies the CTO's independence tests is the CTO's decision (DEC-08).
- **Consequence of deferral.** N-02 cannot close; limit and release races remain; the Phase 1 gate (N-02 fulfil part independently reviewed, remainder closed or accepted) cannot be met.
- **Evidence required.** Reviewer's conclusion (needs the name); for H5 the fixture result (WP-INV-07).

### DEC-09 — Guard decisions for blocked real-Postgres specs
- **Question.** (1) Approve the test-helper adaptation for the 6 pinned-helper specs? (2) For the 3 role-creating specs, approve a role-name-pattern allowance, a separate bootstrap-owned CREATEROLE role, or keep them NOT RUN/BLOCKED? The guard is not changed by anything else.
- **Owner/type.** CTO / guard owner (C). **Affects.** WP-SEC-05, VER-02, ENB-02; PA-22 closure.
- **Documented options** (`NARROW-GUARD-DECISIONS-FOR-REMAINING-SPECS-2026-10-11.md`, committed in `a314e18`). *Helper group:* replace the refused `pg_terminate_backend` by the already-allowed `DROP DATABASE IF EXISTS … WITH (FORCE)` and extend the port assertion to the approved port with the namespace — no guard change (the note's own recommendation); or a narrowed allowance for `pg_terminate_backend` filtered by `datname` and `application_name` and excluding the caller. *Role group:* a role-name pattern entry limited to `^daii_test_biz_t[0-9]{2}_role_[a-z0-9]+$` after renaming the roles in the specs; or CREATEROLE only on a separate bootstrap-owned cluster role used by the administrative connection; or keep them NOT RUN. Product-named databases: run against pool mode with pre-created approved-name databases.
- **Consequence of deferral.** 8 specs stay BLOCKED (never executed against the intended cluster) and the 19-spec gap (80/1/19) never fully closes; hosted CI cannot include them.
- **Evidence required.** Independent line-level review of the six pending adaptation diffs (WP-VER-03) before further reliance on the adapted specs.

### DEC-10 — F-INV-001 usage investigation operator
- **Question.** Who is the authorised operator, with read-only access to every Company database, and in what window may queries Q1–Q4 (all history and the last 90 days) be run with the read-only collector?
- **Owner/type.** CTO (C). **Affects.** WP-FIV-01, FIV-02, FIV-03.
- **Documented options.** Operator guide and queries exist (`F-INV-001-OPERATOR-EXECUTION-GUIDE-2026-10-11.md`); no alternative documented. External usage cannot be inferred from internal searches.
- **Consequence of deferral.** The HTTP 410 change must stay undeployed; the stock-movement endpoint's compatibility remains unknown.
- **Evidence required.** Operator's returned evidence; the compatibility assessment.

### DEC-11 — Capacity targets and staging host
- **Question.** Approve or replace the proposed workload assumptions and targets; provide an authorised staging-like host, a separate load-generator machine and a named load-test authoriser.
- **Owner/type.** CTO (C). **Affects.** WP-REL-01; PA-24, PA-26.
- **Documented options.** The proposal in `CAPACITY-DECISION-BRIEF-FOR-CTO-2026-10-11.md` (assumptions are the agent's, not business requirements); the earlier decision D-03 keeps targets gated and T-16 as a local baseline only.
- **Consequence of deferral.** T-16 stays NOT CLASSIFIED; no capacity or hosting claim is possible.
- **Evidence required.** Signed targets; an authorised environment.

### DEC-12 — Integrations tenancy
- **Question.** Which option for the Integrations module: A (Company-scoped with a platform connector directory), B (platform-scoped, tables moved to the `core` tag), or C (declare unsupported in multi-Company mode)?
- **Owner/type.** CTO (C). **Affects.** WP-P2-07; PA-20.
- **Documented options.** A/B/C in `INTEGRATIONS-TENANCY-DECISION-RECORD-2026-10-11.md`; the engineering recommendation recorded there (non-binding) is A; implementation plan `D-04-…` exists.
- **Consequence of deferral.** The T-18 schema mismatch and the isolation gap stay; no new connector or e-invoicing adapter can be built on a sound tenancy.
- **Evidence required.** None new; acceptance criteria are in the record.

### DEC-13 — F03 lock-order cure
- **Question.** Implement Option A (restructure so every posting acquires `numbering_sequences` and the audit latest row in a fixed order), or accept the retry (Option B) and classification (Option C) landed in `9c746aa` as permanent with a monitored deadlock counter?
- **Owner/type.** CTO (C). **Affects.** WP-ACC-06.
- **Documented options.** Option A, B, C in `F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md`; B and C are implemented, A is deferred "as a separately-reviewed follow-up".
- **Consequence of deferral.** Deadlocks stay absorbed by retry; tail rejections under load remain possible.
- **Evidence required.** WP-ACC-06 re-verification of the retry on HEAD (after N-01's transaction-scope change).

### DEC-14 — Sales-order cancellation and reactivation policy
- **Question.** In which states may an order be cancelled; what happens to the deposit, reservation, fulfilment, shipment, invoice and commission; may a cancelled order be reactivated?
- **Owner/type.** CTO with Finance (C+B). **Affects.** WP-ACC-09 (and COM-01).
- **Documented options.** None documented (no cancel action exists; PA-01).
- **Consequence of deferral.** No sanctioned unwind path for released orders.
- **Evidence required.** The policy table by state; reservation paths closed (INV).

### DEC-15 — Supplier-return accounting
- **Question.** What are the GRNI, PPV, input-VAT and supplier-ledger effects of a return to vendor?
- **Owner/type.** Finance/accounting owner (B). **Affects.** WP-ACC-09.
- **Documented options.** None. ADR-052 (line ~95) notes a symmetric GRNI-reversal leg would be needed if Purchase Return is built; D5 lists supplier returns as a follow-up.
- **Consequence of deferral.** Procure-to-pay cannot handle rejected goods cleanly.
- **Evidence required.** The owner's treatment.

### DEC-16 — Year-end approach
- **Question.** Keep derived equity (unclosed net income computed from inception, as ADR-047 D3 designed) and document it as policy, or post closing entries into retained earnings with reopen safety?
- **Owner/type.** CTO with Finance (C+B). **Affects.** WP-ACC-03.
- **Documented options.** The two named; the `retained_earnings` control function is declared the "year-end roll-forward target — F13".
- **Consequence of deferral.** Year close stays a status lock; auditors' expected closing structure absent.
- **Evidence required.** WP-ACC-01 golden fixtures (to prove statements are unaffected whichever is chosen).

### DEC-17 — AP/AR adjustment accounts and VAT
- **Question.** Which account and VAT treatment apply to each AP/AR adjustment kind (credit note, debit note, write-off), replacing the literal default `5299`?
- **Owner/type.** Finance/accounting owner (B). **Affects.** WP-ACC-07.
- **Documented options.** None; D5 records the `5299` path as "not an approved accounting policy".
- **Consequence of deferral.** Adjustments land in a catch-all account; no VAT reversal.
- **Evidence required.** The owner's mapping.

### DEC-18 — Requirement confirmations
- **Question.** For each of: customer quotation, lot/serial/expiry, FIFO/standard costing, FX revaluation, e-invoicing (jurisdiction), HR contracts/documents — confirmed with scope, or withdrawn?
- **Owner/type.** Product/business owner (B). **Affects.** WP-P0H-07, P0M-*, ACC-08, P2-02, P2-04, P2-07.
- **Documented options.** Charter Wave 2/5 lists some capabilities (HR contracts/documents; multi-currency; consolidation; MRP); none is confirmed as a client requirement.
- **Consequence of deferral.** Phase 0 contracts for these remain provisional; Phase 2 ordering cannot be fixed.
- **Evidence required.** A one-page scope per item signed by the requirement owner.

### DEC-19 — LA-1 remaining sites
- **Question.** Who wires each of the seven remaining Layer 2 sites, with what timeline, using the existing admission pattern?
- **Owner/type.** CTO with site owners (C). **Affects.** WP-LA1-01; PA-41.
- **Documented options.** The pattern: obtain the Company DataSource through `runOperationalAdmitted(platformDataSource, connections, companyId, work)` and treat `admitted: false` as skip (LA-1 record §4).
- **Consequence of deferral.** A suspended or not-READY Company can still be modified by seven background/provisioning paths.
- **Evidence required.** Per-site real-Postgres spec; WP-LA1-02 clean-snapshot evidence for the committed part.

### DEC-20 — Dependency change scope
- **Question.** Approve a specific, per-package change scope (versions, tests, rollback), starting with the non-breaking tier?
- **Owner/type.** CTO (C). **Affects.** WP-SEC-03, SEC-04.
- **Documented options.** Tiers T1 (non-breaking), T2 (majors with code impact), T3 (accept with owner) in `DEPENDENCY-AUDIT-D01-2026-10-11.md`; WP-SEC-01 adds the per-package reachability triage.
- **Consequence of deferral.** 65 advisories (15 runtime-reachable packages) stay open; no release gate on security.
- **Evidence required.** WP-SEC-01 triage; for majors, the test net (WP-ENB-01/02).

### DEC-21 — Quality-score rating method
- **Question.** Approve dimension weights, coverage rules and a named approver for any numeric quality score?
- **Owner/type.** CTO (C). **Affects.** no package; gates any numeric score.
- **Documented options.** The proposed method in the quality scorecard §7 (not reviewed, not approved).
- **Consequence of deferral.** Only the categorical maturity table is valid; the 9.5/10 ambition remains a target with no measurement.
- **Evidence required.** None.

### DEC-22 — Manufacturing contract decisions
- **Question.** Decisions on the six Manufacturing contract questions: planning/MRP boundary, costing, scrap/rework/by-products, lot/serial interface, capacity scheduling, open policy items.
- **Owner/type.** CTO with the Manufacturing owner (C+B). **Affects.** WP-P0M-01…06.
- **Documented options.** ADR-060/061 and the Manufacturing study; charter lists MRP in Wave 5.
- **Consequence of deferral.** Phase 0 for Manufacturing cannot exit.
- **Evidence required.** Contract drafts (planning work; Team 3 can prepare them).

### DEC-23 — Salary-data visibility
- **Question.** Who may see salary data per company, department and role under the existing authorization model?
- **Owner/type.** CTO with the HR owner (C+B). **Affects.** WP-SEC-02 (final), P0H-03, P0H-09.
- **Documented options.** None documented; permission nodes `payroll.*` exist, field-level scope is unverified.
- **Consequence of deferral.** Payroll/payslip access scope cannot be specified or tested.
- **Evidence required.** WP-SEC-02 review record.

### DEC-24 — Payment instrument and batch approach
- **Question.** How are employees paid (bank transfer file and format, cash, wallet), and how are rejections and re-issues handled?
- **Owner/type.** CTO with the Treasury owner (C+B). **Affects.** WP-P0H-06, HR-07.
- **Documented options.** None documented; no employee payment details exist in the model.
- **Consequence of deferral.** Disbursement stays a per-line cash-out with no instrument.
- **Evidence required.** The owner's process description.

### DEC-25 — Policy for UUID repair versus the audit hash chain (added after roadmap `50b3fc1`; DEC-01…DEC-24 unchanged)
- **Question.** If UUID repair is ever needed on a Company database, how may it treat `audit_records.actorUserId` and `organizationId` (hash inputs) without invalidating the historical chain: exclude them from the rewrite, rewrite and re-anchor under a separately approved procedure, or forbid the repair on Companies with audit rows referencing non-compliant ids?
- **Owner/type.** CTO with the security/audit owner (C+B). **Affects.** WP-AUD-09; PA-43. Independent of DEC-02 (already-broken chains) and of PA-33.
- **Documented options.** None documented. The repair core states it deliberately does not rewrite ids inside the JSON columns of audit records; it does rewrite the two scalar columns.
- **Consequence of deferral.** The repair must not be run on any database with audit rows referencing non-compliant ids; the risk stays unquantified.
- **Evidence required.** WP-AUD-09: complete path trace and independent review; read-only need check per Company under authorised access. **No decision is taken here and nothing is run.**

## 3. Technical investigations (not decisions) that feed the decisions

| Investigation | Package | Feeds | Can start now? |
|---|---|---|---|
| Confirm the audit-chain root cause note | WP-AUD-01 | DEC-01 | Yes (read-only) |
| Inventory of existing audit-chain breaks in non-production Companies | WP-AUD-02 | DEC-02 | Needs authorised read-only access and a window |
| Runtime validation of PA-34/35/36 in a disposable Company | WP-PAY-01 | DEC-03, DEC-04 | Needs a cluster window; no product change |
| HTTP-level reach test for the fulfilment race | WP-INV-03 | DEC-08 | Needs fixture design |
| H5 shipment-transition fixture | WP-INV-07 | DEC-08 | Needs fixture design |
| ADR-071 reading of the commission adjustment/cut-off intent | WP-COM-01 | DEC-04 | Yes (read-only) |
| Dependency reachability triage | WP-SEC-01 | DEC-20 | Yes (read-only) |
| Hand review of four controllers | WP-SEC-02 | DEC-23 | Yes (read-only) |
| Line-by-line review of six pending adaptation diffs | WP-VER-03 | DEC-09 | Yes (read-only; independent reviewer) |
| Commission regression serial re-run | WP-HR-03 | DEC-06 | Needs a cluster window |
| F03 retry re-verification on HEAD | WP-ACC-06 | DEC-13 | Needs a cluster window |

## 4. Blocker view by package group

| Group | Blocking decisions | Unblocking evidence or authorisation |
|---|---|---|
| Audit chain (AUD) | DEC-01, DEC-02 | CTO authorisation; AUD-02 inventory |
| Payroll/GL/Treasury (PAY, COM, HR-05/07, P0H-04) | DEC-03, DEC-04, DEC-05, DEC-24 | Accounting and statutory policy; PAY-01 result |
| Reservation/inventory (INV) | DEC-08 | Reviewer named; per-finding authorisation |
| N-01 | DEC-07 | Reviewer named |
| F-INV-001 | DEC-10 | Operator and read-only access |
| Security/dependencies/guards (SEC) | DEC-09, DEC-20 | Helper/CREATEROLE decisions; approved change scope |
| Company lifecycle (LA1) | DEC-19 | Owners and timeline |
| Accounting enablers (ACC-03/05/06/07/08/09) | DEC-06, DEC-13, DEC-14, DEC-15, DEC-16, DEC-17 | Policies; AUD/INV closure for shared paths |
| Phase 0 (P0H, P0M) | DEC-05, DEC-18, DEC-22, DEC-23 | Owner inputs |
| Phase 2 | DEC-11, DEC-12, DEC-18 | Host, tenancy option, requirement scopes |

## 5. Summary counts (from the §1 "Type" column plus DEC-25)

25 decisions: **12 CTO decisions** (DEC-01, 06, 07, 08, 09, 10, 11, 12, 13, 19, 20, 21); **6 business-owner decisions** (DEC-03 with CTO co-signature, 04, 05, 15, 17, 18); **7 joint CTO + business-owner decisions** (DEC-02, 14, 16, 22, 23, 24, 25). DEC-25 was added after the roadmap; DEC-01…DEC-24 keep their roadmap IDs and none is merged or renumbered.
