# DAII — Independent Product Audit Report (Team 3) — 2026-10-11

> **Addendum notice (WP-DOC-02, 2026-10-11).** This document was committed in `2c6ccf3`; its original text is **unchanged**. Evidence that arrived after the audit cutoff `b591d1f`, and the separate finding PA-43, are recorded in the final section titled "Addendum". Where the original and the addendum differ, both are kept: the original describes the state at the cutoff, the addendum the state at `49cc7d5`.

Deliverable 1 of 6 for directive DAII-TP3-AUDIT-01 and the follow-up request "Final Product Audit Report & Roadmap Inputs". Team 3 is independent and read-only: no product code, schema, UI, permission or configuration was changed; no production or hosting access was used; no credential was read or reproduced; no database-backed test was run by Team 3 (the isolated cluster is reserved by other sessions), so every test result below comes from an existing report and names its commit and evidence class.

**Deliverables (all in `backend/docs/decisions/`):**
1. `DAII-INDEPENDENT-PRODUCT-AUDIT-REPORT-2026-10-11.md` (this file)
2. `DAII-PRODUCT-CAPABILITY-MATRIX-2026-10-11.md` — 88 rows, two classification axes
3. `DAII-PRODUCT-RISK-AND-TECHNICAL-DEBT-REGISTER-2026-10-11.md` — 42 findings `PA-01…PA-42`, ranked, each with the mandatory fields
4. `DAII-STRATEGIC-ROADMAP-INPUT-2026-10-11.md`
5. `DAII-QUALITY-SCORECARD-2026-10-11.md`
6. `DAII-HR-ACCOUNTING-INTEGRATION-ASSESSMENT-2026-10-11.md`

| Baseline item | Value |
|---|---|
| **Audit cutoff** | 2026-10-11; repository HEAD `b591d1f` (branch `master`) |
| **Evidence baseline** | `a6002fa` — last commit with complete clean-snapshot verification (clean `git archive`, pinned evidence headers, `dirtyPaths: []`) |
| **Delta** | After `a6002fa`, product source changed only in the N-02 `fulfillReservation` fix (`a798d9d`, `b591d1f`) and LA-1 Layer 2 admission (`60b9bdf`) with their specs; the delta has no complete clean-snapshot verification (PA-42) |
| History | 200+ commits, one committer identity ("DAII Workspace"), starting 2026-09-18 |
| Working tree | Other tracks' untracked release zips and `.err` files; not read as evidence |

---

## 1. Executive summary

**What DAII is.** A modular-monolith ERP (NestJS, TypeORM, PostgreSQL; database-per-Company; about 81 k lines of production TypeScript, 288 forward-only migrations, 75 controllers / 616 routes, 23 business domains on 38 platform capabilities, 212 specs, 50 ADRs) with a React/Vite frontend (164 `.tsx` files), built to a written charter (ADR-053: one integrated ERP, never independent modules). The structure honours the charter: published inter-module contracts, one financial event path to the ledger, one approval engine, one process engine, one audit chain.

**State in one paragraph.** The money and stock primitives are unusually well verified (clean snapshot `a6002fa`: treasury cannot overdraw, stock cannot oversell, returns cannot exceed capacity, valuation and sub-ledgers reconcile, numbering and transitions are safe under the tested concurrency). The product is **not yet** a complete, verified ERP: five required steps are absent from the scenarios audited, the HR-to-Accounting seam does not reconcile to the ledger, the frontend has no automated tests, and release, hosting, capacity and dependency remediation are unverified or unaccepted. Overall release approval stands at **NOT APPROVED**.

