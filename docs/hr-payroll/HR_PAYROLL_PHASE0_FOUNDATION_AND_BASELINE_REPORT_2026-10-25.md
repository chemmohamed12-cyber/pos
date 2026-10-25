# DAII HR / Attendance / Payroll / Commission — Phase 0 Foundation & Contract Gate + Phase 1 Baseline Report — 2026-10-25

**Authority:** CTO "Unified Completion Plan" directive (Phase 0 first). **Mode:** read-only. No code, migrations, DB changes, ADR edits, merges, releases or deployments. **Implementation: HOLD. Release: HOLD.**
**Evidence labels (per directive §8):** `PASS` executed with evidence · `FAIL` · `BLOCKED` · `NOT RUN` · `INSPECTED` (static review, no runtime claim). Historical records are quoted as **RECORDED** (they were executed by someone earlier; **not re-verified here**).
**Decision-type labels (per directive §1.2):** Approved · Proposed · Pending · Verified · Blocked · Closed.
**Builds on (kept as historical evidence):** audit `a371475`, pack v1 `416c6d1`, v2 `b9c84e3`, closure report `e636dfd`.

---

## 1. Verification of the statuses stated in the directive

| Directive statement | Authoritative record found | Result |
|---|---|---|
| Implementation HOLD / Production HOLD | ADR-070/072 headers "HOLD IMPLEMENTATION"; closure report 2026-10-14 "NOT READY — implementation must not begin" | **Confirmed** (Pending) |
| ADR-070/071/072 pending CTO review/approval as one package | ADR-071 header: "awaiting CTO review/approval as one package"; ADR-070/072: "CONDITIONAL / HOLD IMPLEMENTATION"; register C16 PENDING | **Confirmed** (Pending). Code nonetheless exists (see §2 R-1) |
| C16 / S2 proposed, not adopted | Register: C16 row PENDING; "C16 — proposed decision text" section, "Adoption record" empty (`e636dfd`) | **Confirmed** (Proposed) |
| HR Phase 1 / ADR-059 closed and passed | ADR-059 header: **APPROVED**, Phase 1 authorized, D1–D4 binding. "CLOSED/PASS" appears as a *citation* in ADR-062/063/064/066/067; Phase-1 gap-closure commit `522f866` (2026-09-19). **No standalone HR closure/acceptance report located** | **Partly confirmed:** Approved = Verified-by-record; "Closed/Passed" is asserted by five later ADRs but its primary evidence document was not found → label **Closed (asserted) / primary evidence not located** |
| Attendance closure and Payroll handoff complete and verified | ADR-069: "CLOSED — COMPLETE / VERIFIED / HANDOFF-READY… CTO-accepted closure §10", `attendance-phase1.spec.ts` 12/12 recorded 2026-09-19 | **Confirmed as RECORDED**; not re-executed |
| ADR-067 / ADR-068 policies ratified | Headers "RATIFIED (2026-09-19)" | **Confirmed** (Approved) — with §D/§E (overtime, tax, insurance) deliberately unresolved |
| Payroll/Commission contracts exist ≠ implementation authorized | Same as row 2 | **Confirmed** |

**Important baseline caveat:** the HR/Attendance "closure" evidence dates from **2026-09-19/20**. Afterwards the code was changed by the Area-21 company-scoping retrofit (`1517d81`, 2026-10-06: every service now takes the Company `manager`), the biometric import (`9d43a1a`), the Cairo time-zone fixes, and the v1.1.x releases. Later isolation specs exist (`*.company-isolation.spec.ts`) and later regressions are recorded (92–95 isolation specs, 2026-10-13/14) but **no HR/Attendance baseline re-run was done for this directive** → the baseline is "recorded, not re-verified".

---

## 2. Decision & Evidence Register (Gate 0 deliverable)

