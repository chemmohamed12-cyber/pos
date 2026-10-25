# ADR-070 — Addendum 1 (v1): Payroll gap-closure contract — PROPOSED

**Version:** ADDENDUM-1 / v1 · **Date:** 2026-10-25 · **Status: PROPOSED — NOT APPROVED.** This addendum **adds** content; the text and status header of `ADR-070` are **not edited** (C16 = S2 does not authorize header changes; the final approval status is recorded only after CTO approval of this addendum together with `ADR-071-ADDENDUM-1` and `ADR-072-ADDENDUM-1`).
**Basis:** CTO decision "C16 Resolution, Contract Closure & Controlled GO" (2026-10-25): *Payroll delivery = gap closure of the existing implementation against the contract, not greenfield*. Findings referenced as `X-n` are those of `docs/hr-payroll/HR_PAYROLL_PHASE0_FOUNDATION_AND_BASELINE_REPORT_2026-10-25.md` §3.
**Contract decisions adopted by the CTO and elaborated here:** population = the company's payroll population for the period; recalculation = traceable revision; actor recorded per stage and SoD enforced server-side; disbursement has a verified posting path and reconciliation; rejection/resubmission/closure/post-close transitions explicit; actual collection and Attendance handoff paths documented and tested.
**What this addendum does NOT decide:** rates, legal rules, the posting amount basis and accounts, instruments, SoD profile per company — these stay with their owners (§9).

---

## A-5 (X-5) — Payroll population
- **Invariant P-1:** one payroll population per Company per `PayrollPeriod`: all `Employee` rows with `status='active'` and `employmentType ≠ 'contractor'` having an effective compensation for the period (ADR-067 §I). No partial population scope exists; the term `populationScope` in ADR-070 §4/§6 is **withdrawn** (it was never defined or implemented).
- **Uniqueness:** `UNIQUE(payrollPeriodId, revision)` (see A-4) — replaces the implemented `UQ_payroll_runs_period` (one run per period).
- **Eligible-but-excluded employee is never silent:** an active non-contractor employee without effective compensation, or terminated within the period, produces a recorded **exception** (closure report §6 / A-9), never a skipped row.
- **Compatibility:** existing runs are revision 1. **Acceptance tests:** (1) calculate on a period includes every eligible employee exactly once (unique `(runId, employeeId)` already exists); (2) an active employee without compensation yields an exception row and blocks approval until resolved; (3) a contractor yields no line and no exception; (4) attempting a second run for the same `(period, revision)` is rejected by the database.

## A-4 (X-4, X-10) — Recalculation as a revision
- **Entities:** `PayrollRun` gains `revision` (int ≥ 1), `supersedesRunId` (nullable), `kind` (`regular` | `supplementary`), status value `superseded`.
- **Invariants:**
  - R-1: only the highest revision of a period may progress; lower revisions are `superseded` or `posted`.
  - R-2 (not posted yet): recalculation from `calculated` (and from `reviewed` after return, A-9) is an **in-place recompute of the same revision** while no FA-01 request is open; once submitted, a change requires a new revision and the previous one becomes `superseded` (its commission reservations/adjustment consumptions are **released**, A-1).
  - R-3 (already posted): a posted run is **never reopened or rewritten** (ADR-072 §18, unchanged). A recalculation of a posted period is a **`supplementary` revision** containing only the delta lines against the posted revision, linked by `supersedesRunId`; it goes through the same lifecycle; its Financial Event carries `revision` in the idempotency key. The accounting treatment of the delta (period, accounts) is an Accounting-owner decision (§9 D-3).
  - R-4: the process-engine definition adds `calculated → calculated (recalculate)` (already present in code, **ratified here** — X-10) and the `rejected` return path of A-9.
- **Affected events:** `payroll.run.posted` payload adds `revision`, `kind`. **Compatibility:** all existing runs are `revision=1, kind=regular`; handler stays backward compatible (missing revision ⇒ 1).
- **Acceptance tests:** (1) recompute before submit keeps `revision=1`, idempotent lines; (2) change after submit creates revision 2, revision 1 `superseded`, reservations released; (3) a posted run cannot be recalculated in place (409); (4) a supplementary revision of a posted period contains only deltas and posts a delta event once (redelivery = no second entry); (5) `UNIQUE(period, revision)` enforced by the database; (6) history of all revisions queryable and reproducible.

## A-6 (X-6) — Actor per stage and server-side SoD
- **Entities:** `PayrollRunStageActor(runId, revision, stage ∈ {prepare, review, acknowledge_exception, submit, approve, disburse, reconcile}, userId, at)` — append-only; written in the same transaction as the stage transition. `approve` actor is the FA-01 decider copied from the approval request.
- **Invariants:** the SoD matrix of `HR_PAYROLL_STAGE1_DECISION_CLOSURE_REPORT_2026-10-25.md` §4 applies per Company SoD profile. **Mandatory floor (no waiver):** `approve.userId ≠ prepare.userId` and `approve.userId ≠ submit.userId`. Everything above the floor depends on the profile (`strict | standard | minimal`) and on recorded waivers; the profile of each Company and who may grant a waiver are owner decisions (§9 D-6).
- **Server-side:** checks run in `PayrollService` transitions (review, submit, acknowledge, disburse) and in the FA-01 decision hook for the payroll request type; never only in the UI. Refusal = 403 with an audit record `payroll.sod.refused`.
- **Compatibility:** historic runs have no actors ⇒ the checks apply only to revisions created after enablement; absent actor rows are never treated as "different persons".
- **Acceptance tests (API-level, direct calls):** same user prepare+approve refused; submit+approve refused; under `strict` prepare=review refused, review=approve refused, disburse=approve refused; waiver recorded ⇒ allowed above floor and flagged `executedUnderWaiver`; floor cannot be waived; refusal writes no state change.

