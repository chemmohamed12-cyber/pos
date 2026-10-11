# DAII — Strategic Roadmap Input (Team 3 Independent Product Audit) — 2026-10-11

Deliverable 4 of 6. **Input for CTO decision. Not a plan of record, not an authorisation, not a schedule.** Team 3 does not assign work, set dates or begin implementation. Evidence comes from the audit report, capability matrix and register (`PA-xx` IDs); the HR work packages are detailed in `DAII-HR-ACCOUNTING-INTEGRATION-ASSESSMENT-2026-10-11.md` (`HRX-n`).

**Baseline.** Audit cutoff 2026-10-11, HEAD `b591d1f`; evidence baseline `a6002fa` (last complete clean-snapshot verification); the delta between them (N-02 fulfil fix, LA-1 Layer 2) has no complete clean-snapshot verification (PA-42).

## 1. Constraints this input preserves

| Constraint | How it is respected |
|---|---|
| Current foundation and verification phase continues | §3 lists the evidence and decision items that finish it |
| **Phase 0** — architecture and contract planning for **HR and Manufacturing only**, no implementation | §4: decisions and contracts only; no code, schema, migration, UI or configuration change |
| **Phase 1** — completion and verification of **HR and Accounting**, then internal acceptance | §5: work packages, entry/exit criteria, gate |
| **Phase 2** — the remaining ERP roadmap after Phase 1 acceptance, retaining security, data-integrity and independent-verification gates | §6: ordered backlog; the gates in §5.4 and §7 continue to apply |
| Build on the existing architecture and approved decisions; no rewrite unless incremental remediation is shown inadequate | §8: the evidence does not show that |
| Approved company-scoped authorization model, LA-1 and protected baselines | No item changes them; consolidation/integration items apply the model |
| ADR-053 | Each new capability needs its ERP Integration Contract first and the three proofs (works, ERP-integrated, does not block what follows) |
| 9.5/10 ambition | A target, not a claim; there is no agreed rating method (scorecard §7) |

## 2. What the evidence supports

1. The spine is sound and additive work is cheap: events → handlers → journals; approvals; process engine; numbering; audit chain; Company routing.
2. Money and stock primitives are the best-verified part (five Implemented-and-Verified rows). Phase 1 should lean on them and extend the *oracle*, not re-prove them.
3. The least-verified parts are the seams and the UI (PA-03, PA-23) — exactly where HR and Accounting meet: payroll → GL → treasury, month-end, reconciliation screens.
4. **New since the previous draft:** the HR-to-Accounting seam has three confirmed-by-reading ledger defects (PA-34 disbursement without GL leg, PA-35 commission excluded from posting, PA-36 float arithmetic) and the audit chain has a confirmed rollback defect (PA-33). These move "ledger correctness of payroll" and "audit-chain integrity" to the front of Phase 1.
5. Several "missing" items are required for the stated scenarios (PA-01, PA-08, PA-09, PA-16, PA-40); others are enhancements with unconfirmed requirements (PA-02, PA-06, PA-07, PA-12, PA-15).

## 3. Pre-conditions: finish the current foundation and verification phase

| # | Item | Retires | Needs | Proposed owner |
|---|---|---|---|---|
| P-1 | CTO sign-off on N-01 (local-scope closure recorded at `b5dcece`; open: acceptance of the by-construction argument, per-endpoint specs if wanted, multi-instance/hosting exclusion) | PA-21 | CTO | Foundation / Team 2 |
| P-2 | N-02: independent review of the fulfil-reservation fix; clean-snapshot pipeline of the then-current HEAD; authorisation for H1/H2/H4/H5 | PA-04, 05, 42 | Reviewer; CTO; cluster window | Inventory / Verification |
| P-3 | **PA-33 decision and fix** (audit chain after rolled-back audit write), then T-22 PASS on a clean snapshot | PA-33 | CTO authorisation (core component) | Foundation / Audit |
| P-4 | F03 retry verification on HEAD; decide Option A or permanent acceptance | PA-13 | Cluster window; CTO | Accounting / Foundation |
| P-5 | Commission regression: canonical serial run on a named clean commit; business-date rule decision | PA-14, 17 | Cluster window; CTO | HR / Commission |
| P-6 | The 19 unrun real-Postgres specs and the one BLOCKED; hosted CI run; real-Postgres job | PA-22 | CTO guard decision; hosted runner | Verification |
| P-7 | Dependency T1 with clean-snapshot re-audit; T2 scheduled after the test net | PA-25 | Scoped change | Foundation / Security |
| P-8 | LA-1 Layer 2: wire the seven remaining sites by their owners; clean-snapshot evidence | PA-41 | Track owners; CTO decision | Company lifecycle |
| P-9 | Reconcile or retire the stale master status file; adopt the capability matrix as the living one | PA-27 | CTO | Documentation |
| P-10 | Queued CTO decisions: capacity targets and staging host, F-INV-001 operator, Integrations tenancy option, duplicate-tree removal | PA-24, 29, 20, 26 | CTO | CTO |

