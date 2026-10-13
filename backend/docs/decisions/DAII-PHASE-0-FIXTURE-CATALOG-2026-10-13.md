# DAII — Phase 0 technical preparation: fixture catalog for the HR/Payroll/Manufacturing contracts — 2026-10-13

**Status: documentation only; no test, code or schema was written for the items below.** These are the *inputs* of the acceptance fixtures named in `DAII-PHASE-0-CONTRACTS-HR-PAYROLL-MANUFACTURING-2026-10-13.md`. They are written now so that, when an owner supplies a rule, the expected value is the only thing left to fill. Where an expected value would be a business or statutory rule, the cell is `OWNER` — it is **not** guessed here. Where it is pure arithmetic or calendar fact, it is computed (and the computation is stated).

## FX-H05 — business date (contract H0-5, DEC-06): fully computable under both candidate rules
Rule A = UTC business date (the helper already used by the sub-ledger and reconciliation path). Rule B = Africa/Cairo business date. Values computed with the IANA time-zone database (Egypt: UTC+3 in summer time, UTC+2 in winter time; the 2026 offsets shown are the database's). Every event below must be recorded by Attendance, Commission, Payroll period assignment and GRNI with the date in the column of the rule the CTO chooses; the "rules agree" rows are controls that must not change.

| ID | Cairo local time of the event | UTC instant | Rule A (UTC) date | Rule B (Cairo) date | Rules agree |
|---|---|---|---|---|---|
| FX-H05-01 | 2026-10-12 22:00 (UTC+3) | 2026-10-12 19:00Z | 2026-10-12 | 2026-10-12 | yes (control) |
| FX-H05-02 | 2026-10-12 23:30 (UTC+3) | 2026-10-12 20:30Z | 2026-10-12 | 2026-10-12 | yes (control) |
| FX-H05-03 | 2026-10-13 00:00 (UTC+3) | 2026-10-12 21:00Z | 2026-10-12 | 2026-10-13 | **no** |
| FX-H05-04 | 2026-10-13 00:30 (UTC+3) | 2026-10-12 21:30Z | 2026-10-12 | 2026-10-13 | **no** |
| FX-H05-05 | 2026-10-13 02:59 (UTC+3) | 2026-10-12 23:59Z | 2026-10-12 | 2026-10-13 | **no** |
| FX-H05-06 | 2026-10-13 03:00 (UTC+3) | 2026-10-13 00:00Z | 2026-10-13 | 2026-10-13 | yes (boundary) |
| FX-H05-07 | 2026-10-13 03:30 (UTC+3) | 2026-10-13 00:30Z | 2026-10-13 | 2026-10-13 | yes |
| FX-H05-08 | 2026-12-14 23:30 (UTC+2) | 2026-12-14 21:30Z | 2026-12-14 | 2026-12-14 | yes (control, winter) |
| FX-H05-09 | 2026-12-15 00:30 (UTC+2) | 2026-12-14 22:30Z | 2026-12-14 | 2026-12-15 | **no** (winter) |
| FX-H05-10 | 2026-12-15 01:59 (UTC+2) | 2026-12-14 23:59Z | 2026-12-14 | 2026-12-15 | **no** (winter) |
| FX-H05-11 | 2026-12-15 02:00 (UTC+2) | 2026-12-15 00:00Z | 2026-12-15 | 2026-12-15 | yes (boundary, winter) |
| FX-H05-12 | 2026-12-15 02:30 (UTC+2) | 2026-12-15 00:30Z | 2026-12-15 | 2026-12-15 | yes |
Reading: the two rules disagree for every event between local midnight and the offset (three hours in summer time, two in winter time) — the window the project record already calls "00–03 h Cairo". The summer/winter switch itself falls outside these rows (2026: summer time started on 2026-04-24 and ends on 2026-10-29 per the database); a fixture straddling the switch is **FX-H05-13 (to be added)** once Rule B is chosen, because Rule A is unaffected by it. Consumers to cover per rule: attendance day derivation, commission target date, payroll period membership of a day, GRNI/sub-ledger reconciliation date. Existing evidence: the sub-ledger path already uses Rule A (`3ef67f4`); the canonical serial regression after the 2026-09-21 fixes has no clean record (PA-14).

## FX-H04 — payroll posting shape (contract H0-4): inputs fixed, expected journal = OWNER
| ID | Input | Expected journal lines and amounts |
|---|---|---|
| FX-H04-01 | one employee, basic 4000.00, no commission, no deductions | OWNER (today: `Dr 5201 / Cr 2150` 4000.00 — measured, not policy) |
| FX-H04-02 | FX-H04-01 plus approved commission 200.00 in the period | OWNER (today: journal 4000.00, cash paid 4200.00 — measured, not policy) |
| FX-H04-03 | FX-H04-02, then disbursement of the run | OWNER: the disbursement entry, the wages-payable balance afterwards (today: no entry; balance unchanged — measured) |
| FX-H04-04 | disbursement fails for 1 of 3 employees | OWNER: partial-payment rule, remaining payable, re-issue entry |
| FX-H04-05 | a run of 1,000 lines with random cent amounts | property: sum of line amounts = journal total = cash paid, in exact decimal (today's floating-point path is unproven at this scale; PA-36) |
| FX-H04-06 | a fresh Company, template only | the Financial Event POSTS (verified since the 2026-10-13 template fix) |
| FX-H04-07 | a Company whose chart pre-dates the fix | REJECTED with the explicit reason; recovery by create/assign + re-drive (verified) |

## FX-H02 — absence, lateness, leave (H0-2): inputs fixed, pay effect = OWNER
One employee, monthly basic X, period of 30 days: (a) a full present month; (b) 1 absent day with no leave; (c) 1 approved annual-leave day; (d) 1 unpaid-leave day; (e) 3 late arrivals of 20 minutes; (f) 1 public-holiday day worked; (g) 1 missing-punch day; (h) an employee with no approved attendance batch. Expected pay effect for each: `OWNER` (today: none for all; `unclassified` for absent and missing punch; the employee in (h) is still paid — measured behaviour, ratified as a fail-safe).

## FX-H08 — commission reversal (H0-8): inputs fixed, rule = OWNER
Post an invoice → approve its commission → then, in turn: void the invoice; return part of it; credit it; each once before and once after the payroll cut-off of the period. Expected: automatic reversal or an item in a reviewed adjustment queue (OWNER), amounts, and what happens to commission already paid.

## FX-H01 / FX-H03 / FX-H07 / FX-H09 / FX-H06
Statutory computation (H0-1), payslip (H0-3), HR master (H0-7), salary visibility (H0-9) and disbursement (H0-6) need the owner's rule before any fixture can be more than a shell. Reusable shells: H0-1 — one golden payroll per rule at each cap, bracket edge and effective-date edge; H0-3 — one payslip per run state (calculated, approved, posted, disbursed, adjusted); H0-7 — per capability one create/read/update/archive flow plus an A/B Company isolation check; H0-9 — role × route matrix over the payroll and payslip routes; H0-6 — one payment batch with accept, partial, reject and re-issue.

## FX-M0 — Manufacturing
| ID | Input | Expected |
|---|---|---|
| FX-M03-01 | a Work Order for 10 units; 8 produced; the 2-unit shortfall is genuine scrap | OWNER (today the only legal close is a material return of the unused components, which would add scrapped material back to stock — the case to avoid) |
| FX-M03-02 | the same shortfall is genuinely unused material | a material return closes it; stock and moving-average cost are restored exactly (verified behaviour of ADR-061) |
| FX-M04-01 | traceability of a finished unit to component lots | OWNER (no lot/serial exists today) |
| FX-M05-01 | two Work Orders compete for one Work Center on the same day | OWNER (no capacity model exists today) |
| FX-M06-01 | fresh Company, template only, Work Order issue/return/output | all three events POST (verified for `wip`, H2); a template that lacks `grni` or `fixed_asset` rejects the corresponding events — still open |

## Use
When an owner answers a contract question, the matching fixture gets its expected value, becomes a test written against the pinned baseline, and enters the Phase 1 verification set (clean snapshot of a named commit, independent review of the gate evidence).
