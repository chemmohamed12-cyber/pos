# DAII — Product Capability Matrix (Team 3 Independent Product Audit) — 2026-10-11

Deliverable 2 of 6. Finding IDs (`PA-xx`) are defined in `DAII-PRODUCT-RISK-AND-TECHNICAL-DEBT-REGISTER-2026-10-11.md`. Independent and read-only: no product code, schema, UI, permission or configuration changed; no database-backed test run by Team 3.

**Baseline.** Audit cutoff 2026-10-11, source read at HEAD `b591d1f`. Evidence baseline `a6002fa` (last complete clean-snapshot verification). Product source differs between the two only in the N-02 `fulfillReservation` fix (`a798d9d`, `b591d1f`) and LA-1 Layer 2 admission (`60b9bdf`) with their specs; rows touched by that delta say so, and the delta has no complete clean-snapshot verification (PA-42).

## 0. Classification model

Every row carries two independent classes, so that implementation is never confused with verification.

| Axis | Values |
|---|---|
| **Implementation** | **Implemented** · **Partial** (part of the expected capability is absent; stated in the row) · **Specified, not implemented** (a written specification, ratified decision, charter entry, interface or placeholder exists in the repository — cited — but no working code) · **Not implemented** (neither code nor specification found) |
| **Verification** | **Verified** (scenario-level test with oracle or numeric assertions passed on a named commit, for the scenarios the row states) · **Partly** (some specs, dated walkthrough or code reading; key scenarios, concurrency, end-to-end or UI not covered, or a known defect is open) · **Unverified** (no usable evidence) · **Blocked** (cannot proceed for a recorded reason; never a pass) · **Not assessed** |

Mapping to the earlier directive vocabulary: *IMPLEMENTED AND VERIFIED* = Implemented + Verified; *IMPLEMENTED — PARTIALLY VERIFIED* = Implemented + Partly (or Unverified); *PARTIALLY IMPLEMENTED* = Partial; *NOT IMPLEMENTED* = Specified-not-implemented or Not implemented; *BLOCKED*, *NOT ASSESSED* unchanged. A menu item, entity, document or passing typecheck is never sufficient evidence; unimplemented or untested capability is never counted as a pass; evidence is never merged across commits.

**Evidence tags.** `CS:<commit>` clean-snapshot test of that commit (business suite T-00…T-20 etc., `evidence-clean-snapshot-2026-10-11/`); `WT:<commit>` working-tree test (HEAD plus uncommitted files — historical, not a verification of the commit alone); `DOC` dated manual walkthrough in `MASTER_PROJECT_STATUS.md` (2026-08-24, no commit tie); `READ` Team 3 static reading at `b591d1f`; `FH` first-hand evidence of this author's earlier sessions (WT class). The business suite exercises the harness-wired services (inventory, valuation, treasury, payments, returns capacity, audit, numbering, entity creation, HTTP customers, capacity) plus the R1–R10 oracle; it does not drive every domain, and rows say which part applies.

## 1. Platform and foundation