P-1…P-3 and P-5…P-6 should complete **before the Phase 1 gate is evaluated**; they do not need to delay the *start* of Phase 0 or Phase 1 design.

## 4. Phase 0 — architecture and contract planning (HR and Manufacturing only; no implementation)

Each item yields a decision record or ERP Integration Contract (business documents, inventory effects, financial effects, control integration — ADR-053 §2), reviewed by the CTO.

### 4.1 HR / Payroll
| # | Question | Finding |
|---|---|---|
| H0-1 | Statutory payroll scope for the target jurisdiction(s): overtime, income tax method, social insurance rates/caps, other deductions; effective dating; rate-table owner | PA-16 |
| H0-2 | Holiday/working-day calendar ownership; per-Company configuration; absence, lateness and unpaid-leave pay rules | PA-37, PA-16 |
| H0-3 | Payslip: content, numbering, approval, access (employee self-service or HR only), print/export | PA-16 |
| H0-4 | **Accounting shape of payroll**: posting amount (gross + commission, tax/insurance split), commission expense account, tax-payable and insurance-payable accounts, the disbursement entry `Dr Wages Payable / Cr Bank`, cost-centre allocation, reconciliation and closing-audit treatment | PA-34, 35, A-16 |
| H0-5 | Business-date rule for attendance, commission and payroll periods (UTC or Cairo) | PA-14 |
| H0-6 | Disbursement: payment instruction/batch file, employee payment details, partial payment, rejection and re-issue | PA-34 |
| H0-7 | HR master contract: contracts, documents, leave types/balances/entitlements, shifts/schedules, loans/advances, end-of-service | PA-40 |
| H0-8 | Commission reversal policy on void/return/credit; payroll cut-off interaction | PA-38 |
| H0-9 | Salary-data visibility (per company, department, role) under the existing authorization model | integration I-15 |

### 4.2 Manufacturing
| # | Question | Finding |
|---|---|---|
| M0-1 | Planning boundary: availability check / MRP, contract with Sales (demand) and Procurement (requisitions) | PA-31 |
| M0-2 | Costing: moving average with WIP per order exists; is standard costing or variance accounting required | PA-07 |
| M0-3 | Scrap, rework, by-products, co-products | not assessed |
| M0-4 | Lot/serial and traceability interface with Inventory | PA-06 |
| M0-5 | Capacity and work-centre scheduling boundary | PA-31 |
| M0-6 | Open policy items: WIP-control template completeness (grni / wages payable / fixed-asset accounts), Event Engine batching, recovery audit | project record |

## 5. Phase 1 — HR and Accounting

Common rule: each domain's scenarios (audit report §4.7, §4.8 and the relevant parts of §4.1, §4.2, §4.4) reach **Implemented and Verified** on a clean snapshot of a named commit, with an HTTP-level scenario test on the guarded cluster, the R1–R10 oracle **extended to cover payroll**, a small browser E2E set for the UI path, an internal approval record, and no open High finding in the domain. Sizes are relative (S/M/L).

### 5.1 Accounting work packages
| WP | Content | Findings | Depends on | Size |
|---|---|---|---|---|
| ACC-1 | Golden-fixture suite for TB/BS/P&L/cash flow; oracle extended with "balance sheet balances" and "cash-flow net equals treasury movement" | PA-32 | none | M |
| ACC-2 | Payroll-to-ledger correctness with HR (= HRX-1): disbursement entry, posting amount, decimal arithmetic, wages-payable reconciliation and closing-audit category | PA-34, 35, 36 | H0-4 | M |
| ACC-3 | Year-end decision and implementation (derived equity as policy, or closing entries with reopen safety) | PA-10 | ACC-1 | M |
| ACC-4 | Bank-statement import and matching; differences through the cash-bank adjustment path; payroll payment matching | PA-09 | ACC-1 | L |
| ACC-5 | Business-date unification across sub-ledger, attendance, commission, payroll | PA-14 | CTO decision | M |
| ACC-6 | Audit-chain fix and F03 follow-up (= P-3, P-4) | PA-33, 13 | CTO | S–M |
| ACC-7 | AP/AR adjustment accounts and VAT treatment by approved policy | PA-39 | CTO policy | S–M |
| ACC-8 | FX revaluation and exchange result, if the business needs it | PA-11 | requirement | M |
| ACC-9 | Cross-domain accounting enablers: sales-order cancellation (deposit policy), supplier return (GRNI/PPV reversal, debit note) | PA-01, 08 | CTO policy; N-01/N-02 | L each |
| ACC-10 | Order-to-cash and procure-to-pay chain tests with the oracle | PA-03 | ACC-9 for unwind cases | M |
| ACC-11 | Deferred policy items (acquisition-journal helper, template completeness) | closure report | CTO policy | S |