### 1.1 Highest-priority findings (full records in the register)
| # | Finding | Why it ranks here | Nature |
|---|---|---|---|
| 1 | **PA-33** A rolled-back transaction that wrote an audit record permanently breaks hash-chain verification | New; the tamper-evidence control becomes unverifiable after any ordinary failure inside an outer transaction | Confirmed by test (working-tree class) |
| 2 | **PA-34** Payroll disbursement posts no GL entry (`cashOutForEmployee` is `NO_EMIT`, `disburse` publishes nothing) | Wages Payable is never cleared and the GL bank is never credited; statements wrong from the first payroll | Confirmed by reading; runtime effect inferred |
| 3 | **PA-35** The payroll GL entry posts gross pay only; commission is paid in cash but never recognised | Payroll cost understated; ledger cannot reconcile to treasury | Confirmed by reading |
| 4 | **PA-16** No overtime, tax, insurance or payslip | The payroll lifecycle is complete for gross pay, not statutory payroll | Missing capability |
| 5 | **PA-26 / PA-25 / PA-24** Release NOT APPROVED, 65 dependency advisories, capacity NOT CLASSIFIED | Release gates | Evidence gaps / debt |
| 6 | **PA-23 / PA-03 / PA-17** No frontend tests; no order-to-cash chain test; the integrated payroll E2E is BLOCKED | The seams and the UI are the least verified part | Evidence gaps |
| 7 | **PA-01 / PA-08 / PA-09** No sales-order cancellation, no supplier return, no bank-statement matching | Required steps of three audited scenarios | Missing capabilities |
| 8 | **PA-21 / PA-04 / PA-05 / PA-13** Concurrency primitives: N-01 passes on a clean snapshot (closure recorded locally, sign-off pending); the reservation double-dispatch is fixed in code but not independently reviewed; limit overshoot and reservation over-release are open; the GL deadlock is mitigated by retry only | The same defect class produced four P0 defects earlier | Mixed |

**Does the architecture support the roadmap?** Yes, with conditions. No finding requires a rewrite. Phase 1 (HR and Accounting) extends existing structures; the conditions are about verification capacity and about four decisions only the CTO can take (statutory payroll policy, disbursement and commission accounting shape, year-end approach, business-date rule).

**Position on N-01 and N-02.** Team 3 declares neither closed. N-01: the implementing session recorded "CLOSED for the local scope" (`b5dcece`, N-01 report §7) with CTO sign-off pending and explicit exclusions (hosting, multi-instance, N-02); the reviewer is the author of the changed code, the test evidence came from the verification session. N-02: "NOT CLOSED" by its own report; only the reservation-fulfil part is remediated.

**Categorical overall assessment (no numeric score; see scorecard):** continued internal development **READY**; Phase 1 HR and Accounting **READY WITH CONDITIONS** (§11); external technical or commercial evaluation **NOT READY**; production/hosting **NOT ASSESSED**, release **NOT APPROVED**. The 9.5/10 ambition is a target, not a claim: no agreed rating method exists (scorecard §7).

---

## 2. Scope, method, snapshot and evidence base

### 2.1 Evidence classes and the no-merge rule
| Class | Meaning | Example |
|---|---|---|
| Clean-snapshot test | `git archive` of a named commit, `dist` rebuilt, evidence header with `dirtyPaths: []` | business suite on `a6002fa` |
| Working-tree test (WT) | HEAD at run time plus uncommitted files of other tracks — historical, not a verification of the commit alone | T-21/T-22 runs; earlier T-00…T-17 |
| Dated manual walkthrough | `MASTER_PROJECT_STATUS.md`, last reconciled 2026-08-24, no commit tie | August live order-to-cash |
| Static reading by Team 3 | source files read at HEAD with file and line cited | state machines, handlers, payroll |
| First-hand | this author's earlier sessions (Manufacturing, WIP, F03 RCA, integrated E2E): `3b5c634`, `246d718`, `7079eae`, `b5a9a85`, `24082d6`, `9da2e54` | working-tree class |
Evidence from different classes or commits is never added together.