| # | Capability | Implementation | Verification | Evidence | Findings |
|---|---|---|---|---|---|
| F-01 | Company isolation (database-per-Company, routing, A/B isolation of data) | Implemented | Verified — for tenant-scoped reads/writes of the domains with isolation specs and the two-Company HTTP run | 80 isolation specs PASS (WT, verification report §2); T-01…T-20 two-Company runs CS:`a6002fa` | PA-22 |
| F-02 | Company provisioning, pool, fan-out, restore, membership provisioning | Implemented | Partly — 19 real-Postgres specs NOT RUN, 1 BLOCKED; mock-only specs PASS | verification report §2 | PA-22, PA-30 |
| F-03 | Authentication (bcrypt, rotating hashed refresh tokens, throttle, lockout) | Implemented | Partly — `DOC` live checks 2026-08; no spec by name for the controller; no pen test | TEST-03 Q-03 | PA-25, PA-29 |
| F-04 | Authorization F1–F6 (company roles, anti-elevation, platform guard, support access, workflow rules, warehouse scope) | Implemented | Partly — phase reports, T-09 36 assertions CS:`a6002fa`, isolation specs; residuals open | F1–F6 reports | PA-29 |
| F-05 | Audit trail and hash chain | Implemented | Partly — concurrent appends keep one chain (T-03/T-13/T-14 CS:`a6002fa`) **but a rolled-back audit write permanently breaks verification** (T-22 WT:`ce924e2`+dirty) | N-02 report §6 | PA-33 |
| F-06 | Approval engine (maker ≠ checker, expiry) | Implemented | Partly — Area 21 closure, isolation specs; expiry scheduler now wrapped by LA-1 L2 (delta) | READ | PA-41, PA-42 |
| F-07 | Process engine (state machines) | Implemented | Partly — T-17 CS:`a6002fa`: transitions capped at the legal 2 under plain manager; racing `start()` raises DB errors (T-20 H4); N-01 closure recorded for local scope, sign-off pending | N-01 report §7 | PA-21, PA-05 |
| F-08 | Document numbering | Implemented | Partly — T-17/T-19 CS:`a6002fa`: 200/200 distinct, four entity creates 80/80, HTTP customers 120/120; only those call paths driven concurrently | N-01 report §6A | PA-21 |
| F-09 | Financial Event Engine (outbox → handlers → journal) | Implemented | Partly — 16 event types read; T-10 oracle PASS CS:`a6002fa`; F03 deadlock mitigated by retry (`9c746aa`), not re-tested after N-01 | READ; RCA | PA-13 |
| F-10 | Event outbox dispatch (in-request flush, 30-s sweep, retries ≤ 5) | Implemented | Partly — T-15/T-16 functional PASS; high-volume and multi-instance unverified | outbox behaviour doc | PA-18, PA-24 |
| F-11 | Configuration engine, terminology/i18n registry (Arabic/RTL), localization | Implemented | Partly — seeds per phase; RTL/browser review pending | migrations | PA-23 |
| F-12 | Module registry, entitlement, plans, module lifecycle | Implemented | Partly — registry/entitlement specs; `release-migration-registry` BLOCKED | verification report §2 | PA-22 |
| F-13 | SaaS control plane (Company registry, plans, support access, platform roles) | Implemented | Partly — WP-0.4 closed (project record) | closure package | PA-41 |
| F-14 | Release engine (candidate build, deploy, rollback, backups) | Implemented | Partly — production 1.1.4 incident, 1.1.6 deploy cut-off on record; largest service has no spec by name | incident review | PA-26, PA-30 |
| F-15 | User notification | Specified, not implemented — `foundation/notification` README placeholder | Not assessed | READ | PA-18 |
| F-16 | Background processing / job queue | Specified, not implemented — README placeholder; 8 in-process timers instead | Not assessed | architecture graph §1 | PA-18 |
| F-17 | Observability (logger, health, metrics) | Implemented | Unverified — alerts/SLOs not found | READ | PA-30 |
| F-18 | Excel import/export foundation | Implemented | Partly — used by price lists, attendance, chart import, report exports | READ; D-01 (multer advisories) | PA-25 |
| F-19 | Integrations (partner order intake; QR store connector) | Partial — one connector; tenancy mismatch D-03 | Partly — T-18 FAIL-DEFECT CS:`a6002fa`; no spec by name | D-03 record | PA-20 |
| F-20 | Lifecycle admission (LA-1 Layer 1 HTTP, Layer 2 background/operational paths) | Partial — Layer 2 wired in 3 of 10 sites | Partly — mechanism verified on a proof copy; no clean-snapshot of `60b9bdf` | LA-1 record | PA-41, PA-42 |

## 2. Accounting, treasury and finance

