# DAII — One consolidated request to the decision owners — 2026-10-13

**Purpose.** Everything the engineering team needs from people, in one batch, so no owner is asked twice. Nothing here is assumed approved; silence is not approval. Each item states the question, the exact decision needed, the responsible functional role (a title — the CTO assigns the person), what it unblocks, and what continues meanwhile. Supporting detail is in the linked documents; this page is the index of asks. Official status is unchanged: N-02, PA-33, PA-43 OPEN · independent review PENDING · CI PASS only for the run on `715c22d` · release NOT APPROVED.

## A. Technical questions already answered by the team (no owner input needed — for information)
| # | Question | Answer | Evidence |
|---|---|---|---|
| T1 | Does payroll really post only gross pay, and does disbursement really create no ledger entry? (PA-34/35) | Yes, measured at runtime on a disposable database: journal = gross only; commission (200 of 5200 net) is in no journal; disbursement paid 5200 cash and created 0 financial events | `evidence-clean-snapshot-2026-10-13/3bf740b-wp-pay-01/` |
| T2 | Does a fresh Company have the account payroll needs? | No: the run reaches `posted` but its Financial Event is REJECTED ("no Wages Payable control account") | same |
| T3 | Does floating-point payroll arithmetic drift? (PA-36) | Not shown with 12 cent-valued lines; not excluded for larger runs | same |
| T4 | Does the F-INV-001 usage collector work against a real PostgreSQL? | Yes, on a synthetic fixture (read-only transaction, correct "live consumer" signal). **Not** a real measurement | `evidence-clean-snapshot-2026-10-13/f-inv-001-collector-rehearsal/` |
| T5 | What would the non-breaking dependency tier change, and does the project still build, lint and pass its unit tests with it? | See `DAII-DECISION-PACKAGE-2026-10-13.md` §DEC-20 (rehearsal in a scratch copy; the repository is untouched) | `evidence-clean-snapshot-2026-10-13/dependency-t1-rehearsal/` |

## B. Decisions requested (grouped by role)

### B1. `CTO`
| # | Item | Decision needed (exact) | Unblocks / meanwhile |
|---|---|---|---|
| C1 | DEC-02 already-broken audit chains | Choose (a) accept-and-annotate (recommended) or (b) authorised repair, in writing | WP-AUD-05/07, Phase 1 gate; meanwhile: no rewrite |
| C2 | DEC-01b realignment functions | Name the holders for `AUDIT_DB_OPERATOR`, `AUDIT_CHANGE_APPROVER`, `AUDIT_INDEPENDENT_REVIEWER`, `AUDIT_OPS_ESCALATION_OWNER` (three different people at least) | any future realignment; meanwhile none is permitted |
| C3 | DEC-20 dependency | **T1 was executed under the CTO directive of 2026-10-13** (`8ec6de4`, verified — `evidence-clean-snapshot-2026-10-13/8ec6de4-final-verification/`). Still needed: name the T2 owner (`DAII-DEPENDENCY-T2-OUTLINE-2026-10-13.md`); confirm the host proxy check; assign a reviewer for the lockfile diff | the security gate before the Phase 1 gate |
| C4 | DEC-25 UUID repair vs audit hash | Keep the interim prohibition and approve the read-only need check (see D1), or decide differently | PA-43 |
| C5 | DEC-06 business date | UTC helper or Cairo | H0-5; fixtures for attendance/commission/payroll |
| C6 | D-04 integrations | Authorise implementation (or keep on hold) and answer the plan's [REVIEW] items; name the module owner | PA-20 |
| C7 | DEC-10 F-INV-001 | Name the read-only operator and the databases; later decide the 410 release after the measurement | release of the 410 contract |
| C8 | DEC-19 LA-1 | Assign an owner to each of the 6 files / 10 call sites (`DAII-LA1-REMAINING-SITES-TRACKER-2026-10-13.md`) and answer its three design questions (revoke while not READY; package role-sync while not READY; the view-context request path) | PA-41 |
| C9 | DEC-11 capacity / staging | Provide a staging-like host, a separate load-generator machine, a named load-test authoriser; sign or replace the capacity targets | PA-24/PA-26 |
| C10 | Reviewer | Nominate an eligible independent reviewer (profile in `DAII-INDEPENDENT-REVIEW-EVIDENCE-PACKAGE-INDEX-2026-10-11.md` §3.2), or record the continued deferral | acceptance of N-02, PA-33, WP-INV-10, WP-AUD-08 |
| C11 | CI | Classify the documented CI result for `715c22d` (official line still reads "CI NOT GREEN") | release gate |
| C12 | M0-6 | `wages_payable` is **done** for new Companies (`d3ad24b`, `WAGES-PAYABLE-CONTROL-ACCOUNT-TEMPLATE-2026-10-13.md`); still to open or decline, in what order: template completeness for `grni` and `fixed_asset`, the H2-R recovery audit for Companies provisioned before the fixes (including applying the documented recovery to existing Companies), Event Engine batching | payroll/inventory/fixed-asset posting in new and existing Companies |

