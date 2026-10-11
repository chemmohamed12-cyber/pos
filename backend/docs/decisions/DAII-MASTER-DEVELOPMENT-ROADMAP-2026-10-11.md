# DAII — Master Development Roadmap (PROPOSED) — 2026-10-11

Prepared by Team 3 in response to the CTO directive "Audit Deliverables, Critical Findings & Master Development Roadmap". **Status: PROPOSED for CTO approval. This document authorises no implementation, no schema/UI/permission/configuration change, no production or hosting access and no destructive operation.** Release status is **NOT APPROVED**; nothing here approves a release. The 9.5/10 ambition is a target, not a statement of current quality, and no overall numeric score is issued (the rating method is proposed, not approved — scorecard §7).

| Baseline | Value |
|---|---|
| Evidence base | The six audit documents committed in `2c6ccf3` (documentation only): report, matrix (88 rows), register (`PA-01…PA-42`), roadmap input, scorecard, HR & Accounting integration assessment |
| Audit cutoff | `b591d1f` (2026-10-11) |
| Evidence baseline | `a6002fa` — the last complete clean-snapshot verification. **The current working tree is not claimed fully verified:** the N-02 `fulfillReservation` fix (`a798d9d`, `b591d1f`) and LA-1 Layer 2 (`60b9bdf`) were made after it and still require clean-snapshot verification (PA-42) |

## 0. How to read this roadmap

- **Evidence integrity.** Every work package states what is *confirmed by executable test*, *confirmed only by code reading*, *suspected*, or *unverified/blocked*, using the register's "nature" labels. A code-reading finding is not presented as a confirmed runtime defect until its package's first step (a runtime demonstration) has been run. Skipped, blocked or unexecuted tests are never counted as passing.
- **Authority.** "Needs authorisation" means a decision only the CTO or a named business owner can take. "Needs window" means a coordination step: the guarded cluster is shared and serialised, so any database-backed step requires a non-conflicting window agreed with the verification track. Team 3 itself stays read-only: execution packages name an implementing track and an independent reviewer who is **not** the author of the change.
- **Protected items.** `company-audit-access.real-pg.spec.ts`, the LA-1 files, protected baselines, guard policy and the F-INV-001 410 decision are not modified by any package here.

## 1. Executive priorities and business rationale

| Priority | Theme | Why it comes first | Findings |
|---|---|---|---|
| **P0-A** | Audit-chain integrity | The tamper-evidence control becomes unverifiable after any ordinary failure inside an outer transaction; it underlies closing snapshots, support-access audit, restore verification and any external audit claim. Every later remediation (P0-B, P0-C) triggers rollbacks that would expose it. | PA-33 (confirmed by test, working-tree class) |
| **P0-B** | Payroll ↔ GL ↔ Treasury integrity | Books would be wrong from the first disbursed payroll: liability never cleared, bank GL overstated, commission cost missing, cent drift. HR is a Phase 1 target, so this must be proven or refuted before Phase 1 builds on it. | PA-34, 35, 36 (confirmed by reading; runtime unproven) |
| **P0-C** | Inventory/reservation integrity | Silent stock and valuation corruption if a race is reachable; the fix exists but is only verified by the implementing track and lacks a clean-snapshot pipeline. | PA-04, 05, 42 |
| **P0-D** | Independent closure of N-01 | The local-scope closure was recorded by the code's author; the gate needs a reviewer who is not the author. No scope expansion. | PA-21 |
| **SEC** | Security, authorization, guards, dependencies | Release gates; dependency majors need the test net the audit found thin. | PA-25, 29, 41, 22 |
| **PH0** | HR and Manufacturing contracts (planning only) | The decisions that unblock HR statutory payroll and the accounting shape are policy, not code, and are on the critical path. | PA-16, 37, 38, 40, PA-31 |
| **PH1** | HR and Accounting completion and verification | Charter Waves 2–3 and the financial-control core, each end to end, with internal acceptance. | PA-01, 03, 08, 09, 10, 11, 14, 16, 17, 32, 37–40 |
| **PH2** | Remaining ERP roadmap and release readiness | After the Phase 1 gate, with all security/integrity/independent-verification gates retained. | PA-02, 06, 07, 12, 15, 18, 19, 20, 24, 26, 30, 31 |

No full rewrite is recommended: the evidence shows additive, localised remediation on a sound spine (event path, approvals, process engine, audit chain, Company routing); the coupling debt (PA-28) hinders extraction, not addition.

## 2. Findings → work packages (every finding is mapped)