| # | Capability | Implementation | Verification | Evidence | Findings |
|---|---|---|---|---|---|
| A-01 | Chart of accounts, control functions, templates (ifrs-sme), dimensions | Implemented | Partly — isolation specs; WIP control account `FH` | READ | PA-10 |
| A-02 | Journal entries (manual/event-driven), balance check, reversal, per-Company numbering | Implemented | Partly — journal-numbering spec 5/5; balance check in SQL `NUMERIC`; reversal rules read | READ; closure report | PA-13 |
| A-03 | Fiscal years/periods; close/reopen with approval; closing audit; exceptions; signed snapshots | Implemented | Partly — closing specs; snapshot recovery scheduler | READ | PA-10 |
| A-04 | Year-end closing entries / retained-earnings roll-forward / opening carry | Specified, not implemented — `retained_earnings` "year-end roll-forward target — F13"; ADR-047 D3 anticipates a future closing entry | Not assessed | `control-function.ts`, `financial-reporting.service.ts` | PA-10 |
| A-05 | Financial statements (TB, BS, P&L, cash flow) and exports | Implemented | Unverified (numerics) — no golden fixtures | READ | PA-32 |
| A-06 | Tax codes, tax engine, tax-period summary, input/output VAT | Implemented | Partly — D5 closed (2026-10); engine calculation-only by design | closure report | PA-15 |
| A-07 | E-invoicing / tax-authority integration | Not implemented — external-document reference field only | Not assessed | migration `1755855000000` | PA-15 |
| A-08 | Multi-currency (rates, line rate snapshots) | Partial — no revaluation or exchange result | Unverified | READ | PA-11 |
| A-09 | Fixed assets: acquisition link, depreciation, disposal gain/loss, reconciliation | Partial — acquisition-journal helper deferred (policy required; inert code exists) | Partly — D8 link workflow closed; FA-02 UAT ready | closure report | PA-32 |
| A-10 | AR: invoices, payments, on-account application, credit/debit notes, aging, reconciliation | Implemented | Partly — payments idempotency/over-application T-06/T-08 CS:`a6002fa`; `DOC` E2E; adjustments default account 5299 | READ | PA-03, PA-39 |
| A-11 | AP: supplier invoices, payments, PPV, adjustments, aging, reconciliation | Implemented | Partly — 11 procurement isolation specs; adjustments default 5299 | READ | PA-03, PA-39 |
| A-12 | Treasury accounts, cash in/out, transfers, balances, withdrawal limits | Implemented | Verified — concurrent withdrawals cannot overdraw; balances exact vs oracle; transfers (T-05/T-14/T-16 CS:`a6002fa`) | reconciliation §4 | PA-24 |
| A-13 | Bank reconciliation against bank statements | Not implemented — internal GL-to-treasury reconciliation only | Not assessed | READ | PA-09 |
| A-14 | Sub-ledger reconciliations (AR, AP, GRNI, inventory, WIP, fixed assets) | Implemented | Partly — R1–R10 PASS CS:`a6002fa`; WIP split spec `FH` WT:`3b5c634` | T-10 | PA-32 |
| A-15 | Budgeting; multi-Company consolidation | Specified, not implemented — consolidation listed in charter Wave 5; budgeting not specified | Not assessed | charter §5 | PA-12 |
| A-16 | Cost-centre / dimension accounting on payroll and operational postings | Partial — dimensions exist; payroll posting carries no org/cost-centre allocation | Unverified | `payroll.service.ts` payload | PA-35 |

## 3. Commercial, supply chain and operations