### 2.2 What was read
Governing and status documents (`MASTER_PROJECT_STATUS.md`, ADR-053 and the charter, ADR-067/068/070/071/072, the ERP audit closure report, D5 record); the TEST-03 reports (valuation readiness, architecture graph, N-01, N-02 probes, dependency audit D-01, status record, capability matrix); the verification program reports (closure and release decision, commit-and-evidence reconciliation, N-02 fulfil-reservation remediation, T-plan); the LA-1 record; process definitions; the Financial Event handler map; payroll, commission, attendance, HR, targets, treasury, fiscal-period, financial-reporting, journal, cash-bank sources; the frontend package scripts and page tree. A negative search result is marked as such; it is exact for state-machine actions and approximate for concepts.

### 2.3 What was not done
No database-backed test, browser session, hosting or production access, performance measurement, vendor documentation lookup or network call. Items needing a runtime demonstration are labelled CONFIRMED-BY-READING in the register.

---

## 3. Capability inventory (scope A)

Full inventory: `DAII-PRODUCT-CAPABILITY-MATRIX-2026-10-11.md` — 88 rows, each with an **Implementation** class (Implemented / Partial / Specified, not implemented / Not implemented) and a **Verification** class (Verified / Partly / Unverified / Blocked / Not assessed), with cited evidence and finding IDs.

| Implementation class | Rows | | Verification class | Rows |
|---|---|---|---|---|
| Implemented | 60 | | Verified | 5 |
| Partial | 7 | | Partly | 53 |
| Specified, not implemented | 12 | | Unverified | 6 |
| Not implemented | 9 | | Blocked | 1 |
| | | | Not assessed | 23 |

Implemented **and** Verified (5): company isolation, treasury balance integrity, customer-return capacity, stock integrity, moving-average valuation — each only for the scenarios written in its row. The audit hash chain is no longer in that set after PA-33. Blocked: the integrated Attendance→Payroll→Commission→GL scenario.

---

## 4. End-to-end business scenario audit (scope B)

### 4.1 Quote-to-cash
| Step | Implementation | Evidence |
|---|---|---|
| Quotation | **Absent** (PA-02) | — |
| Order entry, pricing | Sales order, price lists | entity creation 80/80 and HTTP customers 120/120 CS:`a6002fa`; order lifecycle read |
| Approvals | submit → supervisor review → manager approval; reject/resubmit; open-account fast path | state machines read |
| Deposit | submission/verification; `deposit.verified` → GL | handler read; one spec |
| Release, reservation | 24-hour preliminary hold with expiry to draft | scheduler in the LA-1 delta |
| Fulfilment, shipment, delivery | pick/pack/review; RSH, waybill, carrier, vehicle custody; delivery fulfils reservation | isolation specs; `DOC`; double-dispatch fixed in code, implementing-track tests only (PA-04) |
| COGS | `inventory.movement.recorded` → Dr COGS / Cr Inventory at moving average | T-01/T-03/T-10 CS:`a6002fa` |
| Invoice | draft → post (`finance.invoice.posted`) → void | handler read |
| Payment | idempotent, on-account, over-application rejected, COD collection/remittance | T-06/T-08 CS:`a6002fa` |
| Cancellation | **Absent after submission** (PA-01) | state machine read |
**Verdict:** Implemented; verification Partly. The chain is complete except quotation and cancellation, but no automated test spans it (PA-03).

### 4.2 Procure-to-pay
PR → RFQ → supplier quotations → award → PO (approval, cancel, partial/full receipt) → goods receipt with GRNI → supplier invoice with PPV and input VAT → supplier payment → supplier ledger and aging. Evidence: 11 procurement isolation specs; D5/D6/D7 closures; creation 80/80 for suppliers (CS:`a6002fa`). **Absent:** supplier return (PA-08). **Adjacent debt:** AP debit/credit notes default to account `5299`, recorded as not an approved policy (PA-39). **Verdict:** Implemented; Partly verified; one required capability missing.