| Finding | Package(s) | Finding | Package(s) |
|---|---|---|---|
| PA-33 | P0A-1…P0A-7 | PA-22 | SEC-3, ENB-2 |
| PA-34, 35, 36 | P0B-1…P0B-8, ACC-2 | PA-23 | ENB-1 |
| PA-04, 05, 42 | P0C-1…P0C-5 | PA-24, 26, 30 | REL-1 (Phase 2, first) |
| PA-21 | P0D-1…P0D-3 | PA-18 | PH2-3 |
| PA-25 | SEC-1 | PA-20, 15 | PH2-7 (decision DEC-12 first) |
| PA-29 | SEC-2 | PA-27 | DOC-1 |
| PA-41 | SEC-4 | PA-28 | opportunistic (ARCH-1) |
| PA-13 | ACC-6 | PA-02 | PH2-2 |
| PA-14 | ACC-5, PH1-HR-2 | PA-06, 07 | PH2-4 |
| PA-16, 37, 40 | PH0-HR, PH1-HR-4, HR-5 | PA-12 | PH2-6 |
| PA-17 | PH1-HR-3 | PA-19, 31 | PH2-8/9 |
| PA-38 | PH1-HR-6 | PA-10 | ACC-3 |
| PA-39 | ACC-7 | PA-11 | ACC-8 |
| PA-32 | ACC-1 | PA-09 | ACC-4, PH1-HR-7 |
| PA-01, 08 | ACC-9 | PA-03 | ACC-10 |

## 3. P0 work packages (ordered)

Each P0 package lists: scope, explicit exclusions, steps, acceptance criteria, required regression tests, closure evidence, blockers, proposed owner/reviewer. "Prepared" below means the plan is ready; execution of any code change awaits the stated authorisation.

### P0-A — Audit-chain rollback defect (PA-33)

**Current knowledge.** *Confirmed by test (working-tree class):* reproducer `f-aud-rollback-reproducer.biz.real-pg.spec.ts` (step T-22, run `T-22-20261011T041117Z-4c03de`, header commit `ce924e2` + 12 uncommitted paths): control passes (seqs 1, 2); after one rolled-back audit write the next committed record is stored as seq 4 and was hashed as seq 3; chain invalid. *Read by Team 3 (`audit.service.ts` lines ~57–110):* `record` takes the advisory lock, reads the head hash, computes `seq = MAX(seq)+1`, hashes with that value, and inserts through the repository; the stored `seq` comes from the table's serial. A rolled-back insert burns a serial value, so hashed `seq` ≠ stored `seq` from the next record on; `verifyChainOn` recomputes the hash with the stored `seq` and reports the break. *Not yet shown:* production-flow reach (which real failure paths roll back after an audit write); behaviour for Companies that already have a burnt-sequence gap.

**Scope.** `foundation/audit` write path and its tests. **Exclusions.** No rewriting, deleting or re-hashing of existing audit rows; no change to the hash input format; no change to verification semantics beyond what the closure criteria state; protected baselines and `company-audit-access.real-pg.spec.ts` untouched.

| Step | Content | Gate |
|---|---|---|
| P0A-1 | **Reproduce** on a clean snapshot of the then-current HEAD (not the working tree): run T-22 and record result, plus a second scenario of a rolled-back business transaction that includes a real audit write (e.g. T-21 case D) | needs window; read-only product |
| P0A-2 | **Root cause note** (design record): confirm in the entity/TypeORM insert path whether the explicit `seq` supplied by `record` is ignored in favour of the serial, and confirm no other writer bypasses the advisory lock | documentation |
| P0A-3 | **Minimal safe remediation (proposed, awaiting authorisation DEC-01):** under the existing chain lock, draw the next serial value with `nextval(pg_get_serial_sequence('audit_records','seq'))`, hash with that value and insert with it explicitly (raw statement or an insert that honours the supplied key), so hashed and stored `seq` are always equal; verification already tolerates gaps because it hashes the stored `seq`. Alternative considered: stop hashing `seq`, rejected because it changes the hash format and invalidates verification of all existing history | needs DEC-01 |
| P0A-4 | **Regression coverage:** T-22 flipped to assertions; rollback after audit write inside a plain-manager caller and inside `manager.transaction`; savepoint/nested rollback; failed business transaction after audit; concurrent writers while some roll back; chain validity after each; the existing T-03/T-13/T-14 and audit-chain-concurrency specs unchanged and still PASS | needs DEC-01 |
| P0A-5 | **Existing history:** inventory every Company's chain with the read-only verifier to find real gaps; define handling (DEC-02): *accept and annotate*, or *authorised repair procedure* — never an in-place rewrite without separate approval and a backup | needs DEC-02 |
| P0A-6 | **Clean-snapshot verification** of the fix commit: CI script, T-00…T-22, audit specs, unit and guard | needs window |
| P0A-7 | **Independent review** by a reviewer who is not the author of the change; conclusion recorded in the package report | named reviewer |

**Acceptance criteria.** (1) For every rollback scenario above, `verifyCompanyChain` returns valid; (2) stored `seq` equals hashed `seq` for 100 % of records written in the tests; (3) concurrent writers with interleaved rollbacks produce a single valid chain; (4) no change to hashes of existing records; (5) T-22 and all existing audit specs PASS on a clean snapshot of the fix commit; (6) existing-history policy recorded. **Closure evidence.** Pinned evidence bundle (`SOURCE_COMMIT.txt`, headers with `dirtyPaths: []`), reviewer's written conclusion, DEC-01/DEC-02 records. **Blocks:** restore-drill evidence (PA-30), reliable clean-snapshot results for any rollback-heavy test, Phase 1 audit claims. **Owner:** Foundation/Audit; reviewer: Verification track member who did not write the fix.

