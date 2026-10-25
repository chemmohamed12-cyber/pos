# Contract Gate — reconciliation of the 20 findings and remaining policy decisions — 2026-10-25

**Status:** PROPOSED (companion to `ADR-070/071/072-ADDENDUM-1`, all "PROPOSED — NOT APPROVED"). Original ADR texts and headers are untouched. Nothing here is an approval of ADR-070/071/072.
**Source of findings:** `HR_PAYROLL_PHASE0_FOUNDATION_AND_BASELINE_REPORT_2026-10-25.md` §3.1.
**Legend:** **Closed-in-addendum** = a contract clause now exists (still needs CTO approval and later implementation + executed tests) · **Needs-owner** = clause exists but a value/policy is an owner decision · **Noted** = no contract change needed.

| Finding | Addressed by | Status after this gate | Remaining dependency |
|---|---|---|---|
| X-1 commission period attribution vs carry-forward | 071-ADD A-1 (attribution vs availability, selection rule object) | Closed-in-addendum | **Needs-owner**: attribution date per basis, carry-forward rule (P-1) |
| X-2 no once-only consumption | 071-ADD A-2 (DB unique partial index, reservations, CAS) | Closed-in-addendum | — (design), tests later |
| X-3 adjustment mechanics | 071-ADD A-3, 072-ADD §1.4 | Closed-in-addendum | Needs-owner: negative balance/clawback (P-4) |
| X-4 recalculation vs unique run per period | 070-ADD A-4 (revision) | Closed-in-addendum | Needs-owner: accounting of supplementary delta (D-3) |
| X-5 `populationScope` | 070-ADD A-5 (withdrawn; company population) | Closed-in-addendum | — |
| X-6 maker/checker wording unenforceable | 070-ADD A-6 + 072-ADD §2 (actor per stage, floor + profiles) | Closed-in-addendum | Needs-owner: profile per Company, waiver authority (D-6) |
| X-7 disbursement ledger effect undefined | 070-ADD A-7 + 072-ADD §4 | Closed-in-addendum | **Needs-owner**: event/entry, Treasury idempotency prerequisite E-1, cash-account↔ledger mapping E-2 |
| X-8 posted amount basis | 070-ADD A-8 (invariants) + 072-ADD §3 | Needs-owner | Accounting: amounts/accounts/commission timing (DEC-03/04, H0-4) |
| X-9 rejected-approval path missing | 070-ADD A-9 | Closed-in-addendum | — |
| X-10 `recalculate` transition | 070-ADD A-4 R-4 (ratified) | Closed-in-addendum | — |
| X-11 `PayrollCalendarPolicy` absent | 070-ADD A-10 (fail-safe kept; unclassified = acknowledged exception) | Needs-owner | H0-2 / DEC-06 |
| X-12 exceptions vs "run not blocked" | 070-ADD A-9/A-10 + closure report §6 | Closed-in-addendum | Needs-owner: final class per exception |
| X-13 collection event | 071-ADD A-10, 072-ADD §5 | Closed-in-addendum (documented actual) | tests |
| X-14 `net_sales` undefined | 071-ADD A-11 (disabled) | Closed-in-addendum | Needs-owner: composition (P-5) |
| X-15 `customer_group` inert | 071-ADD A-11 (disabled) | Closed-in-addendum | Needs-owner: CRM source (P-6) |
| X-16 PayrollPeriod lifecycle | 070-ADD A-9 | Closed-in-addendum | Needs-owner: closure trigger (D-5) |
| X-17 permission nodes naming | 070-ADD A-10 | Closed-in-addendum | — |
| X-18 attendance handoff path | 070-ADD A-10, 072-ADD §5 | Closed-in-addendum (documented actual) | Needs-owner: coverage policy (H0-2) |
| X-19 reconciliation invariant consistent | — | Noted | Extended by payout reconciliation (A-7) |
| X-20 dependency graph acyclic | — | Noted | — |

**Coverage of the CTO's A-1…A-11:** A-1/A-2/A-3 → 071-ADD (+072-ADD §1) · A-4/A-5/A-6/A-7/A-8/A-9 → 070-ADD · A-10 → 070-ADD, 071-ADD, 072-ADD §5 · A-11 → 071-ADD. All eleven have a clause with invariants, entities/events, compatibility notes and acceptance tests. None is implemented.

## Remaining policy decisions (owners; none is defaulted in code)
| ID | Decision | Owner | Blocks |
|---|---|---|---|
| D-2 | payout event name/shape; Treasury idempotency; cash-account↔ledger mapping | ACCOUNTING_POLICY_OWNER + TREASURY_OWNER | payout gate |
| D-3 | posting basis/accounts, commission timing (DEC-04), business date, closed-period recovery, supplementary delta | ACCOUNTING_POLICY_OWNER + Finance + CTO | posting gate |
| D-5 | period closure trigger (posted vs fully disbursed) | PAYROLL_POLICY_OWNER + Accounting | period lifecycle |
| D-6 | SoD profile per Company; waiver authority; single-user Companies | SECURITY_AUDIT_OWNER + Finance | Payroll core |
| P-1 | commission attribution date and carry-forward | ACCOUNTING_POLICY_OWNER + HR_OWNER | commission gate |
| P-2 | settlement channel (payroll or other) | same | commission gate |
| P-3 | commission expense timing/accounts | ACCOUNTING_POLICY_OWNER | posting gate |
| P-4 | reversal after payment, negative balances | same + legal | commission gate |
| P-5 | net-sales composition | ACCOUNTING_POLICY_OWNER | `net_sales` enablement |
| P-6 | customer-group source | CRM owner / CTO | `customer_group` enablement |
| H0-1 | statutory deductions | PAYROLL_POLICY_OWNER + payroll accountant + legal | any deduction |
| H0-2 / DEC-06 | calendar, attendance coverage, business date | HR_OWNER + PAYROLL_POLICY_OWNER + CTO | attendance gate |
| H0-3 / H0-9 | payslip, salary visibility | HR_OWNER + SECURITY_AUDIT_OWNER | UX/self-service |
| Guard | ambient test database name pattern (T-1 follow-up) | CTO / guard owner | HR/Attendance functional baseline |

## Next sequential step (not started)
CTO review and approval of the three addenda (as a set) → record final approval status of ADR-070/071/072 (only then edit headers) → owners resolve the decisions above → Payroll/Commission gap-closure gates, one at a time, each with a written scope and executed tests.
