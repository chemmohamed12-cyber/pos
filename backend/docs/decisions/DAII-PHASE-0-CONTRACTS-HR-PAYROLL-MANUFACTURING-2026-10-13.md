# DAII — Phase 0 contracts: HR/Payroll (PH0-HR, H0-1…H0-9) and Manufacturing (PH0-MFG, M0-1…M0-6) — DRAFT FOR OWNER INPUT — 2026-10-13

**Status of this document: documentation only. It starts the roadmap's next stage ("Phase 0", `DAII-MASTER-DEVELOPMENT-ROADMAP-2026-10-11.md` §5). No code, schema, UI, configuration or permission was changed in preparing it** (`git diff 4dc3862 HEAD -- . ':(exclude)backend/docs'` stays empty). It decides **no** business, accounting, statutory or product policy: where a rule is a business decision it is written as a question for a named functional owner, with the options that already exist in the project records and none invented. Every contract below is `DRAFT — AWAITING OWNER INPUT`; none is signed. `PH0-GATE` (CTO sign-off or a recorded deferral for every contract) is **not met**.

Format: each contract follows the ERP Integration Contract headings of ADR-053 §2 (business documents · inventory effects · financial effects · control integration), plus *current verified behaviour*, *options on record*, *questions for the owner*, and *acceptance fixtures to be written once the rule exists*. Functional owners are titles, not people, and none is assigned yet. Evidence: the risk register `DAII-PRODUCT-RISK-AND-TECHNICAL-DEBT-REGISTER-2026-10-11.md` (PA-xx), the ADRs named, and the roadmap input `DAII-STRATEGIC-ROADMAP-INPUT-2026-10-11.md` §4.

Owner titles used: `PAYROLL_POLICY_OWNER` (statutory/legal rules), `ACCOUNTING_POLICY_OWNER`, `HR_OWNER`, `TREASURY_OWNER`, `SECURITY_AUDIT_OWNER`, `MANUFACTURING_OWNER`, `INVENTORY_OWNER`, `PRODUCT_OWNER`, `CTO`.

## Part A — PH0-HR (payroll, attendance, commission, HR master)

### H0-1 Statutory payroll scope — PA-16 · decision DEC-05 · owner `PAYROLL_POLICY_OWNER` (+ legal)
- **Current verified behaviour.** Payroll Phase 1 has periods, compensation, calculation, review, approval (maker ≠ checker), a GL posting event, disbursement and adjustments. By ratified design (ADR-067 §D/§E) it computes **no** overtime, income tax or social insurance; `overtimeAmount` is a reserved null; no tax/insurance control accounts exist; no payslip exists. It is acceptable only as a gross-pay model.
- **Options on record.** None. ADR-067 §D/§E left the statutory rules "genuinely unresolved, not simulated".
- **The contract must state:** jurisdiction(s); for each of overtime, income tax, social insurance, other deductions, end-of-service — the rule, rates/caps/brackets, effective dates, cut-offs; who owns the rate tables and signs changes; how rule changes are versioned.
- **Business documents / inventory / control:** payroll run, payslip lines; inventory effects none; control integration: effective-dated rule tables with an owner and audit trail.
- **Acceptance fixtures (to be written when rules exist):** golden payroll fixtures per rule and boundary (cap, bracket edge, effective-date edge), signed by the owner; a line-sum = journal = cash property.

### H0-2 Calendar, absence, lateness and unpaid leave — PA-37, PA-16 · owner `HR_OWNER` with `PAYROLL_POLICY_OWNER`
- **Current verified behaviour.** `calculate` pays every eligible employee with an active compensation; attendance day statuses are copied into classification rows; `totalDeductions = 0`; absent and missing-punch days classify as `unclassified` with no pay impact; approved leave only changes a label; employees without an approved attendance batch are still paid. Holiday/working-day calendar policy is an open escalation (ADR-053 §16).
- **Options on record.** None for the calendar or the pay rules.
- **The contract must state:** who owns the holiday/working-day calendar and whether it is per Company; pay effect of absence, lateness, unpaid leave and missing punches; whether employees without an approved attendance batch are paid; effective dating.
- **Fixtures:** days that are absent / on leave / late / overtime / holiday, each with the expected pay effect.

### H0-3 Payslip — PA-16 · owner `HR_OWNER`
- **Current verified behaviour.** No payslip exists in backend or frontend.
- **Options on record.** None.
- **The contract must state:** content, numbering, approval before release, who can read it (employee self-service or HR only), print/export, retention.
- **Control integration:** access rules must follow H0-9.