### 4.3 Inventory flows
Receipts, issues, transfers, adjustments, counts with approvals; reservations; restock from returns; WIP sub-warehouses; moving-average valuation. **Verified (CS:`a6002fa`):** no oversell, exact on-hand, valuation reconciled; movement scope contract (T-09). **Open:** reservation release and limit races (PA-05); fulfilment double dispatch fixed in code (PA-04); shipment transitions never probed; no lot/serial (PA-06); single costing method (PA-07). **Verdict:** Implemented; strongest evidence in the platform for its core properties.

### 4.4 Treasury and bank
Accounts, cash in/out, two-leg transfers, limits, collection settlement, adjustments, GL-to-treasury reconciliation. **Verified:** no overdraw, exact balances (T-05/T-14/T-16 CS:`a6002fa`). **Missing:** bank-statement import and matching (PA-09). **Seam defect:** payroll cash-out posts no GL entry (PA-34). **Verdict:** Verified for balance integrity; Partial for bank reconciliation.

### 4.5 Returns
Customer returns (customer and custody origins), inspection, disposition, credit, application to invoice, contra-revenue accounting. **Verified:** concurrent over-return capacity (T-07 CS:`a6002fa`). Supplier returns absent (PA-08). **Verdict:** customer side Verified for capacity, Partly otherwise; supplier side not implemented.

### 4.6 Cancel and reactivate
| Document | Cancel / void | Reactivate |
|---|---|---|
| Sales order | none after submission; draft delete only (PA-01) | none |
| Purchase order | draft, submitted, approved → cancelled | none |
| Work order | draft, released → cancelled | none |
| Sales invoice | draft cancel; posted void with event | none |
| Supplier invoice | void with reversal event | none |
| Journal entry | one reversal; a reversal cannot be reversed | n/a |
| Fiscal period | close and reopen through approvals | reopen |
| Company, user, GL account, product, routing | lifecycle with reactivation | yes |
The absence of reactivation on transactional documents is a policy-level choice not written down in the reviewed documents. **Verdict:** Partial; the sales-order gap is material.

### 4.7 Period-end closing
Fiscal years/periods; closing-audit preview with exception classes; close/reopen through approvals; signed immutable snapshots with recovery; sub-ledger reconciliations (AR, AP, GRNI, inventory, WIP, fixed assets, cash/bank). WIP split from Inventory (`3b5c634`, first-hand). **Missing:** year-end closing entries (PA-10); payroll and wages-payable not part of reconciliations or closing audit (integration assessment I-13). **Verdict:** Implemented; Partly verified; year-end entries Specified, not implemented.

### 4.8 Payroll lifecycle
See the integration assessment. Period → attendance (informational) → compensation → calculate → review → approval → automatic posting event → GL (gross only) → human disbursement → treasury (no GL leg) → adjustments. **Missing:** statutory computation, payslip (PA-16); ledger agreement (PA-34/35/36). **Verdict:** Partial; end-to-end proof BLOCKED (PA-17).

### 4.9 Company onboarding and membership
Control-plane Company registry, database allocation/provisioning, per-tag migrations, default administrator, invitations, membership provisioning and reconciliation, roles with anti-elevation, entitlement and module provisioning, activation, support access. **Evidence:** a fresh Company created through the real API verified for journal numbering and event posting (2026-10-06 closure); WP-0.4 closed; F1–F6 reports. **Not verified in this program:** 19 real-Postgres provisioning, pool, fan-out, restore and registry specs NOT RUN, one BLOCKED (PA-22); LA-1 Layer 2 covers 3 of 10 sites (PA-41). **Verdict:** Implemented; Partly verified.

### 4.10 Integrations
Partner order-intake endpoint with its own machine credential; one store connector; product mappings; sync logs; attendance and biometric imports; Excel import/export. **Gaps:** single connector; tenancy mismatch D-03 (T-18 FAIL-DEFECT); no spec by name; upload-path dependency advisories; no e-invoicing. **Verdict:** Partial (PA-20, PA-15, PA-25).