**Exit criteria (Accounting):** period-end scenario verified including year-end; treasury/bank scenario verified including statement matching; order-to-cash and procure-to-pay chains verified; payroll in the oracle and reconciled to the ledger and treasury; statements validated on golden fixtures; PA-33, PA-10, PA-09, PA-32, PA-14, PA-34, PA-35 closed or de-scoped by recorded CTO decision; PA-13 mitigated and re-verified.

### 5.2 HR work packages (details in the integration assessment §7)
| WP | Content | Findings | Depends on | Size |
|---|---|---|---|---|
| HRX-0 | Decisions and contracts H0-1…H0-9 (this is Phase 0) | PA-16, 34, 35, 37, 38, 40, 14 | CTO policy | S–M |
| HRX-1 | Ledger correctness (= ACC-2) | PA-34, 35, 36 | HRX-0 | M |
| HRX-2 | Integrity primitives (audit chain, F03, business date) | PA-33, 13, 14 | CTO | M |
| HRX-3 | Test net: chain test with numeric oracle, payroll in R1–R10, browser E2E for HR/payroll/commission/attendance pages, permission matrix | PA-17, 23, 03 | HRX-1 | M |
| HRX-4 | HR master completion: contracts, documents, leave types/balances, shifts, holiday calendar | PA-40, 37 | HRX-0 | L |
| HRX-5 | Time-to-pay rules and statutory computation; tax/insurance liabilities; payslip | PA-16, 37 | HRX-0, 1, 4 | L |
| HRX-6 | Commission integrity: reversal/queue, GL recognition, cut-off tests | PA-38, 35 | HRX-0, 1 | M |
| HRX-7 | Treasury and month-end: payment batch, rejection/re-issue, statement matching, closing-audit category | PA-09, 34 | HRX-1 | M |

**Exit criteria (HR):** payroll lifecycle verified end to end including statutory computation, payslip, GL and treasury effects; integrated scenario PASS (no longer BLOCKED) with journal-amount and post-disbursement assertions; PA-16, 17, 14, 34, 35, 37, 40 closed or de-scoped by recorded CTO decision; HR pages covered by browser E2E.

### 5.3 Shared Phase 1 enablers (run beside, not after)
| Enabler | Finding | Why |
|---|---|---|
| Frontend test strategy (component tests plus a short browser E2E set per phase path) | PA-23 | Phase 1 changes UI-heavy screens; dependency T2 (react-router 7) needs the net |
| Real-Postgres job in CI and the 19 unrun specs | PA-22 | Gate evidence must be reproducible, not a one-off session |
| Dependency T1 now; T2 after the net | PA-25 | Major upgrades without the net would be the riskiest change in the roadmap |
| Opportunistic contract extraction when a change touches a concrete cross-domain import (seven imports sit in the HR chain) | PA-28 | Cheaper than a campaign; no rewrite |

### 5.4 Proposed Phase 1 gate (for CTO adoption)
1. HR and Accounting each meet their exit criteria on a clean snapshot of a named commit, evidence headers pinned, no uncommitted files from other tracks in the tested tree.
2. No open High finding in HR or Accounting; Medium findings have owners and dates.
3. P-1…P-6 done (P-3 included); N-02 H3 independently reviewed or explicitly accepted.
4. Capability matrix updated with commit-tagged evidence; scorecard re-run with the agreed method (scorecard §7).
5. Independent verification: the gate evidence is reviewed by a party other than the author of the changed code (the N-01 review was by the code author; Team 3 recommends this not be repeated for the gate).
6. Internal approval recorded by the CTO. **This does not authorise release**; release approval remains a separate gate (PA-24, 26, 30).

## 6. Phase 2 — candidate backlog (after the Phase 1 gate)

Ordered by value to the stated scenarios, then by risk and dependency; each needs its ERP Integration Contract first, and the mandatory security, data-integrity and independent-verification gates continue to apply.