### H0-4 Accounting shape of payroll — PA-34, PA-35, PA-36 · decisions DEC-03, DEC-04 · owner `ACCOUNTING_POLICY_OWNER` (CTO co-signs)
- **Current verified behaviour (by code reading).** (1) The posting handler posts `Dr Salaries & Wages / Cr Wages Payable` for the sum of **gross** pay only. (2) `netPay = grossPay + commissionAmount − totalDeductions` and disbursement pays each line's `netPay` — so commission is **paid but never recognised** in the ledger (ADR-072 describes the posting as "gross pay + resolved commission"; the code does not). (3) `disburse` calls the treasury cash-out as non-emitting and publishes no event, so the documented disbursement entry `Dr Wages Payable / Cr Treasury Account` (ADR-070) **is never posted**. (4) Money arithmetic uses JavaScript floating point rather than the shared decimal helper. The E2E spec that would assert these values is BLOCKED/not executed.
- **Options on record.** The documented intent only (ADR-070 posting and disbursement entries; ADR-072 "gross pay + resolved commission"); whether that intent is the approved policy is the question. No tax/insurance accounts are specified.
- **The contract must state:** the posting amount (gross; gross + commission; later tax/insurance split); the commission expense account and recognition timing (DEC-04); tax-payable and insurance-payable accounts; the disbursement entry, including partial or failed disbursement; cost-centre allocation; what the reconciliation and the closing audit must check.
- **Inventory effects:** none. **Control integration:** wages-payable reconciliation and closing-audit category; template completeness for `wages_payable` (open item of the WIP/template thread).
- **Fixtures:** a run whose journal debit equals the sum of recognised components, whose disbursement leaves the wages-payable account at the owner-stated balance, and a property test that sum of lines = journal = cash for random cent amounts.
- **Prerequisite fact — now measured (WP-PAY-01, 2026-10-13, test-only, disposable database, commit `3bf740b`; `evidence-clean-snapshot-2026-10-13/3bf740b-wp-pay-01/`).** (1) Confirmed at runtime: with salary 4000.00 and approved commission 200.00 the posted journal is `Dr 5201 / Cr 2150 wages_payable` for the **gross** sum only (5000.00 for the run) while 5200.00 net is paid — the commission is in no journal (PA-35). (2) Confirmed at runtime: disbursement pays the cash and creates **no** financial event, so the documented `Dr Wages Payable / Cr Treasury` leg never exists (PA-34). (3) A freshly provisioned Company has no `wages_payable` account: the run reaches `posted` but its Financial Event is **REJECTED** (M0-6 template completeness). (4) PA-36 floating-point drift was **not** shown with 12 cent-valued lines (difference 0); not excluded for larger runs. These are measurements of today's behaviour, not policy: the owner still decides what the correct posting is.

### H0-5 Business-date rule — PA-14 · decision DEC-06 · owner `CTO`
- **Current verified behaviour.** The Postgres session timezone is `Africa/Cairo`; one UTC business-date convention (`3ef67f4`) is used in the sub-ledger/reconciliation path; Attendance local-time handling was fixed; commission derives a target date with `toISOString().slice(0,10)`; the canonical serial regression after the 2026-09-21 fixes has no clean record; the integrated E2E spec reads BLOCKED.
- **Options on record.** (a) UTC business-date helper, already used in the sub-ledger/reconciliation path; (b) Cairo business date. No other option is documented.
- **The contract must state:** the one rule and the one helper used by attendance, commission, payroll periods and the sub-ledger.
- **Fixtures:** events at 23:30–03:30 Cairo for Attendance, Payroll, Commission, GRNI; the 204-test serial regression; the integrated E2E.

### H0-6 Disbursement — PA-34 · decision DEC-24 · owner `TREASURY_OWNER`
- **Current verified behaviour.** Disbursement is a per-line cash-out with no payment instrument; the model holds no employee payment details.
- **Options on record.** None.
- **The contract must state:** how employees are paid (bank transfer file and format, cash, wallet); the data held per employee; partial payment; rejection and re-issue; the ledger legs (links to H0-4).