| ID | Decision / contract | Current authoritative status | Supporting evidence | Outstanding question | Decision owner | Blocks implementation? |
|---|---|---|---|---|---|---|
| R-1 | Status of ADR-070/071/072 vs existing code (C16) | **Pending** (S2 *Proposed*) | Register C16; git `7977770`…`6d0fad2`; no approval record in repo; v2 §1.2 evidence table | Adopt S1/S2/S3; edit headers only after adoption | CTO | **Yes** (all Payroll/Commission/Targets work) |
| R-2 | ADR-059 HR Phase 1 | **Approved**; closure asserted | ADR-059 header; `522f866`; later ADRs | Locate/confirm primary closure evidence; re-run HR regression | CTO / HR_OWNER | No (protected baseline) |
| R-3 | ADR-062/063/065/069 Attendance | **Approved / Closed** (recorded) | ADR-063 RATIFIED; ADR-069 CLOSED §10; spec 12/12 recorded | Re-run on current HEAD | CTO | No |
| R-4 | ADR-067 Payroll policy | **Approved** (RATIFIED) with named open items | Header; §D/§E/§H unresolved | H0-1 legal rules | PAYROLL_POLICY_OWNER | Only for deductions |
| R-5 | ADR-068 Commission policy | **Approved** (RATIFIED) | Header; Net Sales basis & Customer Group undefined | `net_sales` composition, Customer Group source | CTO / CRM owner | Only for those sub-features |
| R-6 | ADR-070 Payroll contract | **Pending**; internally inconsistent in places (§3) | Header; §3 below | Amendments A-1…A-9 (§3.4) before approval | CTO | **Yes** |
| R-7 | ADR-071 Commission contract | **Pending** | Header; §3 | Amendments; `collection.recorded` vs code | CTO | **Yes** |
| R-8 | ADR-072 Integrated E2E contract | **Pending**; E2E status **Blocked/unknown** | Header; `9da2e54` (4/4 on 2026-09-21 then re-labelled BLOCKED for regression 202/204) | Re-execute on a clean cluster after fixes | CTO | **Yes** |
| R-9 | Payroll → Accounting posting amount/shape (H0-4/DEC-03/DEC-04) | **Pending** | Register A1/A2; WP-PAY-01 `[RECORDED]` | Owner sign-off | ACCOUNTING_POLICY_OWNER + CTO | Yes (financial gate) |
| R-10 | Disbursement (H0-6) | **Pending** | Register R1; code `NO_EMIT` INSPECTED | Instrument, partial, reversal; Treasury idempotency | TREASURY_OWNER | Yes (financial gate) |
| R-11 | Calendar/attendance impact (H0-2), DEC-06 | **Pending** | Register P2, C12 | Policy | HR_OWNER, PAYROLL_POLICY_OWNER, CTO | Yes (Attendance handoff gate) |
| R-12 | SoD profiles & waiver (v2 §5/closure §4) | **Proposed** | Closure report | Adopt floor/profiles | CTO + SECURITY_AUDIT_OWNER | Yes (Payroll Core) |
| R-13 | Org Structure Engine | **Pending** (branch `feature/org-structure-gate0` `edc2d7a`, unmerged) | Memory/records; INSPECTED worktree list | Merge/approval order | CTO | For dimension/Unit-scope work only |
| R-14 | Compensation ownership = Payroll | **Approved direction** (CTO 2026-10-25 guidance; ADR-070 §8) | Directive of this series | — | — | No |
| R-15 | First executable Gate | **Proposed**: Gate B-1 (HR-local) | Closure report §7/§9.6 | Authorization | CTO | — |

**Tally:** Approved 5 · Proposed 3 · Pending 8 · Blocked-by-prerequisite: R-6/7/8/9/10/11 · Verified-by-executed-evidence **this session: 0**.

---

## 3. Contract review: are ADR-070 / 071 / 072 coherent, compatible and ready for approval as one package?

**Method:** full read of the three ADRs against each other and against the implemented code (INSPECTED; nothing executed). Classification: **C** contradiction · **G** gap/ambiguity · **D** code deviates from contract · **N** note.

### 3.1 Findings