| Order | Candidate | Findings | Why this position | Depends on |
|---|---|---|---|---|
| 1 | Release and hosting readiness: staging host, capacity targets and classification, restore/rollback drills, multi-instance run, monitoring and alerts | PA-24, 26, 30 | A release gate, not a feature | Phase 1 gate; host |
| 2 | Customer quotation → order | PA-02 | Completes quote-to-cash; low risk | Requirement confirmed |
| 3 | Notifications and job-queue foundation; multi-instance-safe schedulers | PA-18 | Removes the multi-instance timer risk | Hosting decisions |
| 4 | Lot/serial/batch/expiry; FIFO/standard costing | PA-06, 07 | Large cross-cutting inventory change; only if confirmed | M0-4 |
| 5 | Planning: availability, MRP, capacity scheduling | PA-31 | After traceability and demand are stable | M0-1, M0-5 |
| 6 | Budgeting and multi-Company consolidation (read-only aggregation under the existing entitlement and audit model) | PA-12 | Group reporting; must not weaken isolation | ACC-1…4 |
| 7 | Integrations tenancy decision, more connectors, e-invoicing adapter if legally required | PA-20, 15 | Tenancy decision first | D-03/D-04, legal requirement |
| 8 | HR breadth: recruiting, self-service, performance cycles, training, expense claims | PA-40 | Unspecified today | Phase 1 HR |
| 9 | CRM pipeline, project costing, tracking domain | PA-31, 19 | Breadth | — |

## 7. Mandatory gates across phases

| Gate | Applies to | Evidence required |
|---|---|---|
| Security | every phase | dependency T1 applied before Phase 1 gate; host proxy check; no new High advisory reachable at runtime |
| Data integrity | every change touching money, stock, numbering, audit | plain-manager concurrency probe for any new primitive that takes a lock; oracle R1–R10 clean; audit-chain verification clean |
| Company isolation | every change touching data access | A/B isolation spec; LA-1 admission for any background path |
| Independent verification | every gate | clean-snapshot evidence of a named commit; reviewer ≠ author of the changed code |

## 8. Architecture implications: why no rewrite

- Coupling debt is concentrated; it makes *extraction* hard, not *addition* hard. The roadmap adds capability inside existing domains.
- The defect class (lock released at once) is guarded at the primitive for numbering, transitions, audit, treasury and payments; extension to the N-02 primitives is a small change once authorised. PA-33 is an audit-sequence issue, not a topology issue.
- Rewrites the evidence argues against: replacing the event/ledger path, changing the Company topology, splitting services, replacing the approval or process engines.
- Creeping-rewrite guards: size ADR for new large services; refuse new concrete cross-domain imports in CI once a resolved-path lint exists; every new financial effect through an event and handler (PA-34 is precisely a cash movement that bypassed it); every new lock-taking primitive gets a plain-manager probe before merge.

## 9. Risks to the roadmap and consistency check

| Risk | Evidence | Mitigation |
|---|---|---|
| Verification capacity: one shared cluster, serialised runs, documented collisions | reconciliation §6 | second isolated cluster or windows; CI real-Postgres job |
| Statutory payroll is jurisdiction-specific; wrong rates are a legal risk | PA-16 | decisions first (H0-1), effective-dated tables, golden fixtures, business-owner sign-off |
| Dependency majors collide with Phase 1 | PA-25 | T1 now, T2 after the net |
| Silent date errors persist | PA-14 | one helper, fixtures |
| Requirements assumed, not confirmed | PA-02, 06, 15, 40 | one-page scope signed by the requirement owner |
| Evidence blurred by shared tree and single committer identity | P-01, P-03 | pinned clean snapshots; commit or park other tracks before gate runs |
| Reviewer independence | N-01 review by code author | gate reviewer ≠ author (§5.4 item 5) |
| Release pressure ahead of hosting evidence | PA-26 | release remains a separate gate |

**Consistency check (internal).** Every `PA-xx` cited exists in the register (42); matrix counts quoted elsewhere (88 rows) match; N-01 is carried as closed-by-owner for the local scope with CTO sign-off pending (P-1) and N-02 as not closed; Phase 0 contains no implementation item; Phase 2 items depend on the Phase 1 gate or on a confirmed requirement; the Phase 1 gate is internal acceptance, not release approval.

## 10. Decisions this input needs from the CTO

1. Adopt, amend or reject the ordering in §5 (including grouping ACC-9 enablers under the Accounting gate).
2. Accept the Phase 1 gate conditions (§5.4) or replace them, including reviewer independence.
3. Confirm Phase 0 completeness (§4) and name the business owner for H0-1 and H0-4.
4. Confirm or withdraw the unconfirmed requirements (quotation, lot/serial, FIFO/standard, FX revaluation, e-invoicing, contracts/documents).
5. Authorise or decline the PA-33 fix and the N-02 remainder.
6. Timing of dependency T2 relative to the frontend test net.