---

## 5. Accounting and financial integrity (scope C)

| Property | Finding | Evidence | Status |
|---|---|---|---|
| Double entry | Unbalanced journals rejected with totals; reports check `debitBase = creditBase` in SQL `NUMERIC` | `journal-entry.service.ts:426`, `ledger.service.ts:191` | READ |
| Money arithmetic | Decimal strings with `decimal.js` and explicit rounding in accounting; **payroll uses JavaScript floats** (PA-36) | `domain/money.ts`; `payroll.service.ts` | READ |
| Posting gate | Every posting calls `assertOpenForPosting` | `journal-entry.service.ts:352` | READ |
| One path to the ledger | Operational modules publish events; handlers produce drafts; the engine posts | handler map (16 event types) | READ |
| Event idempotency and ordering | Processed-event service, outbox retries ≤ 5; F03 deadlock retried ≤ 3 (`9c746aa`) | code; RCA | Partly (PA-13) |
| Sub-ledger to GL agreement | R1–R10: AR, AP, GRNI, inventory, treasury, payments, valuation. **Payroll is not covered** | T-10 PASS CS:`a6002fa` | Verified for covered flows |
| Payroll to GL | Posting excludes commission; disbursement posts nothing (PA-34, PA-35) | code | CONFIRMED-BY-READING |
| Reversal and immutability | One reversal per entry; signed snapshots; audit chain **breaks after a rolled-back audit write** (PA-33) | code; T-22 WT | Partly |
| Control accounts | Function-based resolution; policy config keys; **adjustment handlers fall back to literal `5299`** (PA-39) | handlers | READ |
| Cost accounting | Moving average; WIP per work order; material issue/return/finished goods events | ADR-060/061; `FH` Phase 3 E2E WT:`7079eae` | Partly |
| Statements | TB, BS, P&L, cash flow with exports; **no golden fixtures** (PA-32) | services read | Unverified numerics |
| Year-end | Status lock only (PA-10) | code | Specified, not implemented |
| FX | Rates and line snapshots only (PA-11) | code | Partial |
| Tax | Codes, calculation engine, VAT on documents, period summary; no e-invoicing (PA-15) | code | Partly |
| Business dates | UTC in sub-ledger path; other conventions elsewhere (PA-14) | `3ef67f4` | Partly |
**Assessment.** The integrity design is sound and verified at primitive and reconciliation level for the flows the oracle covers. The ledger-correctness risks that matter before an accountant would accept the product are concentrated at the payroll seam (PA-34/35/36), the audit-chain rollback defect (PA-33), year-end structure (PA-10) and unvalidated statements (PA-32). None requires redesign.

---

## 6. Multi-company architecture and authorization (scope D)

The approved company-scoped authorization model is a **constraint**; nothing here proposes changing it.
- **Isolation by construction.** One database per Company; `CompanyContextGuard` attaches the connection; controllers receive `req.companyContext.dataSource.manager`; a platform guard separates control-plane access; support access is time-boxed. Tenant isolation is the best-evidenced property after money integrity (80 isolation specs PASS; two-Company business suite and HTTP run, CS:`a6002fa`).
- **Layers.** JWT → permission decorators (378 on 616 routes) → membership/role (anti-elevation, last-admin, risk-aware) → workflow rules → warehouse-keyed scope. F1–F6 committed with phase reports.
- **Residuals.** F-INV-001 compatibility (410) unapproved, D-9 blocked; four JWT controllers without Company/platform guard (inferred, hand review pending); pending CTO items (PA-29). Integrations tenancy mismatch (PA-20). **LA-1 Layer 2 covers 3 of 10 background/provisioning sites; seven are blocked by files owned by other tracks, so a path that opens a Company DataSource without admission still exists** (PA-41).
- **Operational multi-tenancy.** Pool, fan-out, restore and provisioning behaviour largely unverified (PA-22); per-tenant capacity unmeasured (PA-24); no consolidation (PA-12).
**Assessment.** The model is coherent and defended where tests exist. The remaining risk is verification coverage of the lifecycle machinery and the unfinished admission rollout.