| # | Class | Finding | Where | Blocks approval? |
|---|---|---|---|---|
| X-1 | **C** | **Commission period attribution.** ADR-070 §9 reads Approved results "within the PayrollRun's period"; ADR-072 §14/§18 says a result approved after a run calculated becomes eligible for "the next/first eligible run, not defined by period position". A date-window query cannot do both; nothing defines which date attributes a result to a period (invoice, collection, calculation, approval). Code uses `calculationTimestamp` window (`commission.service.ts:457-467`) ⇒ a late-approved result falls in no later window. | 070 §9 vs 072 §14 | **Yes** |
| X-2 | **G** | **No consumption/uniqueness rule** for a result across runs. ADR-070 §6 prevents duplicate *runs per (period, scope)* only; nothing says a `CommissionResult` may be consumed once. With overlapping periods or carry-forward (X-1) a result can be paid twice. | 070 §6, 071, 072 | **Yes** |
| X-3 | **C** | **Adjustment mechanics.** ADR-072 §14 says a Commission correction lands in the first eligible run "as its own explicit `PayrollAdjustment`/earning line". ADR-070 §4/§18 defines `PayrollAdjustment` as a record that *references an original posted `PayrollRunLine`* (`originalPayrollRunLineId`), not as an input a later run consumes; no run-side consumption is specified. `CommissionAdjustment` → Payroll path is unspecified. | 070 §4/§18, 071 §5, 072 §14 | **Yes** |
| X-4 | **C** | **`recalculation` kind vs unique run per period.** ADR-070 §18 says a `recalculation` produces a new `PayrollRun` superseding the original; ADR-070 §6 and the implemented index `UQ_payroll_runs_period` allow one run per period (D). | 070 §6/§18; `CreatePayrollCore.ts:82` | Yes |
| X-5 | **G/C** | **`populationScope`** appears in ADR-070 §4/§6 (`one per (period, populationScope)`), is never defined, and does not exist in code (D). | 070 §4/§6 | Yes |
| X-6 | **C** | **Maker≠checker wording vs FA-01 behaviour.** ADR-070 §19.6: "the maker of the calculate/submit action cannot also approve"; ADR-072 §10: reviewer and approver distinct, Commission approver "distinct from whoever triggered the calculation". FA-01 only compares **submitter ≠ approver** (`approval-engine.service.ts:313`); calculate/review actors are not recorded as "maker"; Commission calculation is event-triggered (no actor). The stated rules are unenforceable as written. | 070 §19.6, 072 §10 | **Yes** (SoD) |
| X-7 | **C/D** | **Disbursement ledger effect.** ADR-070 §16 specifies `Dr Wages Payable / Cr Treasury` "same shape SupplierPaymentService posts", §9 says "mirror `cashOutForSupplier` exactly". Verified: Supplier payment gets its ledger effect because **`SupplierPaymentService` publishes its own event** (`finance.supplier_payment.recorded`, `supplier-payment.service.ts:116`, registered in the handler registry) while `cashOutForSupplier`/`cashOutForEmployee` are `NO_EMIT`. ADR-070 never names the payroll equivalent event. The implementation copied the cash leg only (D) → PA-34. The contract is therefore ambiguous at exactly the point that failed. | 070 §9/§16; `treasury.service.ts:736-755` | **Yes** (financial) |
| X-8 | **G/C** | **Amount posted.** ADR-070 §16 posts "aggregate Dr/Cr amounts" (basis unspecified); ADR-072 §21 says "GL posting of gross pay + resolved commission"; ADR-071 §16 says Payroll posts commission. Implementation posts gross only while paying net incl. commission (D). | 070 §16, 071 §16, 072 §21 | **Yes** (financial; owner decision H0-4) |
| X-9 | **G** | **Rejected approval path.** ADR-070 §5 defines no `reviewed → …` transition on rejection; the implementation subscribes to `approval.request.approved` only (`payroll.service.ts:123-129`) — a rejected request leaves the run `reviewed` with a dangling `approvalRequestId`. | 070 §5/§10 | Yes |
| X-10 | **D** | **Recalculate transition.** ADR-070 §5/§12 allow `calculate` only from `draft`; implementation adds `calculated → calculated (recalculate)`. | 070 §5/§12; `payroll.service.ts:34-38` | No (needs ratification) |
| X-11 | **G** | **`PayrollCalendarPolicy`** is specified as an extension point; no such component exists in code (D): every `absent` day is `unclassified`, including real weekends/holidays. Contract says a configured policy resolves weekend/holiday/working — unreachable today. | 070 §9/§21 | No (H0-2 owner) |
| X-12 | **C** | **Exceptions vs "run is not blocked".** ADR-072 §14: unclassified days never block the run. The proposed exception framework (closure report §6) classifies some conditions as approval-blocking. Compatible only if "unclassified day" is explicitly an A-DOC acknowledgement, not a block. | 072 §14 vs closure §6 | Needs explicit decision |
| X-13 | **D** | **Collection event.** ADR-071 §3/ADR-072 §9: subscribe to `collection.recorded|remitted`; code subscribes `finance.invoice.posted` + `collection.remitted` only (deliberate F03 convention, code comment). | 071 §3; `commission.service.ts:99-125` | No (record the deviation) |
| X-14 | **G** | **`net_sales` basis undefined** (ADR-071 §21) but the code already accepts it (`commission.service.ts:360` maps `net_sales` to `netAmount`). Defined by implementation, not by decision. | 071 §21 | Yes for that basis |
| X-15 | **G** | **`customer_group` scope** inert (no structured entity); policy rows of that scope can be created `[U]` whether code rejects them. | 071 §3/§21 | No (documented) |
| X-16 | **D** | **PayrollPeriod lifecycle.** ADR-070 §4 declares `open|closed`; nothing closes it and no transition is defined. | 070 §4/§17; `payroll.service.ts:137` | Yes |
| X-17 | **D** | **Permission nodes.** ADR-070 §10 lists `payroll.compensation.edit`; manifest has none; `payroll.run.create`/`payroll.deduction.create` exist with no route. ADR-071 `commission.batch.{create,approve}` vs manifest `submit/approve`. | 070 §10; manifests | No (naming; record) |
| X-18 | **D** | **Attendance handoff.** Contract: `attendance.period.approved` event + `listApprovedDaysByBatch`. Code ignores the event and reads all approved batches overlapping the period. Equivalent in effect; deviation to ratify. | 070 §9; `payroll.service.ts:278-290` | No |
| X-19 | **N** | ADR-070 §6 correctly states `posted` ≠ GL-confirmed and defines the reconciliation query; implemented as `listReconciliationGaps` (INSPECTED). Consistent across 070/072. | — | — |
| X-20 | **N** | Dependency directions are acyclic and consistent in all three ADRs and in the manifests (INSPECTED). | — | — |

