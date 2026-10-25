# HR · Attendance · Payroll · Commission — Delivery Matrix, Baseline and Implementation Plan

**Mandate:** CTO "Master Execution & Delivery Directive" (C16 = S2). **Production: HOLD.** This is the living ledger; the *Status* columns are updated as evidence arrives (last update: see §9).
**Status vocabulary:** NOT STARTED · IN PROGRESS · PASS (executed on the current candidate, evidence linked) · FAIL · BLOCKED · NOT RUN · HISTORICAL PASS.

## 1. Verified baseline (Phase 0)
| Item | Fact | Class |
|---|---|---|
| Working branch | `feature/hr-payroll-gap-closure` (worktree `.claude/worktrees/hr-payroll-audit`), created from `docs/hr-payroll-integration-audit` @ `b90c560`, plus cherry-pick of B-1 (`c6ab39f` → `59671bf`) | Confirmed (git) |
| Code base of the candidate | backend `src/` identical to `b661124` (HEAD of `feature/direct-sale-shipping`) except B-1; `main` = `505584d`, `b661124` is 2 commits ahead of it | Confirmed (`git diff`, `merge-base`) |
| Other lines vs this code | HR/Attendance/Payroll/Commission/Targets **backend** files are identical on `integration/local-2026-10-16`, `feature/treasury-integrity`, `feature/org-structure-gate0`, `feature/manufacturing-engine-design`; their **frontend** pages differ only by the i18n hard-coded-English fix (`06ddfae` family). Treasury differs strongly on `feature/treasury-integrity` (documents, bank reconciliation, 135-line change in `treasury.service.ts`) — **integration risk for the payout work (§5 WP-07)** | Confirmed (`git diff --stat`) |
| Main checkout | has other sessions' uncommitted edits (Sales/Shipping); untouched | Confirmed |
| Executed on a candidate | T-1: tsc + HR/Attendance isolation 11/11 (commit `2fe55a8` code = `b661124`); B-1: HR 7/7, Attendance 5/5, Commission 5/5, Payroll 5/5, Targets 3/3 (candidate = B-1 working tree before commit `c6ab39f`) | PASS (this candidate lineage); to be re-run on the final candidate |
| Historical, not reproduced | WP-PAY-01 measurements; ambient functional suites (blocked); E2E 4/4 of 2026-09-21; "92–95 isolation specs" | HISTORICAL PASS |
| Governing ADR status | ADR-059/063/065/067/068/069 Approved/Closed; ADR-070/071/072 Pending — C16 = S2 adopted by this mandate (baseline = existing code, gap closure); addenda `ADR-07x-ADDENDUM-1` are the working contract (PROPOSED → used as the working policy baseline per §2.2 of the mandate) | Approved policy / Proposed contract |
| Conflict check vs ratified ADRs | None found: ADR-067 §N allows duplicate-run only "with explicit policy" (= revisions, A-4); §M names `Recalculation Run` (= supplementary revision); §I contractors excluded (kept); §G no deduction from a bare UI action (kept). ADR-068 §F *closes* the `CommissionResult` field list ⇒ attribution is stored **inside the existing `calculationInputs` JSON**, no new column | Confirmed (reading) |