### P0-B — Payroll, Accounting and Treasury integrity (PA-34, PA-35, PA-36)

**Current knowledge.** *Confirmed by code reading, runtime unproven:* (a) `PayrollService.disburse` calls `cashOutForEmployee` per line; that treasury method is `NO_EMIT`; `disburse` publishes no event; no handler posts `Dr Wages Payable / Cr Bank` (PA-34). (b) `payroll.run.posted` carries `totalGross` = sum of `grossPay` only, while `netPay` (which includes commission) is what is disbursed; ADR-072 describes posting as gross plus commission (PA-35). (c) payroll sums money with JavaScript `Number` and `toFixed(2)` (PA-36). *Known test gap:* the integrated spec (BLOCKED) asserts line amounts and journal balance/line count, not journal amount, and ends at `disbursedAt`. **No statement above is presented as a confirmed runtime defect until P0B-1 runs.**

**Scope.** Payroll run → financial event → journal → disbursement → treasury → reconciliation. **Exclusions.** No statutory rules invented (overtime, tax, insurance remain Phase 0/1 decisions); no accounting policy invented; no change to approval flow, SoD or immutability-after-posting; no change to treasury balance logic verified under T-05/T-14/T-16.

| Step | Content | Gate |
|---|---|---|
| P0B-1 | **Validate in an authorised, disposable Company** (guarded cluster, disposable database, serialised window): run the existing payroll lifecycle fixture (one employee with 4,000 gross, 200 approved commission) through approve → post → disburse, then query read-only: journal lines of the payroll event, GL balance of Wages Payable and of the treasury-linked bank account, `treasury_transactions` for the run, and the cash/bank reconciliation result. Record expected-if-reading-correct: posting 4,000; no disbursement journal; Wages Payable still credited; bank GL unchanged; reconciliation difference. Outcome recorded as CONFIRMED-TESTED or REFUTED | needs window |
| P0B-2 | **Record decisions (DEC-03, DEC-04)** — no code before them: intended accounting treatment of gross pay, commission (expense account, recognition at posting or at payment), payroll liabilities (wages payable; later tax/insurance payable — jurisdiction-specific, not invented), the disbursement entry, treatment of partial/failed disbursement, cost-centre allocation. Owner: Finance/accounting policy owner + CTO | business owner |
| P0B-3 | **Design record** mapping each decision to events/handlers (publish a disbursement event from the payroll side or emit from treasury with a payroll counter-account; idempotency key = run id + line id; gap detector like `listReconciliationGaps`) | after DEC-03/04 |
| P0B-4 | **Implementation** of the minimal changes (posting amount, disbursement GL entry, decimal-safe arithmetic through the shared money helper) | needs DEC-03/04 + authorisation; blocked until then |
| P0B-5 | **Tests** (below) | with P0B-4 |
| P0B-6 | **Reconciliation proof:** payroll run lines = journal amounts = treasury cash paid; payroll added to the R1–R10 oracle (new check R11: for each posted run, Σ posted debit = Σ line cost, Σ Wages Payable credit − Σ Wages Payable debit = outstanding undisbursed net; no orphan cash-out) | with P0B-5 |
| P0B-7 | **Clean-snapshot verification** of the fix commit including the repaired and extended integrated spec | needs window |
| P0B-8 | **Independent review** (reviewer not the author) | named reviewer |

**Required tests.** Gross-only run; gross + commission run; multiple employees with cents; rounding mode cases; posting idempotency (replay of the event, duplicate dispatch); `disburse` retry after partial failure (some lines paid, then error) with no duplicate payment; concurrent `disburse` calls (advisory lock + fresh re-check); rollback of the disbursement transaction (treasury rows and ledger remain consistent; audit chain stays valid — depends on P0-A); GL account deactivated mid-flow (existing recovery case) now also with disbursement; reconciliation-gap endpoint; cash/bank reconciliation clean after a full cycle; Company A/B isolation. **Acceptance criteria.** All tests PASS on a clean snapshot; no duplicate posting or payment under retry/replay/concurrency; Σ lines = Σ journal = Σ cash for randomised cent amounts; Wages Payable returns to the outstanding-undisbursed amount; reconciliation clean. **Closure evidence.** P0B-1 result record, DEC-03/04 records, pinned evidence bundle, reviewer's conclusion. **Blocks:** HRX statutory work (PH1-HR-4/5), Accounting exit criteria, any payroll go-live. **Owner:** Payroll/Accounting; reviewer: Verification.

### P0-C — N-02 reservation and inventory integrity

**Current knowledge.** *Confirmed by test:* T-20 H3 on clean `a6002fa` (6 dispatches for a reservation of 3, on-hand −18); T-21 on unfixed code (8 of 8 succeeded). *Verified by the implementing track only (working-tree class):* after the fix, T-21 cases A–G pass; case H (audit chain after rollback) fails because of PA-33. *Unremediated and open:* H1 limit overshoot, H2 reservation over-release, H4 racing process-start errors, H5 shipment transitions (BLOCKED, no fixture). *Missing:* the clean-snapshot pipeline of the post-fix HEAD (`<<PIPELINE>>` in the N-02 report) and the independent evidence review.