| # | Capability | Implementation | Verification | Evidence | Findings |
|---|---|---|---|---|---|
| S-01 | Customer master, assignment/scope, credit limit | Implemented | Partly — HTTP creation 120/120 CS:`a6002fa` | N-01 §6A | — |
| S-02 | Customer quotation | Not implemented | Not assessed | READ | PA-02 |
| S-03 | Price lists and pricing rules, import/export | Implemented | Partly — creation 80/80 CS:`a6002fa` | N-01 §6A | — |
| S-04 | Sales order lifecycle: draft → approvals → deposit → release; hold expiry; draft delete | Implemented | Partly — state machines read; `DOC` live E2E; expiry scheduler in the LA-1 delta | READ | PA-01, PA-03 |
| S-05 | Sales order cancellation / reactivation | Not implemented | Not assessed | `process-definition.ts` | PA-01 |
| S-06 | Deposits and verification | Implemented | Partly — `deposit.verified` handler; one spec | READ | PA-03 |
| S-07 | Fulfilment: pick, pack, review, ready for shipping | Implemented | Partly — 1 isolation spec; `DOC` | records | PA-03 |
| S-08 | Shipping: RSH, waybill, carriers, vehicles, custody, COD, settlement | Implemented | Partly — shipment transitions never probed (T-20 H5 BLOCKED); `DOC` | N-02 probes | PA-05 |
| S-09 | Delivery and collections | Implemented | Partly — `collection.remitted` handler; `DOC`; reservation fulfil fixed in the delta | READ | PA-04 |
| S-10 | Customer returns (customer and custody origin, inspection, disposition, credit) | Implemented | Verified — over-return capacity under concurrency (T-07 CS:`a6002fa`); D4 accounting closed | reconciliation §4 | PA-03 |
| I-01 | Warehouses, items per warehouse, stock levels | Implemented | Verified — concurrent issues/reservations cannot oversell; exact on-hand (T-01…T-04 CS:`a6002fa`) | reconciliation §4 | — |
| I-02 | Stock reservation lifecycle (reserve, release, fulfil) | Implemented | Partly — fulfil double dispatch fixed in the delta, verified by the implementing track (T-21 WT), clean-snapshot pending; release/limit races open (T-20 CS:`a6002fa`) | N-02 reports | PA-04, PA-05, PA-42 |
| I-03 | Warehouse transactions (receipt, issue, transfer, adjustment, count), approvals | Implemented | Partly — T-01/T-02/T-04 PASS; T-09 scope contract PASS; 410 change not approved | verification report | PA-29 |
| I-04 | Valuation: moving average | Implemented | Verified — concurrent receipts/issues, valuation reconciled by R2 (T-01/T-03/T-10 CS:`a6002fa`) | reconciliation §4 | PA-07 |
| I-05 | FIFO / standard costing | Specified, not implemented — engine interface anticipates it (`cost-engine.ts`) | Not assessed | READ | PA-07 |
| I-06 | Lot / serial / batch / expiry | Not implemented | Not assessed | READ | PA-06 |
| P-01 | Purchase requests, RFQ, supplier quotations | Implemented | Partly — isolation specs; D6/D7 browser-verified 2026-10-06 | closure report | — |
| P-02 | Purchase orders (approval, cancel, partial/full receipt, close) | Implemented | Partly — state machine read | READ | PA-21 |
| P-03 | Goods receipt, GRNI ledger/reconciliation, manual receipt | Implemented | Partly — handler read; GRNI spec; Cairo day-boundary fix `3ef67f4` | READ | PA-14 |
| P-04 | Supplier master, contacts, bank accounts, statements | Implemented | Partly — creation 80/80 CS:`a6002fa` | N-01 §6A | — |
| P-05 | Supplier return (return to vendor) | Not implemented — acknowledged follow-up in ADR-052/D5 | Not assessed | D5 record | PA-08 |
| P-06 | New-item request and product lifecycle gate | Implemented | Partly — D7 browser-verified | closure report | — |
| M-01 | BOM, routing, work centres | Implemented | Partly — M10 closure; UI by `FH` | acceptance docs | — |
| M-02 | Work orders: release, issue, produce, complete, cancel; WIP sub-warehouse; costing | Implemented | Partly — `FH` Phase 3 E2E WT:`7079eae` (API + live Postgres, serial); WIP reconciliation split WT:`3b5c634` | `FH` | PA-13 |
| M-03 | Production planning, MRP, capacity scheduling | Specified, not implemented — "Advanced Planning / MRP" in charter Wave 5 | Not assessed | charter §5 | PA-31 |

## 4. HR, attendance, targets, commission and payroll

| # | Capability | Implementation | Verification | Evidence | Findings |
|---|---|---|---|---|---|
| H-01 | Employees, status history, manager, user link, departments | Implemented | Partly — HR spec; 1 isolation spec | READ | PA-40 |
| H-02 | Leave requests with approval; `isApprovedLeaveDate` | Implemented | Partly | READ | PA-40 |
| H-03 | Leave types, balances, entitlements | Specified, not implemented — charter Wave 2 lists Leave | Not assessed | charter §5 | PA-40 |
| H-04 | Employment contracts, employee documents, HR operations | Specified, not implemented — charter Wave 2 | Not assessed | charter §5 | PA-40 |
| H-05 | Attendance: connectors, employee mapping, manual punch, Excel and biometric daily import | Implemented | Partly — time handling fixed `54d8818` | READ | PA-14 |
| H-06 | Attendance day derivation, correction requests, approval batches | Implemented | Partly | READ | PA-14 |
| H-07 | Shifts, schedules, holiday calendar | Specified, not implemented — holiday calendar is an open `ADR-053 §16` escalation (ADR-067 §C) | Not assessed | `payroll.service.ts` | PA-37, PA-16 |
| H-08 | Sales targets (draft → approval; approved target for date) | Implemented | Partly | READ | PA-14 |
| H-09 | Performance reviews / HR performance management | Not implemented (targets are sales targets only) | Not assessed | READ | PA-40 |
| H-10 | Commission policies (flat, target-tiered), results from `invoice.posted` / `collection.remitted`, approval batches, adjustments | Implemented | Partly — fix `f2d15fa` present, clean regression re-run not recorded | READ; E2E spec header | PA-14, PA-38 |
| H-11 | Commission reversal on void/return/credit | Not implemented — manual adjustment only | Not assessed | `commission.service.ts` | PA-38 |
| H-12 | Payroll lifecycle: periods, compensation, calculate, review, approval (maker ≠ checker), disbursement, adjustments | Implemented | Partly — `payroll-phase1.spec`; E2E BLOCKED | READ | PA-17 |
| H-13 | Payroll statutory computation (overtime, income tax, social insurance) | Specified, not implemented — ADR-067 §D/§E ratified the boundary; `overtimeAmount` reserved null | Not assessed | `payroll.service.ts` class doc | PA-16 |
| H-14 | Payslip document | Not implemented | Not assessed | search | PA-16 |
| H-15 | Payroll GL posting (`payroll.run.posted` → Dr salaries / Cr wages payable) | Partial — posts gross pay only; commission excluded | Partly — journal balance asserted, amount not | handler; E2E spec | PA-35 |
| H-16 | Payroll disbursement GL effect (Dr wages payable / Cr bank) | Specified, not implemented — ADR-070 specifies it; code is `NO_EMIT` | Unverified — specs stop at `disbursedAt` | `treasury.service.ts` | PA-34 |
| H-17 | Payroll money arithmetic (decimal-safe) | Partial — JavaScript floating point | Unverified | `payroll.service.ts` | PA-36 |
| H-18 | Integrated Attendance → Payroll → Commission → GL scenario | Implemented (components) | Blocked — BLOCKED — REGRESSION NOT CLEAN (`9da2e54`, 2026-09-21); resume unrecorded | E2E spec | PA-17 |