## 2. Working policy baseline (smallest safe options; no new business rules)
| Topic | Working rule used for implementation | Authority |
|---|---|---|
| Commission attribution | v1 rule = the **business date of the source event** (`finance.invoice.posted.businessDate`, `collection.remitted.businessDate`), stored in `calculationInputs.attributionDate`/`attributionRule`. Today's code uses processing time | Mandate §5.1 + addendum A-1 |
| Commission availability/eligibility | available = batch approved; a run consumes approved, unconsumed results with `attributionDate ≤ period.endDate` and approved before calculation; earlier-period leftovers are `carriedForward` | Mandate §5.1/5.2, addendum A-1/A-2 |
| Once-only consumption | DB partial unique index on the consumed id | Mandate §5.2 |
| Adjustments | immutable inputs; consumed once by the first open run | Mandate §5.3 |
| Run uniqueness / revision | one **active regular** run per period (partial unique) + `UNIQUE(period, revision)`; supplementary revisions for posted periods | Mandate §5.4, addendum A-4 |
| Population | company eligible employees; no `populationScope` | Mandate §5.5 |
| SoD | stage actors recorded; floor: approver ≠ preparer, approver ≠ submitter; Company profile `standard` (default) / `strict`; waiver mechanism and `minimal` profile **deferred** (owner decision D-6) | Mandate §5.6, addendum A-6 |
| Journal basis | expense debit = Σ(gross + approved commission) on the existing `5201`; credit = Σ net pay on `wages_payable`; deductions/employer lines only when a ratified rule exists (none) ⇒ commission recognised once, no new account. **Business date unchanged (approval date) until Accounting decides** | Mandate §5.7, ADR-072 §21, addendum A-8 |
| Disbursement | payout batch/items, idempotency key unique, GL via the paying Treasury account's mapped code (same path as supplier payment), event `payroll.payout.settled` | Mandate §5.8, addendum A-7 |
| Rejection / period | `reviewed → calculated` on rejection; period `open → closed` after posted run | Mandate §5.9, addendum A-9 |
| Compensation | effective date (date) + reason on every change; the **effective** compensation for the period is used | ADR-067 §B, mandate §5.4 |
| Not implemented (no approved rule) | deductions of any kind, overtime, gratuity, calendar/holiday calendar, timezone change (DEC-06), `net_sales`, `customer_group`, `minimal` SoD profile/waivers, compensation approval workflow | Mandate §8.1 / §19 |

## 3. Requirements traceability and delivery matrix
Columns: ID · requirement · source · owner · code/data touchpoints · permission · UI · verification (evidence) · **status**.