---

## 7. Architecture and scalability (scope E)

| Category | Findings |
|---|---|
| Confirmed defects | PA-33 (tested), PA-13 (tested, mitigated), PA-05 (tested), PA-20 (tested), PA-04 (tested, fixed in code), PA-34/35/36/37/39/41/10 (by reading) |
| Suspected risks | PA-14, PA-18, PA-38 |
| Missing capabilities | PA-01, 02, 06, 07, 08, 09, 11, 12, 15, 16, 19, 31, 40 |
| Evidence gaps | PA-03, 17, 21, 22, 23, 24, 26, 29, 30, 32, 42 |
| Technical debt | PA-25, PA-27, PA-28 |
**Structure.** A modular monolith is defensible for the roadmap: one deployable, strict TypeScript, domain/application/infrastructure/interface layering, 11 published contracts. Coupling debt is concentrated: 19 concrete cross-domain service imports invisible to the lint rule (seven are inside the HR/payroll chain), 21 registry inversions, one strongly connected component of 44 of 64 modules, five services over 1,000 lines (PA-28). None blocks Phase 1; opportunistic contract extraction when a change touches an edge is cheaper than a campaign.
**Scalability.** Single Node process per instance, database-per-Company. Measured (T-16, 2-core laptop): plateau ~31–39 req/s from five users, one core saturated, p95 345 ms → 3.8 s at 50 users, 0 errors, immediate recovery (PA-24). That describes the test machine, not the product; no target exists. Unknowns that decide scalability: pool behaviour with many Company databases, outbox backlog at 3×/10×, two-instance scheduler behaviour, memory growth, cost of per-request routing. They are listed as closure criteria, not asserted problems.

---

## 8. Quality engineering and operational readiness (scope F)

| Area | Position | Evidence |
|---|---|---|
| Test strategy | Strong where purpose-built: guarded cluster, frozen T-plan with hashes, oracle R1–R10, concurrent reproducers, clean-snapshot attribution | verification program |
| Test effectiveness | Poor before the program: four P0 defects survived 120 database-backed specs (Q-01); the same class remains in N-02 and now PA-33 | TEST-03 §6; N-02 report |
| Chains | No automated order-to-cash chain (PA-03); payroll chain BLOCKED (PA-17) | spec names |
| Frontend | No automated tests (PA-23) | `frontend/package.json` |
| Unit / guard | 59 suites / 430 tests; guard 50/50 on `a6002fa` | reconciliation §4 |
| Real-PG coverage | 80 PASS, 1 BLOCKED, 19 NOT RUN (PA-22) | verification report |
| CI | Committed; seven steps PASS locally; never on a hosted runner; no real-PG job | status record |
| Delta after `a6002fa` | No complete clean-snapshot verification (PA-42) | N-02 report §5 |
| Security | App-level controls good; 65 advisories (PA-25); host hardening unverified | D-01 |
| Release/deploy | Release engine exists; 1.1.4 incident, 1.1.6 cut-off; **NOT APPROVED** (PA-26) | incident review |
| Backup/restore | Procedure drilled on a dev DB (2026-08); product restore not exercised (PA-30) | status file |
| Documentation | 50 ADRs, runbooks; master status file stale (PA-27) | file headers |

---

## 9. Gap register summary (scope G)

Full ranked register: 42 findings. Severity: **High 12** (PA-33, 34, 35, 16, 26, 25, 23, 24, 01, 03, 17, 21); **Medium–High 6** (PA-13, 14, 08, 09, 29, 41); **Medium 20**; **Low–Medium 1**; **Low 3**. By nature: missing capability 13, evidence gap 11, confirmed by reading 7, confirmed by test 5, debt 3, suspected 3. No finding is rated Critical because Team 3 has no evidence of loss in a deployed environment.