### 3.2 Compatibility verdict
- **Structurally compatible:** ownership tables, dependency directions, event topics (`payroll.run.posted`), outbox semantics and the Option-A `posted` meaning are consistent across the three ADRs and with the code.
- **Not ready for approval as one package as written:** X-1, X-2, X-3, X-4, X-5, X-6, X-7, X-8, X-9, X-14, X-16 are contradictions/gaps that make some acceptance criteria **untestable or unenforceable** (§3.3).

### 3.3 Untestable / ambiguous acceptance criteria
- ADR-072 §19.5 ("adjustment visible only in a subsequent run") — no mechanism (X-3).
- ADR-070 §19.6 (maker of calculate cannot approve) — not representable (X-6).
- ADR-070 §19.1/§19.2 fully testable only once the effective-compensation rule and calendar policy exist (X-11).
- ADR-072 §19.3 "exactly one balanced journal… crediting wages_payable" is testable but its amount basis is undefined (X-8).
- ADR-070 §16 disbursement entry cannot be tested until the event/contract exists (X-7).

### 3.4 Proposed amendments (NOT applied; for CTO to approve as a set)
A-1 define commission period attribution + carry-forward rule (X-1); A-2 add one-time-consumption invariant with DB-level uniqueness (X-2); A-3 define how Commission/Payroll adjustments become run inputs (X-3); A-4 reconcile `recalculation` with the per-period run rule (X-4); A-5 define or delete `populationScope` (X-5); A-6 restate SoD in terms of recorded actors per stage and FA-01 capabilities (X-6); A-7 specify the disbursement event and posting (X-7, with Treasury/Accounting review); A-8 state the posting amount basis after H0-4/DEC-04 (X-8); A-9 define rejection path and period lifecycle (X-9, X-16); A-10 ratify or reject deviations X-10, X-13, X-18; A-11 resolve `net_sales`/`customer_group` (X-14, X-15).
**Recommendation:** approve ADR-070/071/072 **only after** amendments A-1…A-9 are written as an addendum to each ADR (new content, never rewriting existing text), then adopt C16.