| ID | Requirement | Source | Owner | Touchpoints | Permission | UI | Verification required | Status |
|---|---|---|---|---|---|---|---|---|
| R-HR-1 | Employee↔User link only to an active member of the same Company | ADR-059 D2, mandate §11 | HR | `hr.service.linkUser`, controller | `hr.employee.link_user` | HrEmployees (uses `/admin/users` picker — gap) | real-PG isolation spec | **PASS** (spec 7/7, `evidence-b1-2026-10-25`); UI picker gap G-09 NOT STARTED |
| R-PAY-01 | One company population; one active regular run per period; remove `populationScope` | ADR-067 §I/§N, addendum A-5 | Payroll | `payroll_runs`, `PayrollService.calculate` | `payroll.run.calculate` | PayrollRuns | DB constraint test; duplicate run rejected | NOT STARTED |
| R-PAY-02 | Effective-dated compensation with date + reason; effective-for-period selection | ADR-067 §B | Payroll | `payroll_compensations`, `createCompensation`, `calculate` | `payroll.compensation.create` | PayrollCompensation | recalculation of an old period after a raise uses the old value | NOT STARTED |
| R-PAY-03 | Exact decimal arithmetic for money | PA-36, mandate §8 | Payroll | `calculate`, handler, totals | — | — | property test with random cents; totals stored | NOT STARTED |
| R-PAY-04 | Exceptions (4 classes, fingerprint, acknowledge, re-evaluate); no silent skip | addendum A-9/A-10, closure §6 | Payroll | new `payroll_exceptions` | `payroll.exception.acknowledge` | RunDetail panel | API tests per class; approval blocked | NOT STARTED |
| R-PAY-05 | Stage actors + server-side SoD (floor + profile) | ADR-067 §L, A-6 | Payroll | `payroll_run_stage_actors`, service checks | existing nodes | RunDetail errors | direct-API bypass attempts → 403 | NOT STARTED |
| R-PAY-06 | Rejection path and resubmission | ADR-070 gap X-9, A-9 | Payroll | subscriber `approval.request.rejected` | — | RunDetail | reject → calculated → resubmit | NOT STARTED |
| R-PAY-07 | Period lifecycle, overlap prevention, close, post-close correction path | ADR-067 §N, A-9 | Payroll | `payroll_periods`, trigger/guard | `payroll.period.close` (new) | PayrollPeriods | overlap/close tests | NOT STARTED |
| R-PAY-08 | Revisions: supersede before posting, supplementary delta after posting | ADR-067 §M, A-4 | Payroll | `payroll_runs.revision/kind/supersedesRunId` | calculate | RunDetail | revision tests | NOT STARTED |
| R-PAY-09 | Adjustments are consumable inputs, once, traceable | A-3 | Payroll | `payroll_adjustments`, consumption table | `payroll.adjustment.create` | RunDetail | next-run consumption test | NOT STARTED |
| R-COM-01 | Attribution = source business date; stored in snapshot | A-1 | Commission | `calculateFromEvent` | — | CommissionResults | event with past date | NOT STARTED |
| R-COM-02 | Once-only consumption with DB uniqueness; concurrency-safe | A-2, mandate §5.2 | Payroll | `payroll_commission_consumptions` | — | RunDetail | parallel-run real-DB test | NOT STARTED |
| R-COM-03 | Late approval → first open run; carry-forward flagged | A-1 | Payroll/Commission | `listApprovedCommissionResults` replacement | — | RunDetail | scenario B | NOT STARTED |
| R-COM-04 | Commission adjustment/reversal consumed once; posted run untouched | A-3 | Commission/Payroll | `commission_adjustments` + consumption | `commission.adjustment.create` | — | scenario D | NOT STARTED |
| R-COM-05 | `net_sales` / `customer_group` disabled until defined | A-11 | Commission | `createPolicy` | — | CommissionPolicies | creation rejected | NOT STARTED |
| R-ACC-01 | Commission recognised once; journal = Σ(gross+commission) / Σ net | A-8 | Accounting | `payroll-run-posted.handler` + payload | — | — | ledger assertions (real PG) | NOT STARTED |
| R-ACC-02 | Payout batches/items; event; handler `Dr wages_payable / Cr treasury-mapped account` | A-7 | Payroll/Treasury/Accounting | new tables, handler, `FinanceTreasuryContract.requireGlMappedAccount` | `payroll.run.disburse` | RunDetail payout panel | financial E2E | NOT STARTED |
| R-ACC-03 | Partial / failed / reissue / return | A-7 | same | same | same | same | scenario list E-10 | NOT STARTED |
| R-ACC-04 | Reconciliation (lines = journal = payouts = treasury) | A-7, mandate §8.2 | Payroll | endpoint `payroll/runs/:id/reconciliation` | `payroll.run.view` | RunDetail | scenario E-12 | NOT STARTED |
| R-ACC-05 | Revision-aware, idempotent posting | A-4 | Accounting | idempotency key | — | — | redelivery test | NOT STARTED |
| R-ACC-06 | Closed fiscal period: rejection + documented redrive | ADR-070 §14 | Accounting | existing `redrive` | `accounting.journal.post` | — | test with closed period | NOT STARTED |
| R-ATT-01 | Employee without approved attendance ⇒ exception (not silent pay) | A-10 | Payroll | `calculate` | — | RunDetail | scenario | NOT STARTED |
| R-ATT-02 | Business-date/timezone rule (DEC-06) | H0-5 | CTO | — | — | — | — | **BLOCKED** (owner decision) |
| R-ATT-03 | Holiday calendar / absence deductions (H0-2) | ADR-067 §C | HR/Payroll owners | — | — | — | — | **BLOCKED** (owner decision; fail-safe kept) |
| R-SEC-01 | Company isolation for every new table/route | mandate §11 | all | specs `*.company-isolation` | — | — | A/B spec counting every non-200 | NOT STARTED |
| R-SEC-02 | Permission alignment: nodes in manifest = routes; unused nodes removed | A-10 | Payroll | manifest | — | — | static test | NOT STARTED |
| R-UI-* | Screens for the above (RunDetail, Periods, Compensation) in AR/EN, RTL/LTR, responsive | mandate §10 | Frontend | `pages/payroll/*` | — | — | browser journeys | NOT STARTED |
| R-FIN-* | Numerical acceptance suite (mandate §8) | mandate §8 | Payroll/Accounting | spec | — | — | real-PG | NOT STARTED |