| Disposition | Findings |
|---|---|
| Implemented — needs verification | PA-03, 04, 05, 13, 14, 17, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33, 34, 35, 36, 38, 39, 42 |
| Partially implemented | PA-10, 11, 16, 18, 20, 37, 41 |
| Missing but required | PA-01, 08, 09, 40 |
| Proposed enhancement | PA-02, 06, 07, 12, 15 (requirement unconfirmed) |
| Out of scope for current phases | PA-19, 31 |

---

## 10. Independent benchmarking (scope H)

Reference points: mature mid-market ERPs commonly used as benchmarks. General product knowledge only; **no vendor documentation was consulted, no feature-by-feature check was done and no parity claim is made.**

| Scenario | What mature reference ERPs typically offer | DAII position | Parity claim |
|---|---|---|---|
| Quote-to-cash | Quotation → order → delivery → invoice → payment with cancellation and credit control | Order-to-cash present; no quotation (PA-02) or cancellation (PA-01) | None |
| Procure-to-pay | PR/RFQ/PO/receipt/invoice with matching, vendor returns, landed cost | Through payment; matching and GRNI/PPV; no vendor returns (PA-08) | None |
| Inventory | Multi-warehouse, lot/serial, valuation methods, counts, reorder | Multi-warehouse, counts, moving average; no lot/serial, one method | None |
| Treasury/bank | Statement import and matching, payment runs | Accounts, transfers, limits; no matching (PA-09) | None |
| Accounting | FX revaluation, year-end closing, budgets, consolidation, local e-invoicing | Strong core; PA-10, 11, 12, 15 | None |
| Manufacturing | BOM, routing, orders, costing, MRP, capacity | BOM, routing, work orders, WIP costing; no planning (PA-31) | None |
| HR/payroll | Employees, attendance, leave balances, payroll with local statutory rules, payslips | Employees, leave requests, attendance, gross-pay payroll; no statutory rules or payslips (PA-16, 40) | None |
| Platform | RBAC, approvals, audit, workflow, multi-company, SaaS operations | Distinct strengths: database-per-Company, hash-chained audit (with PA-33), maker–checker, reconciliation discipline; weaker: notifications, UI test depth | None |
The platform is comparable in ambition to the reference class and better evidenced than many early ERPs; functional breadth is narrower and localisation depth unverified. The shortest route to credible parity in HR and Accounting is depth on the existing spine.

---

## 11. Prioritisation and roadmap implications

Detailed input: `DAII-STRATEGIC-ROADMAP-INPUT-2026-10-11.md`; HR scope: the integration assessment §7. Summary:
1. **Finish the current foundation and verification phase** — N-01 sign-off, N-02 authorisation and independent review, the PA-33 decision, a clean-snapshot pipeline for the delta, F03 re-check, Commission regression re-run, the 19 unrun specs, hosted CI, dependency T1.
2. **Phase 0 (planning only)** — HR and Manufacturing contracts (statutory payroll, disbursement/commission accounting shape, calendar, HR master; planning/MRP boundary, costing, traceability). No implementation.
3. **Phase 1 — HR and Accounting**, each implemented, tested end to end and internally approved: ledger correctness of the payroll seam first; then statutory computation and HR master; year-end, bank matching, statement fixtures, enabling items (sales-order cancellation, supplier return).
4. **Phase 2** — remaining roadmap after the Phase 1 gate, with mandatory security, data-integrity and independent-verification gates.
5. **No rewrite recommended.** Gate conditions proposed in the roadmap input §5.4.

---

## 12. Limitations, unresolved questions and consistency attestation

