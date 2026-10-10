# Stage 2 — Build Order

Status: **ACTIVE.** Foundation before Business Modules, always — no step below may be skipped or reordered without a disclosed reason (governance rule 5).

---

## Phase A — Platform Foundation (build once, depended on by everything)

| # | Item | Depends on | Architectural contract |
|---|---|---|---|
| 1 | Repository / project structure | ADR-002 | RMS generator/validator tooling (Class A), adapted; domain-boundary folder layout per `DAII_DOMAIN_BOUNDARIES.md` |
| 2 | Backend stack bootstrap | 1 | ADR-002 (NestJS + TypeScript), `planning/stage-1/STAGE_1_STACK_DECISION.md` |
| 3 | PostgreSQL foundation | 2 | ADR-003, `DAII_DATA_ARCHITECTURE.md` |
| 4 | Configuration Engine | 3 | `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §8 |
| 5 | Identity | 3, 4 | `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §1 |
| 6 | Authentication | 4, 5 | ADR-004, `DAII_SECURITY_ARCHITECTURE.md` §2 |
| 7 | Authorization | 5, 6 | ADR-005, `DAII_SECURITY_ARCHITECTURE.md` §3 |
| 8 | Permission Engine | 7 | `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §4 |
| 9 | Scope Engine | 7, 8 | `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §5 |
| 10 | Organization | 5 | `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §7 |
| 11 | Audit | 3 | ADR-012, ADR-017, `DAII_FOUNDATION_CROSSCUTTING_SPEC.md` §1 |
| 12 | Events (outbox) | 3, 11 | ADR-012, `DAII_EVENT_ARCHITECTURE.md` |
| 13 | Error Contract | 2 | `DAII_API_ARCHITECTURE.md` §2, `DAII_FOUNDATION_CROSSCUTTING_SPEC.md` §6 |
| 14 | Idempotency | 3, 12 | `DAII_FOUNDATION_CROSSCUTTING_SPEC.md` §5 |
| 15 | Observability | 2 | `DAII_FOUNDATION_CROSSCUTTING_SPEC.md` §3 |
| 16 | Terminology / i18n | 4 | ADR-011, `DAII_I18N_TERMINOLOGY_ARCHITECTURE.md` |
| 17 | Numbering | 3, 12 | ADR-007 (numbering), `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §12 |
| 18 | Process Engine contract | 11, 12 | ADR-008 |
| 19 | Shared infrastructure adapters | 3, all above | ADR-015, ADR-019, `DAII_INFRASTRUCTURE_ABSTRACTION.md` |
| 20 | Foundation tests | every item above | `DAII_FOUNDATION_CROSSCUTTING_SPEC.md` §4 |

**No Business Domain work begins until Phase A items 1–19 exist in a running, testable state (item 20 confirms this).** This is the single most important sequencing rule in Stage 2, restated from the CTO directive: "Do not start Sales Orders before the Foundation contracts required by them exist."

## Phase B — Business Domains (in dependency order)

| # | Domain | Depends on Phase A | Depends on other Phase B domains |
|---|---|---|---|
| 21 | Commerce (Catalog) | 4, 10 | none |
| 22 | Customers (CRM) | 9, 10 | none |
| 23 | Sales Reps (Sales) | 5, 9, 10 | none |
| 24 | Sales Orders | 8, 9, 17, 18 | 21, 22, 23 |
| 25 | Approval (workflow instance of Process Engine) | 18 | 24 |
| 26 | Deposit Control | 12, 16 | 24, 25 |
| 27 | Inventory & Warehouse | 3, 9 | none (parallel to 21-26) |
| 28 | Fulfillment | 9, 12 | 24, 26, 27 |
| 29 | Shipment | 9, 12 | 28 |
| 30 | Tracking (Waybill) | 12 | 29 |
| 31 | Delivery | 12 | 29, 30 |
| 32 | Returns | 9, 12 | 24, 27, 29 |

Items 21–23 and 27 may proceed in parallel once their Phase A dependencies are met — they do not depend on each other. Items 24 onward are strictly sequential per the dependency column.

## Explicit Non-Goals for Stage 2 (per this directive §4, unchanged from blueprint §49)

- Finance/Accounting implementation (ADR-018 defines the boundary only)
- Full offline-first mobile (ADR-013/`DAII_MOBILE_ARCHITECTURE.md` §4 — flagged as a later commitment)
- On-Premise installer/packaging (ADR-019 defines ports only, no adapters built)
- UI implementation of any kind — Stage 2 is server/API/data only until Phase B domains have working contracts