| Step | Content | Gate |
|---|---|---|
| P0C-1 | Clean snapshot of the then-current HEAD; CI script; business suite T-00…T-22; isolation specs that touch inventory/delivery/fulfilment/returns; unit; guard | needs window |
| P0C-2 | Independent verification of the fix on that snapshot: concurrency (8-way and order-level), retries, partial failure, outer rollback, audit-chain after A–C, movements = fulfilled reservations = dispatch audit records, no negative stock, no duplicate fulfilment; plus an HTTP-level double delivery-confirmation test establishing reach | needs window; reviewer |
| P0C-3 | Reviewer's conclusion recorded in the N-02 report §7 (fulfil part only) | named reviewer |
| P0C-4 | H1/H2/H4/H5: stay OPEN. Prepare (not implement) the shared-rule application plan and the H5 shipment fixture; implement only after authorisation (DEC-08) | needs DEC-08 |
| P0C-5 | Case H follows P0-A; do not weaken the T-21 audit-chain assertion | depends on P0-A |

**Acceptance (fulfil part).** exactly one success and one dispatch movement per reservation under ≥ 8-way concurrency in plain and transaction style; retries refused with no side effect; rollback leaves reservation active and quantities restored; order-level atomicity; global consistency; no negative stock; audit chain valid (after P0-A). **Each remaining N-02 finding closes only when its own acceptance criteria pass** (H1: cap never exceeded; H2: releases ≤ reserved; H4: no database error under racing starts; H5: transition limits hold). **Owner:** Inventory/Foundation; reviewer: Verification.

### P0-D — N-01 independent closure review

The implementing track recorded "CLOSED for the local scope" (`b5dcece`). It is **not reopened** because an older report predates the fix. The package arranges an independent review and records the reviewer's conclusion; it does not widen the claim.

| Step | Content |
|---|---|
| P0D-1 | CTO names a reviewer who is neither the author of `23e5ec1`/`7097796` nor a producer of the evidence (DEC-07) |
| P0D-2 | Reviewer re-examines: the clean-snapshot bundle of `a6002fa` (headers, `SOURCE_COMMIT.txt`, `dirtyPaths`), the pre/post contrast, the 20/20 isolation list, T-17/T-19 results, CI run on the final tree, the N-01 report §7.1–7.3 |
| P0D-3 | Written conclusion appended to the N-01 report: agree / agree with caveats / disagree; the scope stays "local, single instance, tested call paths + by-construction for the rest". Multi-instance, hosting and production behaviour are explicitly excluded; if any is wanted it becomes a separate package (REL-1) |

**Acceptance.** Reviewer's conclusion recorded with reasons; no scope expansion. **Owner:** reviewer named by the CTO.

## 4. Security, authorization, guards, dependencies