### H0-7 HR master — PA-40 · decision DEC-18 · owner `HR_OWNER`
- **Current verified behaviour.** Implemented: employees (status history, manager, user link), departments, leave requests with approval. Not found: employment contracts, employee documents, leave types and balances/entitlements, shifts and schedules, holiday calendar, loans/advances, end-of-service, performance reviews.
- **Options on record.** The charter's Wave 2 list (Employee / Department / Organization / Contracts / Documents / Attendance / Leave / HR Operations); none is confirmed as a client requirement.
- **The contract must state, per capability:** confirmed or withdrawn; data model; lifecycle; documents; effect on payroll (links to H0-2, H0-4).
- **Fixtures:** isolation (A/B Company) and lifecycle tests per confirmed capability.

### H0-8 Commission reversal and cut-off — PA-38 · decision DEC-04 · owner `ACCOUNTING_POLICY_OWNER` with `HR_OWNER`
- **Current verified behaviour.** Commission subscribes to `finance.invoice.posted`, `collection.remitted` and approval events only; it does not subscribe to invoice void, sale-return credit or credit events. Corrections exist as manual `CommissionAdjustment` records. (Whether ADR-071 intends manual adjustment as the policy is INFERRED, to be confirmed.)
- **Options on record.** Automatic reversal versus a reviewed adjustment queue (the closure criterion of PA-38 names both; neither is chosen).
- **The contract must state:** which; the interaction with the payroll cut-off (ADR-072); what happens to commission already paid.
- **Fixtures:** post and approve a commission, then void / return / credit the invoice, before and after the cut-off.

### H0-9 Salary-data visibility — integration I-15 · decision DEC-23 · owner `SECURITY_AUDIT_OWNER` with `HR_OWNER`
- **Current verified behaviour.** `payroll.*` permission nodes exist; field-level scope (per company, department, role) is unverified; a hand review of the guards is pending (WP-SEC-02).
- **Options on record.** None.
- **The contract must state:** who may see salary data and at what granularity under the existing authorization model; payslip access (H0-3); audit of reads.
- **Fixtures:** A/B isolation plus role matrix over the payroll and payslip routes.

## Part B — PH0-MFG (Manufacturing)

Baseline facts (ADR-061 and Addendum 1, CTO-closed 2026-10-06; do not reopen): Work Orders with BOM snapshot, material reservation/issue/return, WIP per order and finished-goods receipt on the **moving-average** engine (D1); Routing, Operation and Work Center exist as **non-costing sequencing/assignment master data** (one routing per product; operations execute in sequence; opt-in completion guard); BOM `status` added, no versioning/effective dates; no subcontracting, quality gating, scrap/waste accounting, standard costing, variance, labour/overhead or maker/checker; "yield" is only the ratio produced ÷ planned.

### M0-1 Planning boundary — PA-31 · decision DEC-18/DEC-22 · owner `MANUFACTURING_OWNER` with `PRODUCT_OWNER`
- **Current behaviour.** No planning, MRP or capacity scheduling exists (PA-31); a Work Order reserves its own materials (ADR-061 §5) and the legacy assembly page previews component availability for one assembly; no requisition is generated; Procurement has a data link only, no automated process link (ADR-061 Addendum 1 A7, study §12).
- **Options on record.** The charter lists MRP and advanced planning in Wave 5.
- **Must state:** the contract with Sales (demand signal) and Procurement (requisitions): what is a signal, who consumes it, what is explicitly out of scope until Wave 5.

### M0-2 Costing — PA-07 · decision DEC-22 · owner `ACCOUNTING_POLICY_OWNER` with `MANUFACTURING_OWNER`
- **Current behaviour.** Actual / moving-average only; finished-goods cost is material cost only; labour, machine-hours, overhead pools, standard cost and variance are excluded by ratified decisions D2/D3 (ADR-061 §9–§11, §21).
- **Options on record.** Only the exclusion statements; each exclusion says a change is "its own future, separately-ratified decision".
- **Must state:** whether standard costing, variance accounting, or labour/overhead absorption is required; if yes, accounts, events and reconciliation (the Inventory cost-engine interface is designed for a second engine; PA-07).

### M0-3 Scrap, rework, by-products, co-products — not assessed · owner `MANUFACTURING_OWNER`
- **Current behaviour, a disclosed gap (ADR-061 §21).** A Work Order closes with `WIP = 0`; the only legal way to close a shortfall is a Material Return of the unused component back to stock. If the shortfall is real physical scrap, that return would wrongly re-inflate on-hand quantity and moving-average cost with material that no longer exists. Phase 1 "should only be used where genuine physical scrap is not expected, or tracked outside the system".
- **Options on record.** None (explicitly deferred).
- **Must state:** whether scrap/rework/by-products occur in the target use; if so, the events, accounts and the Work Order closing rule. **This is the one Part B item with a live data-correctness exposure; it deserves an early answer.**

