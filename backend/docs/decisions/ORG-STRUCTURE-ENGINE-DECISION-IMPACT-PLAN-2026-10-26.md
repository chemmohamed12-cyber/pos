# Org-Structure Engine — Decision → implementation impact plan (Phase 3 of the Final Closure Directive, prepared ahead of the decisions)

**Purpose:** when an owner signs a decision, engineering knows exactly what it means in code, data, permissions and tests — and keeps each decision as a **separate, reviewable work package** (WP-A … WP-E), never one combined change. **No work package is started; nothing here is a decision.** The candidate `a4e0daf` is never edited; each WP is a branch off the *integrated* tree (Phase 4), compared against the candidate.
Verified facts used below: the journal handlers already copy `event.orgUnitId` into the journal draft (`financial-events/finance-handlers.ts`, `manufacturing-events.handler.ts`, `payroll-run-posted.handler.ts`), so attributing a whole event to one unit is a **publisher-side** change; attributing different lines of one event to different units is a **handler-shape** change. The scope check (`OrgContextService`, `AccessScopeService`) is the single access-decision point and must stay the only one.

| WP | If the owner chooses… | Code / contract change | Data change | Permissions | Backward compatibility | Mandatory tests (beyond the existing suite) |
|---|---|---|---|---|---|---|
| **WP-A Supplier payments** | **A** bank account's branch | publisher `supplier-payment.service.ts`: `orgUnitId` from the paying account (no handler change) | none to history; new events carry the unit | none new | events published before keep `null`; no rewrite | branch of account assigned / unassigned; org report AP-by-branch vs supplier ledger; payment reversal (1.1.13 line) mirrors |
| | **B** invoice branches | **event contract + handler**: one AP line group per allocation branch, bank line on the account's branch (CTO) | none to history | none new | payloadVersion bump; old events still handled | mixed-branch allocation sums to payment; rounding; unassigned invoice; void/reversal mirror; ledger-vs-GL reconciliation |
| | **C** company level | none (document the decision) | none | none | — | assert current behaviour stays (regression guard) |
| **WP-B Collections** | **A** order/shipment branch | `delivery.service.ts` remit publisher reads the shipment's `branchOrgUnitId` | none | none | old events `null` | vehicle ≠ order branch; unassigned shipment; partial remittance |
| | **B** vehicle/custody account branch | publisher reads the custody account's `orgUnitId` | none | none | same | custody balance report = open collections; remittance to another branch |
| | **C** receiving account's branch | publisher reads the receiving account | none | none | same | remittance into a third branch |
| | **+ clearing account** | new accounting configuration + inter-branch posting (CTO) | new account/mapping | finance-admin only | opt-in per company | clearing nets to zero across branches |
| **WP-C Manufacturing** | **A/B** warehouse branch | publishers in `work-order.service.ts` add `orgUnitId` from the chosen warehouse; the WIP warehouse is created with that branch | none to history | none | old events `null` | full cycle issue→WIP→receipt carries branch; cross-branch component rule; costs unchanged |
| | **C** work-center branch | **data model**: `work_centers.orgUnitId` + validation + UI (CTO) | new column (additive) | scope by work center | additive | work-center branch required/optional per decision |
| **WP-D Payroll** | **A** employee branch | `payroll.run.posted` event + `payroll-run-posted.handler.ts` to emit per-branch line groups (CTO); rule for no-department and transfers | none to history | HR sees own branches | payloadVersion bump | two-branch run sums to total; no-department bucket; mid-period transfer; payslip amounts unchanged |
| | **C** run-level unit | new attribute on the run (CTO) | new column | follows the unit | additive | run total attributed once |
| | **B** company level | none | none | none | — | regression guard |
| **WP-E Department-only scope** | **A** grant branch scope too | none (operational runbook) | none | none | — | document + negative tests already in `org-context.real-pg.spec` |
| | **B** derive branch + widen visibility | `OrgContextService.resolveBranch` (ancestor derivation) **and** `AccessScopeService` visibility rule (security review) | none | **widens access** | feature-flagged recommended | dept user sees only the branch records the decision allows; sibling-department negative cases; admin grants unchanged; cross-company negatives |
| | **C** department-level stamp | model change on stamped documents (CTO) | new column(s) | new scope key | additive | full re-verification of stamping chain |

## Cross-cutting rules for every WP
1. One branch/PR per WP, reviewed separately; each starts from the integrated tree and records its own commit.
2. A WP is created **only** from a signed decision; "keep as today" decisions get a regression-guard test, not code.
3. Any WP that changes an event payload bumps its version and keeps the old handler path (no rewrite of historical events or postings).
4. Access-widening changes (WP-E B) ship with the negative tests first and are never combined with other WPs.
5. Each WP ends with: registry spec on 5544, full regression, migration up/down on a disposable database (if it adds a migration), browser acceptance where the UI changes — all on the WP's own final commit.
6. The organizational report's definitions (`org-report.service.ts`) are updated in the same WP only when the new attribution changes a column's meaning, and the change is stated in the report's metric definition.