### 12.1 Limitations
Static reading and existing reports only; no new test execution; no browser; no hosting; benchmark from general knowledge; absence claims exact for state machines, approximate for concepts; first-hand evidence is working-tree class; the Commission fix status and the F03-after-N-01 interaction are unverified; legal and jurisdictional requirements unknown; the requirement for lot/serial, FIFO, quotations and e-invoicing is not confirmed by any reviewed document; CONFIRMED-BY-READING items await a runtime demonstration.

### 12.2 Unresolved questions (need investigation or a CTO decision; none is presented as a conclusion)
1. N-01: sign-off on the local-scope closure recorded at `b5dcece`, and acceptance of the by-construction argument for unprobed call sites.
2. N-02: authorisation for H1/H2/H4/H5 remediation; independent review of the fulfil-reservation fix; clean-snapshot pipeline for the delta.
3. PA-33: authorise the audit-chain fix? repair existing chains or only prevent new breaks?
4. Payroll accounting: is the intended shape gross-plus-commission at posting and `Dr Wages Payable / Cr Bank` at disbursement? Was `NO_EMIT` intended? Which account carries commission expense?
5. Statutory payroll: jurisdiction, rules, rate-table owner; absence/leave/lateness pay rules; holiday calendar ownership.
6. Business-date rule (UTC or Cairo); has the Commission regression been re-run clean since `f2d15fa`?
7. F03: Option A (lock order) or permanent acceptance of retry?
8. Sales-order cancellation policy and deposit treatment; commission reversal policy; supplier-return accounting.
9. Year-end approach (derived equity vs closing entries); FX revaluation need; AP/AR adjustment accounts policy (`5299`).
10. Requirement confirmations: quotation, lot/serial, FIFO/standard, e-invoicing jurisdiction, contracts/documents in Phase 1.
11. Guard decision for the 19 unrun specs; capacity targets and a staging host; F-INV-001 operator; Integrations tenancy option; seven unwired LA-1 sites; duplicate-tree removal.
12. Adopt the capability matrix as the living Coverage Matrix; reconcile or retire the stale master status file.

### 12.3 Internal consistency check across the six deliverables
Performed by script and reading on 2026-10-11 (results repeated in the roadmap input §9 and scorecard §8): every `PA-xx` cited in any deliverable exists in the register (42, extraction checked); the matrix counts quoted here (88 rows: 60/7/12/9 and 5/53/6/1/23) are computed from its tables; every document names the audit cutoff `b591d1f` and the evidence baseline `a6002fa`; N-01 and N-02 are carried identically; only the matrix's defined classes appear as capability classes; no capability is called verified on the strength of documents, menu items, entities or a typecheck.

## 13. Addendum — state after the audit cutoff (WP-DOC-02, 2026-10-11)

Sections 1–12 are preserved unchanged. Reference commit: `49cc7d5cb639cd492823a803019758fd2abe216e`. Details are in the register §6, the matrix §8, the scorecard §9 and the reconciliation note §7.

1. **New finding PA-43** (UUID repair may invalidate historical audit hash chains): code-review finding, OPEN, separate from PA-33; the repair is not run and no historical audit row is touched.
2. **Evidence after the cutoff:** the PA-33 fix (`c764fc5`) and the remaining N-02 fixes (`5c5b791`) are committed and verified on clean snapshots `71e5f5e` and `f881e53` for the scenarios run; independent review is **not** accepted (the CTO ruled the peer reviews do not meet the independence gate); N-02 OPEN, PA-33 OPEN.
3. **Isolation population:** three historical states are kept (80/1/19; 90/9/1 corrected to 89 executed-PASS/1 skipped/9 BLOCKED/1 NOT RUN; and a clean-snapshot run of 91 files). Six adaptation diffs remain pending review.
4. **CI:** NOT GREEN (3 lint errors in LA-1 files, owner LA-1; not attributed to N-02).
5. **Unchanged:** release status NOT APPROVED; no numeric quality score; the planning baseline is in the execution plan, the work-package register and the decisions brief.