### M0-4 Lot/serial and traceability — PA-06 · decision DEC-18 · owner `INVENTORY_OWNER` with `PRODUCT_OWNER`
- **Current behaviour.** No lot, serial, batch or expiry entities or columns exist; requirement unconfirmed.
- **Must state:** confirmed or withdrawn; if confirmed, the interface with movements, reservations, returns and valuation, and which Manufacturing documents carry lot/serial.

### M0-5 Capacity and work-centre scheduling — PA-31 · owner `MANUFACTURING_OWNER`
- **Current behaviour.** Work Centers and Routings exist as master data without capacity, calendars, rates or scheduling; operations are executed in sequence per Work Order.
- **Must state:** whether finite-capacity scheduling is required, and the boundary with M0-1 (planning) so the two are not specified twice.

### M0-6 Open policy items — project record · owner `ACCOUNTING_POLICY_OWNER` with `CTO`
- **Current behaviour.** Per the H2 record (`WIP-CONTROL-ACCOUNT-TEMPLATE-2026-10-06.md`) the WIP control account `1150` is in the `ifrs-sme` template (H2 closed); **template completeness** for `grni`, `wages_payable` and `fixed_asset` control accounts is an open scope (same failure class: events REJECTED in a fresh Company); the Event Engine claims 50 outbox rows per batch (an event right after an import waits for the scheduler); recovery for existing Companies (H2-R) is not audited.
- **Must state:** which of the three scopes are opened, in what order, and who approves touching the Event Engine (gated). None is started.

## Part C — Gate status and what each owner must supply
| Contract | Decision / dependency | Owner title | Needed from the owner | State |
|---|---|---|---|---|
| H0-1 | DEC-05 | `PAYROLL_POLICY_OWNER` | jurisdiction, rules, tables, signatory | DRAFT — AWAITING OWNER INPUT |
| H0-2 | DEC-05/DEC-06 | `HR_OWNER` | calendar owner; absence/lateness/leave pay rules | same |
| H0-3 | DEC-23 | `HR_OWNER` | payslip content, numbering, access | same |
| H0-4 | DEC-03, DEC-04 | `ACCOUNTING_POLICY_OWNER` | posting amount, accounts, disbursement entry, recognition timing | same (+ WP-PAY-01 runtime fact) |
| H0-5 | DEC-06 | `CTO` | UTC or Cairo | same |
| H0-6 | DEC-24 | `TREASURY_OWNER` | payment instrument and batch approach | same |
| H0-7 | DEC-18 | `HR_OWNER` | confirmed capabilities | same |
| H0-8 | DEC-04 | `ACCOUNTING_POLICY_OWNER` | reversal vs adjustment queue | same |
| H0-9 | DEC-23 | `SECURITY_AUDIT_OWNER` | visibility matrix | same |
| M0-1 … M0-5 | DEC-18, DEC-22 | `MANUFACTURING_OWNER`, `INVENTORY_OWNER`, `PRODUCT_OWNER` | planning, costing, scrap, lot/serial, scheduling answers | same |
| M0-6 | CTO | `ACCOUNTING_POLICY_OWNER` | scopes to open | same |
**PH0-GATE: NOT MET.** Exit requires every contract to have CTO sign-off or a recorded deferral, the open policy questions listed with owners (this document), and no implementation artefact for these contracts. The third condition holds at this commit (no code, schema, UI or permission change). The first two are the owners'/CTO's to give; this team cannot sign contracts or decide policy.

## Part D — Suggested order of owner conversations (not a decision)
1. `ACCOUNTING_POLICY_OWNER`: H0-4 and H0-8 first — they decide whether payroll and commission are recognised correctly in the ledger today (PA-34/35 are the highest-severity findings in the HR/Payroll stream); then M0-2/M0-6.
2. `MANUFACTURING_OWNER`: M0-3 first (live data-correctness exposure), then M0-1/M0-5.
3. `CTO`: H0-5 (a single-line decision that unblocks fixtures for attendance, commission and payroll).
4. `PAYROLL_POLICY_OWNER` and `HR_OWNER`: H0-1/H0-2/H0-3/H0-7 — the largest items; statutory rules are jurisdiction-specific and must not be inferred.
5. `TREASURY_OWNER` and `SECURITY_AUDIT_OWNER`: H0-6 and H0-9.
Phase 1 (HR and Accounting) design starts only after PH0-GATE, and its exit gate keeps every security, integrity and independent-verification gate of roadmap §8.