---

## 4. Phase 1 — Baseline Verification (HR & Attendance), static + recorded

| Area | Demonstrably implemented (INSPECTED in code) | Executed-test evidence | Documentation-only | Defect / gap | Safe to consume downstream |
|---|---|---|---|---|---|
| HR identity & lifecycle | `Employee`, status history, terminate (own node), manager, numbering; `hr.service.ts` | **NOT RUN** now. RECORDED: `hr-phase1.spec.ts` (written; 2026-09-19 pass claim), `hr.company-isolation.spec.ts` (6 cases written) | "CLOSED/PASS" claims in later ADRs; primary report not located | `linkUser` lacks membership check (G-09); leave request for any employee (G-10); no unlink | `getEmployee`, `listEmployees`, `getEmployeeByUserId`, `isApprovedLeaveDate` (read-only) |
| HR ↔ User | `userId` unique, manual link (D2) | NOT RUN | — | Cross-company link possible; platform user directory used by UI | Read side yes; write side needs Gate B-1 |
| HR authorization | nodes + guards on every route; company context via membership | NOT RUN (isolation spec written) | — | Module-wide role templates; no Self/Team scope | Only with the scope fix |
| Attendance facts | import (Excel + biometric daily summary), mapping, derive-day (`present/absent/on_leave/missing_punch`), batches + FA-01, corrections (direct vs FA-01 after approval) | NOT RUN. RECORDED: `attendance-phase1.spec.ts` 12/12 (2026-09-19), biometric import spec, isolation spec | ADR-069 closure | Day boundary by UTC (DEC-06); no calendar; absent-day rows exist only if a punch/fact was ingested | `listApprovedDaysByBatch` (read-only) |
| Payroll handoff contract | read via approved batches overlapping the period; classification copied per day | NOT RUN (Payroll specs written) | ADR-069 §5/§10 | event not used (X-18); coverage not checked | Yes for approved facts; coverage rule pending H0-2 |
| Approval/correction history | FA-01 requests + `AttendanceCorrectionRequest`; audit on writes | NOT RUN | — | reads not audited | Yes |

**What must remain unchanged (protected):** Employee identity/lifecycle semantics, D1–D4, `AttendanceDay` statuses (4 values), batch/FA-01 correction rule (§8:C), approved-batch protection in `deriveDay`, one-directional dependencies.
**Regressions found (reproducible evidence):** none by execution (nothing was run). Static defects with file/line evidence: G-09, G-10 (HR); DEC-06 day-boundary (`attendance.service.ts:642-683`) — all already in the register; no new defect was discovered in HR/Attendance that contradicts a Closed decision.

**Gate 1 verdict:** baseline = **RECORDED, INSPECTED, NOT RE-EXECUTED.** Re-execution on a clean isolated cluster is the first evidence task (see §6, task T-1).

---

## 5. Authorization boundary and first executable gate

**Boundary (what is permitted until each decision lands):**
- Now (existing authorization): read-only inspection, evidence collection, documentation, test/gap planning.
- Needs CTO adoption of **C16** + approval of amendments A-1…A-9 + a separate written authorization: anything in `payroll`, `commission`, `targets`, `attendance`, Treasury/Accounting contracts.
- Needs only an explicit authorization naming it (not C16): **Gate B-1** (HR-local identity-link hardening, `backend/src/domains/hr/**` + `HrEmployees.tsx`), because it touches ADR-059 code only — pending CTO confirmation of that interpretation (closure report C-7).
- Never under this directive: merges, releases, deployments, production data, shared-contract changes, migrations without separate authorization.

