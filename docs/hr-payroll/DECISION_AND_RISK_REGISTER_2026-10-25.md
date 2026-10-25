# Decision and risk register (2026-10-25)

Each decision is exactly one of **APPROVED** (named authority), **PROPOSED** (recommendation written, awaiting the CTO/owner) or **BLOCKED** (cannot be proposed responsibly without an input). Nothing below is inferred from code existing or tests passing. Where code currently behaves in a certain way pending a decision, that behaviour is stated as «today» and is **not** an approval of the rule.

## 1. Decisions

| ID | Decision | Status | Authority / what is needed | Behaviour today |
|---|---|---|---|---|
| D-C16 | Payroll/commission delivery = gap closure of existing code (C16 = S2) | **APPROVED** | CTO decision «C16 Resolution, Contract Closure & Controlled GO» | implemented as such |
| D-ADD | ADR-070/071/072 addenda A-1…A-11 are the working contract | **APPROVED as working contract**; formal ADR approval **PENDING** | same CTO decision | implemented |
| D-T1/B1 | T-1 verification, B-1 HR link membership fix | **APPROVED** (executed) | same | done, verified |
| D-HOLD | Merge, release, production: HOLD | **APPROVED** (standing) | CTO | no merge/release/deploy performed |
| F-1 | Commission adjustment needs an independent approval before payroll consumes it | **PROPOSED** (R-F1) | CTO | not required: one person can create an adjustment that the next run pays; the run approval is the only independent control |
| F-2 | Journal basis Dr 5201 (gross + commission + adjustments) / Cr 2150 (net); no deduction line | **PROPOSED** (R-F2) | CTO + Accounting owner (separate commission account? chart) | posts as described; refuses runs carrying deductions |
| F-3 | Expense entry date: approval date (today) vs period end | **PROPOSED** (R-F3 = period end, or approval date when later) | CTO + Accounting owner | dated on the approval day |
| F-4 | Return of money already paid (Treasury reversal and payable restore) | **BLOCKED** | CTO must say whether a Treasury reversal of a payroll cash-out is allowed and who performs it | not implemented — a paid item cannot be returned |
| F-5 | SoD: `standard` default, `strict` per Company; `minimal` profile and waiver | profiles **PROPOSED**; `minimal`/waiver **BLOCKED** (owner D-6) | CTO | `standard`/`strict` enforced; no waiver exists; the approver ≠ preparer/submitter floor cannot be relaxed |
| F-6a | Timezone / business-day rule (Cairo vs UTC day) | **BLOCKED** | CTO (DEC-06 / F11-TZ) | UTC-day helper |
| F-6b | Holiday calendar and absence deductions | **BLOCKED** | HR + Payroll owners (H0-2) | attendance gap = documented exception, nothing computed |
| F-6c | Deduction types (statutory, advances, penalties) | **BLOCKED** | each needs a ratified rule and a liability account | refused at posting |
| F-7 | Pay change effective mid-period: whole-period delta vs proration by days | **BLOCKED** (no ADR defines it; not recommended in code) | Payroll owner | supplementary run pays the whole-period difference (browser: +1,000.00 for a rise from 15 Oct) — not accepted as the rule |
| F-8 | Commission `net_sales` basis and `customer_group` scope | **BLOCKED** | owner must define and approve data source | creation refused, legacy rows pay nothing |
| F-9 | Ambient (non-isolated) functional specs | **BLOCKED** | CTO must approve an isolated PostgreSQL cluster entry (port 5544, `approved-test-databases.json` is the approval record) so `provision-isolated-ambient-db.js` can create the ambient test database; the guard must not be weakened | specs edited, **not run** |

## 2. Risks

| ID | Risk | Likelihood / impact | Mitigation in place | Residual / owner |
|---|---|---|---|---|
| K-1 | A single user creates a commission adjustment that is paid | medium / money | run approval + SoD | F-1 |
| K-2 | Expense recognised in the wrong month (entry dated at approval) | medium / reporting | none beyond visibility | F-3 |
| K-3 | Money paid cannot be returned in the system | low-medium / money | failed items stay as history; reconciliation shows differences | F-4 |
| K-4 | Mid-period pay change over-/under-paid in supplementary run | medium / money | the run shows the delta and the exception record; approval by a third person | F-7 |
| K-5 | Terminology seeded only in Company DB → raw codes on screen | high if missed / UX | documented; the seed migration must run on the **platform** database (the service reads it there) | deployment checklist item |
| K-6 | Ambient specs never executed against these edits | medium / regression blind spot | isolation specs cover every changed service; `tsc` passes over the ambient specs | F-9 |
| K-7 | Global error-filter change (`localizable` opt-in) | low / platform-wide | additive: only exceptions that set `localizable: true` change shape; all other responses byte-identical; full regression run | reviewer to confirm |
| K-8 | Deployment ordering: migration `1790100000000` drops `UQ_payroll_runs_period` | medium / data | existing rows take `revision = 1` / `kind = 'regular'` (column default) before the new unique indexes; tested on fresh DBs only | **not rehearsed on a copy of a populated Company database** — required before any release |
| K-9 | Failure reasons of payout items are stored as English text | low / UX | the screen maps the known insufficient-balance text to a registered label | store a code (follow-up) |
| K-10 | Commission result → adjustment path not exercised in a browser (needs sales events) | low / UX | S2 spec covers the service | NOT VERIFIED in browser |