## A-9 (X-9, X-16) — Transitions: rejection, resubmission, recalculation, period closure, post-close correction
Run (Process Engine; additions in **bold**):
```
draft → calculated → reviewed → approved → posted
calculated → calculated   (recalculate, same revision, no open request)
**reviewed → calculated   (reject: FA-01 'approval.request.rejected' or explicit return; clears approvalRequestId; records reason + actor)**
**posted/any → superseded  (only via a newer revision, A-4)**
```
- Rejection: Payroll **subscribes** to `approval.request.rejected` (company scope) — currently missing (X-9). A rejected run returns to `calculated`; resubmission goes `calculated → reviewed → submit` again with a **new** approval request; the rejected request stays in history.
- Period (`PayrollPeriod`): `open → closed`. Closure is an explicit authorized action allowed only when the latest revision is `posted` and no exception of class B-CALC/B-APPROVE is open; whether closure also requires full disbursement is an owner decision (§9 D-5). A closed period accepts **no** new revision except `supplementary` ones created by an explicit privileged action (post-close correction); ordinary post-close corrections are carried as **adjustment inputs** into the next open period's run (ADR-072 §14 "first eligible run").
- Future/overlapping periods: creating a period that overlaps another or lies wholly in the future is rejected unless the Company policy allows (default: reject).
- **Acceptance tests:** reject → returns to `calculated`, request history kept, resubmit works; double rejection event = no-op; period close refused with an unresolved exception or unposted run; post-close correction produces a supplementary revision or a next-period adjustment, never edits a closed run; overlap rejected by the database.

## A-7 / A-8 (X-7, X-8) — Posting and disbursement path (Accounting & Treasury review REQUIRED before approval)
- **A-8 journal basis — invariants only (amounts/accounts are Accounting's):** (J-1) every journal balances; (J-2) Σ credits to the net-payable liability for a run = Σ `netPay` of its lines; (J-3) commission is recognized **exactly once** — either inside the gross/expense basis or as its own line, never both and never omitted; (J-4) deduction liabilities and employer-side charges appear only when a ratified rule produced them; (J-5) each revision/delta has its own idempotent event.
- **A-7 disbursement:** disbursement is modeled as **payout batches/items** (closure report §3): stable ids, idempotency key per item, append-only, partial/failed/returned/reissue states, one reconciliation row per item to the Treasury transaction and to the posted journal. **A verified posting path is a precondition:** a payout item is not "complete" until its Treasury transaction **and** its Financial Event are `POSTED`. A cash movement alone is not completion. Treasury must provide an idempotent cash-out keyed by the item key (today `cashOutCore` has no key — E-1).
- **Event name and entry** (`payroll.payout.settled` vs `payroll.run.disbursed`; `Dr net payable / Cr cash account`) are **proposed, not decided** (§9 D-2/D-3).
- **Acceptance tests (financial E2E on a real ledger):** full payout reduces the run's payable to zero; partial payout leaves exactly the unpaid remainder; failed item posts nothing; reissue creates a new item/key; replay of the same item key creates no second movement or entry; return reverses by a new event; reconciliation report shows Σ lines = Σ journal = Σ treasury.

## A-10 (X-11, X-13, X-17, X-18) — Documented actual behaviours (to be tested, not assumed)
| Item | Actual (code, inspected) | Contract position |
|---|---|---|
| Attendance handoff | no event; reads approved batches overlapping the period via `listApprovedDaysByBatch`; days outside the period filtered | **Ratify as the handoff path**; add the coverage check (employees without approved attendance → exception, not silent pay); tests T-A1: batch overlapping boundary, T-A2: employee with no batch, T-A3: day in two batches impossible (batchId unique per day) |
| Calendar policy | `PayrollCalendarPolicy` extension point not implemented; all `absent` ⇒ `unclassified/none` | Keep fail-safe; classification of `unclassified` is an A-DOC exception requiring acknowledgement; real calendar after H0-2 |
| Permission nodes | `payroll.compensation.edit`, `payroll.run.create`, `payroll.deduction.create` listed/unused; `payroll.run.review` used | Align ADR names to the manifest; unused nodes removed from the contract until a route exists |

## Compatibility & migration notes (for planning only; no migration is authorized by this document)
New tables/columns would be additive (`revision`, `supersedesRunId`, `kind`, stage-actor table, payout tables, exception tables, consumption tables); existing rows map to `revision=1`; no existing posted row is modified; Company databases are upgraded by the existing migration pipeline (fan-out); rollback = additive objects stay unused.

## Remaining decisions (owners) — referenced above
§9 D-2 event name/shape (Accounting+Treasury) · D-3 posting basis, accounts, supplementary-delta treatment, business date (ACCOUNTING_POLICY_OWNER+CTO) · D-5 period closure trigger (PAYROLL_POLICY_OWNER+Accounting) · D-6 SoD profile per Company and waiver authority (SECURITY_AUDIT_OWNER+Finance).