### B2. `ACCOUNTING_POLICY_OWNER`
| # | Item | Decision needed |
|---|---|---|
| A1 | H0-4 payroll posting shape (DEC-03) | the posting amount (gross; gross + commission; tax/insurance split later) — T1 shows today = gross only; the disbursement entry and partial/failed disbursement; wages-payable reconciliation and closing-audit category |
| A2 | DEC-04 commission | expense account, recognition timing, reversal rule (links H0-8) |
| A3 | H0-8 reversal | automatic reversal on void/return/credit vs a reviewed adjustment queue; payroll cut-off interaction |
| A4 | M0-2 costing | is standard costing, variance accounting or labour/overhead absorption required (today: moving average, material only, by ratified exclusion) |
| A5 | M0-6 | the account set for template completeness (with C12) |

### B3. `PAYROLL_POLICY_OWNER` (statutory/legal) and `HR_OWNER`
| # | Item | Decision needed |
|---|---|---|
| P1 | H0-1 / DEC-05 | jurisdiction; overtime, income tax, social insurance, other deductions, end-of-service rules; rates/caps/brackets; effective dates; table owner and signatory |
| P2 | H0-2 | holiday/working-day calendar owner; pay effect of absence, lateness, unpaid leave, missing punches; whether employees without an approved attendance batch are paid |
| P3 | H0-3 / DEC-23 | payslip content, numbering, approval, access, print/export, retention |
| P4 | H0-7 / DEC-18 | which HR master capabilities are confirmed (contracts, documents, leave types/balances, shifts, loans, end-of-service) |
| P5 | H0-9 / DEC-23 | who sees salary data, at what granularity (with `SECURITY_AUDIT_OWNER`) |

### B4. `TREASURY_OWNER`
| # | Item | Decision needed |
|---|---|---|
| R1 | H0-6 / DEC-24 | how employees are paid (bank file and format, cash, wallet); data held per employee; partial payment; rejection and re-issue |

### B5. `MANUFACTURING_OWNER`, `INVENTORY_OWNER`, `PRODUCT_OWNER`
| # | Item | Decision needed |
|---|---|---|
| M1 | M0-3 scrap/rework/by-products | is physical scrap expected in target use? (today a short Work Order can only be closed by a material return, which would wrongly re-inflate stock and cost if the shortfall was real scrap) — **answer early** |
| M2 | M0-1 planning | the contract with Sales (demand) and Procurement (requisitions); what is explicitly deferred to Wave 5 |
| M3 | M0-4 lot/serial | confirmed or withdrawn; interface with movements, reservations, returns, valuation |
| M4 | M0-5 capacity scheduling | finite-capacity scheduling required, and the boundary with M2 |

### B6. `SECURITY_AUDIT_OWNER`
| # | Item | Decision needed |
|---|---|---|
| S1 | DEC-02 co-signature | with C1 |
| S2 | DEC-25 | with C4 |
| S3 | H0-9 | with P5 |

## C. Resources and access requested
| # | Resource | Role | Needed for |
|---|---|---|---|
| D1 | A read-only database role (CONNECT + SELECT on `users`, `org_units`, `audit_records`, `data_repair_runs`; read-only by default; no superuser; expiring) **and an explicit list of databases** (name, server, kind, no production data) | `ENVIRONMENT_OWNER` + DBA | PA-43 need check, DEC-02 inventory |
| D2 | A read-only operator and role for every Company database in scope (including production only by separate approval) | `READ_ONLY_OPERATOR` | F-INV-001 measurement (C7) |
| D3 | Staging-like host, separate load generator, named load-test authoriser | `ENVIRONMENT_OWNER`, `LOAD_TEST_AUTHORISER` | capacity verification (C9) |
| D4 | An eligible independent reviewer with repository and evidence read access only | `CTO` / team coordinator | all independent acceptances (C10) |

## D. What continues while these are pending
Documentation and contract preparation; dependency rehearsal; LA-1 and D-04 readiness; evidence reconciliation; register upkeep. No implementation starts without its approval. No real-database operation, repair or realignment is performed.