## 5. Delivery quality and operations

| # | Capability | Implementation | Verification | Evidence | Findings |
|---|---|---|---|---|---|
| Q-01 | Frontend SPA (164 `.tsx`; Section Covers; print documents) | Implemented | Partly — `tsc -b`, build, oxlint; manual browser acceptance; zero automated UI tests | `frontend/package.json` | PA-23 |
| Q-02 | CI | Implemented | Partly — seven steps PASS locally from a clean archive; never on a hosted runner; no real-Postgres job | status record C-01 | PA-22 |
| Q-03 | Capacity and scalability | Implemented (single process) | Not assessed against targets — ~31–39 req/s plateau on a 2-core laptop | verification report §3 | PA-24 |
| Q-04 | Hosting / production operation | Implemented (release engine) | Not assessed — no hosting access | incident review | PA-26 |
| Q-05 | Dependency security posture | Implemented | Partly — audit done (`d51a751`); remediation not run | D-01 | PA-25 |
| Q-06 | Backup / restore through the product | Implemented (schedulers) | Not assessed — restore specs NOT RUN | verification report §2 | PA-30 |
| Q-07 | Documentation: ADRs, decisions, runbooks | Implemented | Partly — master status file stale | file headers | PA-27 |
| Q-08 | `tracking` domain | Specified, not implemented — README placeholder | Not assessed | READ | PA-19 |
| Q-09 | Delta after `a6002fa` (N-02 fix, LA-1 Layer 2) | Implemented | Partly — implementing-track tests only | N-02 report | PA-42 |

## 6. Counts (computed from the tables by script, rows counted by header ID)

88 rows.

| Implementation class | Rows | IDs |
|---|---|---|
| Implemented | 60 | — |
| Partial | 7 | F-19, F-20, A-08, A-09, A-16, H-15, H-17 |
| Specified, not implemented | 12 | F-15, F-16, A-04, A-15, I-05, M-03, H-03, H-04, H-07, H-13, H-16, Q-08 |
| Not implemented | 9 | A-07, A-13, S-02, S-05, I-06, P-05, H-09, H-11, H-14 |

| Verification class | Rows |
|---|---|
| Verified | 5 |
| Partly | 53 |
| Unverified | 6 |
| Blocked | 1 |
| Not assessed | 23 |

Implemented **and** Verified: 5 rows — F-01, A-12, S-10, I-01, I-04 (each limited to the scenarios written in its row). Blocked: H-18.

The counts describe the state of evidence, not the quality of the code. If a count and a row ever disagree, the row text is authoritative.

## 7. Reading this matrix

1. **Verified means narrow.** The verified rows are concurrency and integrity properties the business suite asserts on `a6002fa`; they do not certify the workflows around them.
2. **The strongest evidence is on money and stock primitives; the weakest is on seams between domains, payroll-to-ledger agreement and the UI.**
3. **Specified, not implemented ≠ defect.** Several rows are charter or ADR items awaiting their phase; others (H-16, H-15) are *specified and implemented differently*, which the register treats as defects.
4. **Use.** If adopted as the living Capability Coverage Matrix that ADR-053 requires (PA-27), update it after each phase gate with commit-tagged evidence and add the charter's fields (dependencies, accounting impact, inventory impact, integration requirements, acceptance criteria, target phase) — they are supplied in the register's closure criteria and the roadmap input.