| Package | Content | Acceptance / evidence | Gate |
|---|---|---|---|
| **SEC-1 Dependency triage and targeted remediation** | Triage the 65 backend advisories (3 critical, 44 high, 14 moderate, 4 low; 15 runtime-reachable packages) by severity **and** reachability; propose per-package change scope and regression tests; **no bulk upgrade, no lockfile or manifest change without an approved change scope (DEC-20)** | Triage table (below); each proposed change has a scope, a test list and a rollback; clean-snapshot CI after each approved change; re-audit shows runtime critical = 0 | Docs/analysis can proceed now; changes need DEC-20 |
| **SEC-2 Authorization residuals** | Hand review of the four controllers without Company/platform guard; salary-data visibility check; pending CTO items; no redesign of the approved model | Review record per controller; role × route tests for any gap | Hand review can proceed now (read-only) |
| **SEC-3 Guard review decisions** | Continue the approved guard review: apply decisions already taken; for the remaining groups (per the verification track's uncommitted status record: 3 specs needing CREATEROLE least-privilege assessment; 6 specs needing a decision on the `pg_terminate_backend` helper statement) obtain DEC-09; guards are not weakened and BLOCKED/NOT RUN are never counted as pass | Spec results recorded per commit; guard suite 50/50 unchanged | DEC-09 |
| **SEC-4 LA-1 Layer 2 remaining sites** | Seven unwired sites (closing-snapshot recovery, membership provisioning ×3, membership reconciliation, event dispatcher, plans ×2) wired by their owners with the same pattern; clean-snapshot evidence for `60b9bdf` | Real-Postgres spec per site; record updated; "a path opens a Company DataSource without admission" no longer true | Owners; DEC-19 |
| **SEC-5 F-INV-001** | The HTTP 410 behaviour change **stays unapproved for release** until the authorised usage investigation (Q1–Q4 across all Company databases, all history and last 90 days) and the compatibility assessment are complete | Operator's evidence returned and reviewed; release decision recorded | DEC-10 (named operator with read-only access) |

**Dependency triage (SEC-1) — runtime-reachable packages (from D-01, reachability INFERRED from source search; to be confirmed by the package):**

| Package | Severity | Reach | Proposed targeted action (not executed) | Regression tests to define |
|---|---|---|---|---|
| `proxy-addr` (via express) | critical | Only if `trust proxy` is configured; app does not set it; host proxy UNVERIFIED | T1 non-breaking update after host-proxy check | throttler/IP behaviour behind a proxy fixture |
| `tar` ← `@mapbox/node-pre-gyp` ← `bcrypt` | critical / high | Install-time only | Record T3 acceptance or plan `bcrypt` 5→6 (major) | login, lockout, hash compatibility |
| `@nestjs/platform-express`, `multer`, `body-parser` | high / high / low | Authenticated upload endpoints, request parsing | T2 planned upgrade | upload size/abort tests, JSON limit tests |
| `joi` | high | Start-up configuration validation only | T1 non-breaking | config schema tests |
| `@nestjs/common`, `@nestjs/core`, `@nestjs/config`, `@nestjs/typeorm` | moderate | Request pipeline / config | T1 for `common`; T2 for the rest | full CI + business suite |
| `qs` | moderate | Query parsing of every request | T1 non-breaking | query parsing fixtures |
| `uuid`, `exceljs` | moderate | Excel import/export; no caller-supplied buffer to uuid (INFERRED) | T2 planned | Excel import/export specs |
Dev-only packages (50) follow Jest 30 / Nest CLI 12 upgrades and are not release-critical; frontend `react-router-dom` 6→7 needs the frontend test net (ENB-1).

## 5. Phase 0 — HR and Manufacturing architecture/contracts planning ONLY

No code, schema, UI, configuration or permission changes occur in this phase. Outputs are decision records and ERP Integration Contracts (business documents, inventory effects, financial effects, control integration — ADR-053 §2) reviewed by the CTO.

| Package | Content | Findings | Blocked by |
|---|---|---|---|
| **PH0-HR** | Contracts H0-1…H0-9 of the roadmap input §4.1: statutory payroll scope and effective dating; holiday/working-day calendar and absence/leave/lateness pay rules; payslip; **payroll accounting shape (shared with P0B-2)**; business-date rule; disbursement/payment instruction; HR master (contracts, documents, leave types/balances, shifts, loans, end-of-service); commission reversal policy; salary-data visibility | PA-16, 34, 35, 37, 38, 40, 14 | DEC-03/04/05/06/23/24; jurisdiction owner |
| **PH0-MFG** | Contracts M0-1…M0-6: planning/MRP boundary, costing, scrap/rework/by-products, lot/serial interface, capacity scheduling, open policy items | PA-31, 06, 07 | DEC-18, DEC-22 |
| **PH0-GATE** | Phase 0 exit: every contract has CTO sign-off or a recorded deferral; open policy questions listed with owners; no implementation artefact exists for these contracts | — | CTO |

## 6. Phase 1 — HR and Accounting (complete, verify, internally accept)

Common rule: scenarios reach Implemented-and-Verified on a clean snapshot of a named commit, with HTTP-level scenario tests, the oracle extended (including payroll), browser E2E for the UI path, no open High finding in the domain, independent review of the gate evidence (reviewer ≠ author), CTO internal acceptance. **Internal acceptance is not release approval.**

### 6.1 Accounting
| WP | Content | Findings | Depends on | Size |
|---|---|---|---|---|
| ACC-1 | Golden-fixture suite for TB/BS/P&L/cash flow; oracle extended ("balance sheet balances", "cash-flow net equals treasury movement") | PA-32 | none | M |
| ACC-2 | Payroll-to-ledger correctness (= P0B-4…8) | PA-34, 35, 36 | DEC-03/04 | M |
| ACC-3 | Year-end approach and implementation | PA-10 | ACC-1, DEC-16 | M |
| ACC-4 | Bank-statement import and matching incl. payroll payments | PA-09 | ACC-1 | L |
| ACC-5 | Business-date unification | PA-14 | DEC-06 | M |
| ACC-6 | F03 lock-order decision and re-verification on HEAD | PA-13 | P0-A, DEC-13 | S–M |
| ACC-7 | AP/AR adjustment accounts and VAT by approved policy | PA-39 | DEC-17 | S–M |
| ACC-8 | FX revaluation (if required) | PA-11 | DEC-18 | M |
| ACC-9 | Enablers: sales-order cancellation (deposit policy), supplier return (GRNI/PPV reversal, debit note) | PA-01, 08 | DEC-14, DEC-15; P0-C | L each |
| ACC-10 | Order-to-cash and procure-to-pay chain tests with the oracle | PA-03 | ACC-9 for unwind cases | M |

### 6.2 HR
| WP | Content | Findings | Depends on | Size |
|---|---|---|---|---|
| PH1-HR-1 | = P0B (ledger correctness) | PA-34, 35, 36 | DEC-03/04 | M |
| PH1-HR-2 | Integrity primitives: audit chain (P0-A), business date (ACC-5) | PA-33, 14 | DEC-01, DEC-06 | M |
| PH1-HR-3 | Test net: chain test with numeric oracle, payroll in R1–R10 (R11), browser E2E for HR/payroll/commission/attendance, permission matrix; integrated E2E resumed after the Commission regression re-run and extended with journal-amount and post-disbursement assertions | PA-17, 23, 03 | PH1-HR-1 | M |
| PH1-HR-4 | HR master completion (contracts, documents, leave types/balances, shifts, holiday calendar) | PA-40, 37 | PH0-HR | L |
| PH1-HR-5 | Time-to-pay rules, statutory computation, tax/insurance liabilities, payslip | PA-16, 37 | PH0-HR, PH1-HR-1, 4; DEC-05 | L |
| PH1-HR-6 | Commission integrity: reversal/queue, GL recognition, cut-off tests | PA-38, 35 | DEC-04, PH1-HR-1 | M |
| PH1-HR-7 | Treasury & month-end: payment batch, rejection/re-issue, statement matching, closing-audit category for payroll | PA-09, 34 | PH1-HR-1 | M |

### 6.3 Enablers (run beside)
| WP | Content | Findings |
|---|---|---|
| ENB-1 | Frontend test strategy and short browser E2E set per phase path | PA-23 |
| ENB-2 | Real-Postgres job in CI; hosted CI run; the unrun specs | PA-22 |
| DOC-1 | Reconcile or retire `MASTER_PROJECT_STATUS.md`; adopt the capability matrix as the living one with an owner | PA-27 |
| ARCH-1 | Contract extraction opportunistically when a change touches a concrete cross-domain import (seven sit in the HR chain) | PA-28 |

### 6.4 Phase 1 exit gate
1. HR and Accounting each meet their exit criteria on a clean snapshot of a named commit, headers pinned, no other track's uncommitted files in the tested tree.
2. No open High finding in HR or Accounting; Medium findings have owners and dates.
3. P0-A, P0-B, P0-C (fulfil part) and P0-D complete with independent reviews recorded; N-02 remainder either closed or explicitly accepted.
4. Matrix updated with commit-tagged evidence; scorecard re-issued **only** with an approved rating method (DEC-21) — otherwise categorical.
5. Gate evidence reviewed by someone other than the author of the changed code.
6. CTO internal acceptance recorded; release remains a separate gate.

## 7. Phase 2 — remaining ERP roadmap (after the Phase 1 gate)

Retains the security, data-integrity and independent-verification gates of §8. Each item needs its ERP Integration Contract first.

| Order | Package | Findings | Depends on |
|---|---|---|---|
| 1 | **REL-1 Release and hosting readiness:** staging host, capacity targets and classification, multi-instance run, restore/rollback drills, monitoring and alerts, N-01 multi-instance extension if wanted | PA-24, 26, 30 | Phase 1 gate; DEC-11; host |
| 2 | PH2-2 Customer quotation → order | PA-02 | DEC-18 |
| 3 | PH2-3 Notifications and job queue; multi-instance-safe schedulers | PA-18 | REL-1 decisions |
| 4 | PH2-4 Lot/serial/expiry; FIFO/standard costing | PA-06, 07 | PH0-MFG, DEC-18 |
| 5 | PH2-5 Planning/MRP/capacity | PA-31 | PH0-MFG |
| 6 | PH2-6 Budgeting and read-only consolidation under the existing entitlement/audit model | PA-12 | ACC-1…4 |
| 7 | PH2-7 Integrations tenancy, more connectors, e-invoicing if legally required | PA-20, 15 | DEC-12, DEC-18 |
| 8 | PH2-8 HR breadth (recruiting, self-service, performance cycles, training, expenses) | PA-40 | Phase 1 HR |
| 9 | PH2-9 CRM pipeline, project costing, tracking domain | PA-31, 19 | — |

## 8. Dependencies, sequencing and critical path

```
DEC-01 ─► P0A-3..7 ───────────────┐
DEC-02 ─► P0A-5                   ├─► ACC-6, PH1-HR-2, restore drill (PA-30)
P0A-1/2 (now, needs window) ──────┘
P0B-1 (needs window) ─► DEC-03/04 ─► P0B-3..8 ─► PH1-HR-1 ─► PH1-HR-3/5/6/7
DEC-05 (jurisdiction) ───────────────────────────► PH1-HR-5
P0C-1/2 (needs window) ─► P0C-3 ;  DEC-08 ─► P0C-4 (N-02 remainder)
DEC-07 ─► P0D (independent N-01 review)
SEC-1 analysis (now) ─► DEC-20 ─► approved dependency changes (after ENB-1/ENB-2)
PH0-HR / PH0-MFG (now, docs) ─► PH0-GATE ─► Phase 1 design start ─► Phase 1 gate ─► Phase 2
```
**Critical path.** DEC-03/04 and DEC-05 (business/accounting policy) gate the largest HR work; DEC-01 gates the audit-chain fix that every rollback-heavy verification depends on; cluster windows gate every runtime proof. Work that can start without waiting: P0B-1 preparation, P0A-1/2 preparation, P0C-1 preparation, SEC-1 and SEC-2 analysis, Phase 0 drafting.

**Mandatory gates (apply to every package):**
| Gate | Requirement |
|---|---|
| Security | Dependency T1 before the Phase 1 gate; host proxy check; no new reachable High advisory |
| Data integrity | Any new lock-taking primitive gets a plain-manager concurrency probe before merge; oracle R1–R11 clean; audit-chain verification clean; payroll in the oracle |
| Company isolation | A/B isolation spec for any data access; LA-1 admission for any background path |
| Independent verification | Clean-snapshot evidence of a named commit; reviewer ≠ author of the change; evidence never merged across commits; results from skipped/blocked/unexecuted tests never counted as pass |
| Scope | Work outside an approved package or a protected file requires a new approval |

## 9. Unresolved decisions (owner and what each blocks)

| ID | Decision | Owner | Blocks (blocking condition) | Outcome that closes it |
|---|---|---|---|---|
| DEC-01 | Authorise the audit-chain fix (core component) | CTO | P0A-3…7; PA-30 restore drill; clean results of rollback-heavy tests | Written yes/no authorisation, with scope: hash the stored sequence value, no change to the hash format, no rewrite of existing rows |
| DEC-02 | Handling of existing broken chains: accept and annotate vs authorised repair | CTO + security/audit owner | P0A-5, P0A-7 | One recorded choice: accept-and-annotate existing breaks, or an authorised repair procedure with backup and reviewer |
| DEC-03 | Accounting shape of payroll: posting amount, disbursement entry, liabilities, partial/failed disbursement, cost-centre allocation | CTO + Finance/accounting owner | P0B-3…8; PH1-HR-1; HR exit | Signed accounting-treatment record: posting amount, disbursement entry, liabilities, partial/failed disbursement, cost-centre allocation |
| DEC-04 | Commission expense account and recognition timing | Finance owner | P0B-3…8; PH1-HR-6 | Named commission expense account and recognition timing (posting or payment) |
| DEC-05 | Statutory payroll rules (jurisdiction, overtime, tax, insurance), rate-table owner and sign-off | Business/legal owner | PH1-HR-5; HR exit | Signed statutory rules and rate tables with jurisdiction, effective dates and named sign-off owner |
| DEC-06 | Business-date rule (UTC or Cairo) | CTO | ACC-5; PH1-HR-2 | One recorded rule (UTC or Cairo) and the owner of the shared helper |
| DEC-07 | Name the independent N-01 reviewer | CTO | P0D | Named reviewer who is neither the author of the N-01 code nor a producer of its evidence |
| DEC-08 | Authorise the N-02 remainder (H1/H2/H4/H5) and name the independent reviewer of the fulfil fix | CTO | P0C-3/4 | Per finding (H1, H2, H4, H5) authorise or decline; name the independent reviewer of the fulfil fix |
| DEC-09 | Guard decisions: CREATEROLE least-privilege (3 specs); helper-statement decision (6 specs) | CTO / guard owner | SEC-3; PA-22 closure | Per group: approve or decline the test-helper adaptation; approve or decline the CREATEROLE alternative (otherwise those specs stay NOT RUN/BLOCKED); guard unchanged unless explicitly stated |
| DEC-10 | Name the F-INV-001 operator with read-only access | CTO | SEC-5; 410 release decision | Named operator, read-only access to every Company database, and an agreed window |
| DEC-11 | Capacity targets and staging host | CTO | REL-1; PA-24/26 | Approved capacity targets, an authorised staging host, a separate load generator and a named authoriser |
| DEC-12 | Integrations tenancy option | CTO | PH2-7; PA-20 | Choice of option A, B or C in the Integrations tenancy record |
| DEC-13 | F03: Option A (lock order) or accept retry permanently | CTO | ACC-6 | Go/no-go on lock-order restructuring, or acceptance of retry as permanent with a monitored deadlock counter |
| DEC-14 | Sales-order cancellation policy and deposit treatment; reactivation policy | CTO + Finance | ACC-9 | Policy table by sales-order state (deposit handling, reservation release) and a reactivation allowed/forbidden ruling |
| DEC-15 | Supplier-return accounting (GRNI/PPV) | Finance | ACC-9 | Approved GRNI/PPV treatment for supplier returns |
| DEC-16 | Year-end approach (derived equity vs closing entries) | CTO + Finance | ACC-3 | Choice: derived equity documented as policy, or closing entries with reopen safety |
| DEC-17 | AP/AR adjustment accounts and VAT treatment (currently literal `5299`) | Finance | ACC-7 | Account per adjustment kind and VAT treatment, replacing the literal 5299 default |
| DEC-18 | Confirm or withdraw requirements: quotation, lot/serial, FIFO/standard, FX revaluation, e-invoicing, contracts/documents | Product/business | PH2 items; PH0-MFG | Per requirement (quotation, lot/serial, FIFO/standard, FX revaluation, e-invoicing, contracts/documents): confirmed with scope, or withdrawn |
| DEC-19 | LA-1: owners and approach for the seven unwired sites | CTO + site owners | SEC-4 | Owner and date per unwired site, and confirmation of the admission pattern |
| DEC-20 | Approved change scope for dependency updates (T1 first) | CTO | SEC-1 changes | Approved list of package changes with versions, test list and rollback per change (T1 first) |
| DEC-21 | Approve the scoring method: dimension weights, coverage rules, named approver | CTO | any numeric quality score | Approved dimension weights, coverage rules and a named approver |
| DEC-22 | Manufacturing contract decisions M0-1…M0-6 | CTO + Manufacturing owner | PH0-MFG | Decisions on M0-1 to M0-6 of the Manufacturing contract questions |
| DEC-23 | Salary-data visibility (company, department, role) under the authorization model | CTO + HR owner | SEC-2; PH0-HR | Salary-data visibility matrix (company, department, role) consistent with the authorization model |
| DEC-24 | Payment instrument/batch file approach | CTO + Treasury owner | PH1-HR-7 | Chosen payment approach (bank file format, cash or other) and its owner |


## 10. Actions the team can safely continue without further approval

All within the approved scope: read-only, documentation, planning, analysis.
1. Draft Phase 0 contracts for HR and Manufacturing (documents only) and the decision records for DEC-03/04/05/06 with options and evidence.
2. Prepare, review and peer-check the P0A-1, P0B-1 and P0C-1/2 runbooks and test specifications as documents; agree cluster windows with the verification track.
3. Run SEC-1 dependency triage (analysis of existing audit data and source reachability) and SEC-2 hand review of the four controllers (read-only).
4. Reconcile documentation: update the register/matrix counts when the verification track commits its newer guard results; resolve the listed inconsistencies (§12).
5. Continue the already-approved verification-track work within its scope (guard-decision follow-through, evidence bundles, hosted-CI preparation) without weakening any guard.
6. Run existing test steps on the guarded cluster **only** in a window agreed with the track that reserves it, on clean snapshots, with evidence headers pinned.

## 11. Blocked items — authorisation or evidence required

| Item | Blocked on | Specific authorisation / evidence needed |
|---|---|---|
| Audit-chain fix | DEC-01 | CTO authorisation to change a core component; DEC-02 for existing chains |
| Payroll/GL/Treasury fix | DEC-03/04 and P0B-1 | Accounting policy decisions recorded; runtime validation result |
| Statutory payroll | DEC-05 | Jurisdiction, rules and rate tables from a named business/legal owner |
| N-02 remainder (H1/H2/H4/H5) | DEC-08 | CTO authorisation; H5 fixture |
| N-01 independent review | DEC-07 | Reviewer named |
| Clean-snapshot verification of HEAD | window | Non-conflicting use of the guarded cluster (shared, serialised) |
| 3 + 6 blocked real-Postgres specs | DEC-09 | Least-privilege decision (CREATEROLE) and helper-statement decision |
| F-INV-001 410 release | DEC-10 | Named operator with read-only access to every Company database; Q1–Q4 evidence; compatibility assessment |
| Capacity classification, hosting, multi-instance | DEC-11 | Approved targets; authorised staging host; separate load generator; named authoriser |
| Dependency changes | DEC-20 | Approved change scope per package; test net (ENB-1/2) in place for majors |
| Numeric quality score | DEC-21 | Approved weights, coverage rules and named approver |
| Integrations tenancy / e-invoicing | DEC-12, DEC-18 | Option chosen; written legal requirement |
| Any production or hosting action | — | Not authorised by this directive |

## 12. Evidence integrity notes and known inconsistencies

1. **Counts differ between the committed audit documents and a newer, uncommitted verification record.** The audit documents cite 80 PASS / 1 BLOCKED / 19 NOT RUN (committed verification report). The verification track's newer record (`test-program/VERIFICATION-DIRECTIVE-STATUS-2026-10-11.md`, uncommitted at the time of writing, therefore not used as audit evidence) reports 90 PASS / 9 BLOCKED / 1 NOT RUN. Reconciliation (separate evidence-reconciliation note): both figures describe the same 100-spec population; 10 specs moved from NOT RUN to PASS by test-only adaptations (7 + 3), 8 moved from NOT RUN to BLOCKED by a statement-by-statement guard evaluation (not by execution), 1 stayed BLOCKED and 1 stayed NOT RUN. Only 20 of the specs have clean-snapshot evidence (`a6002fa`); the rest are working-tree runs. The six audit documents stay unchanged in `2c6ccf3`; any update is a separate documentation commit.
2. The N-02 report's pipeline section is a placeholder (`<<PIPELINE>>`); the delta after `a6002fa` stays unverified on a clean snapshot (PA-42).
3. The T-21/T-22 evidence is working-tree class (header commit `ce924e2` + dirty paths), not a clean-snapshot verification.
4. Items confirmed only by code reading (PA-34, 35, 36, 37, 39) are labelled as such in every audit document; the runtime demonstration is step P0B-1.
5. N-01's closure was recorded by the code's author; it is carried as "closed for the local scope, sign-off pending, independent review requested (P0-D)".
6. The six audit documents state the audit cutoff `b591d1f`; later commits that change product source will require a new cutoff and a refreshed register.