**Directive phases ↔ earlier gates**

| Directive phase | Maps to | Prerequisite status |
|---|---|---|
| 0 Foundation | this report | **Complete as analysis; awaiting CTO decisions** |
| 1 Baseline | §4 + T-1 | Static done; execution NOT RUN |
| 2 Payroll Core | Gates C, D, E | Blocked (R-1, R-6, R-8–R-12) |
| 3 Commission | Gate F | Blocked (R-1, R-7, X-1…X-3) |
| 4 Integrated E2E | Gate G / ADR-072 | Blocked; 12 mandatory scenarios listed in directive §6 are the acceptance set |
| 5 UX | UX gate | After functional gates; includes AR/EN/RTL/responsive |
| 6 Regression & release readiness | Gate G | After 2–5 |

**Reframing note (needs CTO confirmation):** the directive's Phase 2/3 say "implement". Payroll/Commission **already exist in code**. Executing those phases as greenfield would duplicate or overwrite unaudited behaviour. Proposed reading: Phase 2/3 = **gap closure of the existing implementation against the approved (amended) contracts**, not re-implementation.

**First executable gate: B-1** — scope, acceptance (10 criteria), stop and rollback conditions exactly as in `HR_PAYROLL_STAGE1_DECISION_CLOSURE_REPORT_2026-10-25.md` §7. Additional baseline precondition from this report: **T-1** (execute HR + Attendance suites on an isolated cluster at the current HEAD and record PASS/FAIL) before changing HR code.

---

## 6. Evidence status and open tasks

| Check | Status |
|---|---|
| Authoritative statuses verified against records | **INSPECTED** (done) |
| ADR-070/071/072 coherence review | **INSPECTED** (done; 20 findings) |
| HR regression suite | **NOT RUN** |
| Attendance regression suite | **NOT RUN** |
| Payroll / Commission suites | **NOT RUN** |
| Integrated E2E (ADR-072) | **NOT RUN** (last recorded: 4/4 on 2026-09-21, then BLOCKED by regression; current state unknown) |
| Build / type check / lint | **NOT RUN** |
| UX (AR/EN, RTL/LTR, responsive) | **NOT RUN** |
| Security/authorization tests (API-level bypass) | **NOT RUN** (no such tests exist yet) |

Why not run: the worktree has no `node_modules`; the shared one is junction-linked and a rebuild once wiped it (known incident); an isolated PostgreSQL cluster must be started from the main tree and its use is not covered by this directive's authorization. Request: authorize **T-1** on the isolated cluster only.

**Progress ledger**
| Item | State |
|---|---|
| Audit (`a371475`), Pack v1/v2, Closure report | Delivered, on branch `docs/hr-payroll-integration-audit` |
| C16 S2 text | Delivered as PROPOSED in register; awaiting adoption |
| Phase 0 register + contract review (this doc) | Delivered |
| Phase 1 baseline | Static only; T-1 pending authorization |
| Next authorized action | none beyond documentation; STOP |

---

## 7. Decisions needed from CTO to unblock (minimal set)

1. **Adopt C16** (S1/S2/S3) — recorded in the register.
2. **Approve amendments A-1…A-9** as addenda (or amend them) so ADR-070/071/072 can be approved as one coherent package.
3. **Confirm** Gate B-1 sits outside the C16 freeze (ADR-059 code only) and authorize it separately, including **T-1** on an isolated cluster.
4. **Confirm the reframing** of directive Phases 2–3 as gap closure of existing code.
5. Name owners/dates for the policy decisions (calendar/time, accrual & posting, disbursement/reversal, commission timing & channel) — see closure report §8.

STOP CONDITION reached (directive §2): C16 adoption, contract approval and implementation authorization are pending. No implementation was started.
