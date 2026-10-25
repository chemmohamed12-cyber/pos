# ADR-072 — Addendum 1 (v1): Integrated chain gap-closure contract — PROPOSED

**Version:** ADDENDUM-1 / v1 · **Date:** 2026-10-25 · **Status: PROPOSED — NOT APPROVED.** `ADR-072` text/header untouched. Final status after CTO approval of the three addenda together.
**Basis:** CTO decision 2026-10-25. Cross-references: `ADR-070-ADDENDUM-1` (Payroll), `ADR-071-ADDENDUM-1` (Commission); findings `X-n` in the Phase 0 report §3.

---

## 1. Cross-context rules restated precisely (replacing the contradicted parts of ADR-072 §14/§18 for implementation)
1. **Late approval is not retroactive** (ADR-072 §6 kept): a result approved after a run calculated is not pulled into it.
2. **Where it lands** (resolves X-1 vs ADR-070 §9): per `ADR-071-ADDENDUM-1` C-3 — availability by approval, eligibility by the policy-selected rule; the **first eligible open run** consumes it, flagged `carriedForward` if its attribution period is earlier. "Next calendar period" wording is not used.
3. **Once only** (resolves X-2): consumption table with database uniqueness (`ADR-071-ADDENDUM-1` A-2).
4. **Corrections** (resolves X-3): immutable adjustment inputs consumed once by an open run as explicit lines linked to the original result and, where applicable, the posted run line; the posted run, its journal and its lines are never reopened or rewritten (ADR-072 §18 kept).
5. **One GL entry point per run revision** (ADR-072 §16 kept, refined): `payroll.run.posted` per `(run, revision)`, plus payout events per payout item/batch (ADR-070-ADDENDUM A-7). "Payroll finalized" (`posted`), "GL confirmed" (`FinancialEvent=POSTED`) and "money moved" (payout item `paid` **and** its event `POSTED`) remain three separate facts.

## 2. Actors and SoD across the chain (resolves X-6)
- Every material stage records its actor (`PayrollRunStageActor`; Commission batch decider via FA-01). The only SoD rules ADR-072 §10 may claim are those enforceable from recorded actors: Commission batch maker ≠ approver (FA-01); Payroll mandatory floor `approver ≠ preparer`, `approver ≠ submitter`; higher separation by the Company's profile. Statements about "whoever triggered an event-driven calculation" are withdrawn (no actor exists).

## 3. Journal basis (resolves X-8) — invariants, not amounts
The posted amount, accounts, commission timing and deduction/employer-side lines are **Accounting's decision** (DEC-03/04, H0-4). The contract fixes only: balanced; commission once; credits to net payable = Σ net pay; deduction liabilities only from ratified rules; revision-aware idempotency; business date vs posting date explicit; closed-period behaviour defined by Accounting with a documented recovery path.

## 4. Disbursement and reconciliation (resolves X-7)
Payout items/batches with stable ids and idempotency keys; Treasury cash-out idempotent by key (prerequisite E-1); Financial Event per settlement with revision/sequence in the key; reconciliation joins item ↔ Treasury transaction ↔ Financial Event ↔ journal; a payout item is complete only when all of them are consistent. Failure/partial/return/reissue per `ADR-070-ADDENDUM-1` A-7.

## 5. Documented actual handoff paths (resolves X-13, X-18)
Collection: `collection.remitted` (not `recorded`). Attendance: approved batches read via `listApprovedDaysByBatch`; no event dependency; coverage exceptions. Both get explicit tests (§7).

## 6. Disabled capabilities until their basis is explicit (X-14, X-15)
`net_sales`, `customer_group`: disabled by contract (`ADR-071-ADDENDUM-1` A-11).

## 7. Integrated acceptance set (supersedes ADR-072 §19 for the new gate; executes only after the addenda are approved and the corresponding gap closures are authorized)
Each scenario is a real-database, API-level test with identifiers linking source → financial effect; none may be marked PASS from unit/mocked evidence.

| # | Scenario | Key assertions |
|---|---|---|
| E-1 | Invoice → commission → approval → payroll (Chain A) | policy resolved (customer > group(disabled) > rep); result attribution date set; consumption row unique; line commission = result; journal basis per Accounting; trace by ids |
| E-2 | Collection-based commission | only `collection.remitted` triggers; redelivery no duplicate |
| E-3 | Attendance → day type → pay impact (Chain B) | approved batch only; `absent` ≠ deduction; unclassified acknowledged exception; coverage exception for employee without attendance |
| E-4 | Late approval | result approved after calculate is excluded; included in the next eligible run once; flagged carried-forward |
| E-5 | Concurrent runs/approvals | one consumption; one journal; one payout per item |
| E-6 | Commission adjustment/reversal after posting | posted run untouched; adjustment input in next open run; linked to original; idempotent |
| E-7 | Recalculation | revision n+1; reservations released/re-reserved; posted period ⇒ supplementary delta only |
| E-8 | Rejection and resubmission | returns to `calculated`; new request; history kept |
| E-9 | Posting failure and recovery | `posted` run with rejected event is flagged; disbursement refused; fix + redrive ⇒ POSTED once |
| E-10 | Payout: full, partial, failed, reissue, return | exact remainders; no duplicate movement/entry; return reverses by new event |
| E-11 | Closed fiscal period | event rejected with reason; documented recovery works; no duplicate |
| E-12 | Reconciliation | Σ lines = Σ journal = Σ treasury per run; report empty when consistent; gap listed when not |
| E-13 | Unauthorized and SoD bypass attempts | direct API calls by role without node; same actor at two stages; floor not waivable |
| E-14 | Tenant isolation | every step A/B Company; all non-200 counted |
| E-15 | Audit chain | from source invoice/collection to journal and payout via ids and audit records |

## 8. Compatibility
Additive only; all existing runs/results map to `revision=1` / legacy attribution; handlers accept payloads lacking new fields; no existing posted record is modified.

## 9. Open owner decisions that gate implementation of the corresponding items
Accounting/Treasury: D-2, D-3 (event, basis, business date, closed period, supplementary delta). Payroll policy: D-5 (period closure), exceptions' final classes. HR/Payroll: calendar/attendance coverage (H0-2), DEC-06. Commission: P-1…P-6 (`ADR-071-ADDENDUM-1` §6). Security/Finance: D-6 (SoD profile, waiver authority). Legal: H0-1 (deductions) — **no deduction behaviour is implemented without it**.