## 4. Architecture / integrity review summary (Phase 2)
Trace per rule: *Contract → entity → service → handler → authorization → API → UI → test* is given by §3 columns. Key integrity findings used by the plan: (1) `PayrollService` writes only its own tables and treasury via contract ✓; (2) all new tables are Payroll-owned; Commission is changed only in `calculateFromEvent` (attribution stored in JSON) and `createPolicy` (guard); Accounting only in the payroll handlers + registry; Treasury **unchanged** (idempotency by payout-item unique key in the same transaction, GL mapping via the existing `requireGlMappedAccount` path); (3) transaction boundaries: calculate/reserve in one transaction with `runInTransaction`-style joining; approve→consume in the same transaction as the process transition; (4) migrations are additive in the `payroll` tag only, timestamp block `17901xxxxxxxx` (clear of every other line: max seen 1790034600000), run through the existing per-Company pipeline.

## 5. Implementation plan (work packages, files, risks)
| WP | Scope | Files (backend) | Tests (real PG, harness) | Key risks → mitigation |
|---|---|---|---|---|
| WP-02 | schema | `migrations/payroll/1790100000000-*`, entities, `payroll-company-entities.ts`, `payroll.module.ts` | harness provisions Company DBs through migrations | breaking `UQ_payroll_runs_period` users → partial unique replacement + backfill `revision=1` |
| WP-03 | commission | `commission.service.ts` (attribution, policy guard), `payroll-commission-consumption.entity.ts`, selection query | attribution, late approval, concurrency | Commission float math left as is (not in scope; flagged) |
| WP-04 | calc engine | `payroll.service.ts` (decimal, effective compensation, exceptions) | numeric suite | existing specs call `createCompensation` w/o date ⇒ default today |
| WP-05 | runs/revisions/adjustments | same + entities | revision, supplementary, adjustment | process-engine definition change (recalculate, reject) |
| WP-06 | workflow/SoD/period | service + controller + manifest | SoD bypass matrix, rejection, close | FA-01 payload extended (exceptions hash) |
| WP-07 | accounting/treasury | `payroll-run-posted.handler.ts`, new `payroll-payout-settled.handler.ts`, `handler-registry.ts`, `financial-event.service.ts` topic map, `finance-handlers.ts`, `payroll.service.ts` payout | financial E2E on real ledger | `treasury-integrity` branch changes `treasury.service.ts`: only the unchanged `cashOutForEmployee` contract is used |
| WP-08 | attendance | `calculate` coverage check | scenario | DEC-06 untouched |
| WP-09 | UI | `frontend/src/pages/payroll/*`, lib types, terminology seed migration | browser journeys | i18n branch overlap in these files ⇒ keep edits minimal, avoid reformatting |
| WP-10 | E2E/regression | specs + suites | scenarios A–G | shared cluster 5546 coordination |
Rollback: all schema additive; code revert; no data rewrite.

## 6. Stop conditions currently active
DEC-06 (timezone), H0-2 (calendar/absence), H0-1 (deductions), D-6 waiver/`minimal` profile, D-3 business-date/closed-period accounting choice, P-1…P-6 owner values: **isolated**; implementation proceeds with the working rules in §2 and these items marked BLOCKED/deferred.

## 7–8. (reserved: evidence index, defects found) — see §9 for the current ledger.

## 9. Progress ledger
| Date | Step | Result |
|---|---|---|
| 2026-10-25 | Phase 0 baseline, matrix, plan written | this file |
