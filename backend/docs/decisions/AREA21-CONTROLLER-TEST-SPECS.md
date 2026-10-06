# Area 21 — Per-Controller Real-PG Test Specifications (the 43)

**Status: PREPARATION — not implementation.** No controller code is
touched by this document. This is the CTO-authorized "Real-PG
Verification Framework" (Retrofit Preparation point 3/6): a concrete test
plan per controller, built now, so that once Retrofit Authorization is
given the flow is `Implement → run the plan below against the two-company
harness → analyze → fix → re-run`, never `Implement → figure out what to
test`. Companion to [AREA21-RETROFIT-MATRIX.md](AREA21-RETROFIT-MATRIX.md)
— read that document's §1.4 first; this document applies its Tests A–F
methodology concretely, controller by controller.

## Shared methodology (fixed once, not repeated per controller)

Per [§1.4](AREA21-RETROFIT-MATRIX.md), every one of the 43 gets the same
six tests, built on [`two-company-real-pg-harness.ts`](../../src/foundation/testing/two-company-real-pg-harness.ts):

- **Test A (positive):** Company A user → Company A's own resource → ALLOW, returned data is genuinely Company A's.
- **Test B (cross-company):** Company A user → a Company B resource id → DENY, **and** assert `CompanyConnectionManagerService.getDataSource` was never called with Company B's id (not just "zero rows").
- **Test C (no company context):** request with no resolvable Company (e.g. a user with zero memberships) → DENY.
- **Test D (revoked membership):** membership revoked between login and request → DENY.
- **Test E (wrong-company resource id):** a syntactically valid id belonging to a different Company → DENY, same DB-never-selected proof as Test B.
- **Test F (DB routing):** spy/poisoned-ambient proof that the Platform DataSource is never touched for a Company-scoped read once `CompanyContextGuard` resolves a Company.

**Per-controller, this document fixes:** the migration tag(s) the harness
must provision (`extraCompanyTags`), the Tier (from the Matrix §1.2 —
determines whether a service-layer `manager?:` change is needed before
guard work, or only guard + threading), and which of the controller's
resources stands in as "the" Company-scoped resource for Tests A/B/E. It
deliberately does **not** assert exact route strings/HTTP verbs beyond
what the Matrix's §1.2 already verified (the route prefix) — pinning
down the exact representative endpoint signature is implementation-time
work against current source, not asserted here as unverified fact.

**Module code note:** `extraCompanyTags` below uses the controller's own
`@RequireModule(...)` code, confirmed by grep against
`src/domains/**/interface/*.controller.ts` on 2026-09-26 — this is real,
sourced evidence, not inferred from the domain folder name. Three
controllers have no `@RequireModule` at all (flagged `— none found,
[§2.6]`); their migration tag is inferred from domain folder only and
marked **UNVERIFIED** until §2.6 is resolved.

## Tier 1 (13) — service(s) already `manager?:`-capable; retrofit is guard + threading only

| Controller | Route | `extraCompanyTags` | Representative resource | Notes |
|---|---|---|---|---|
| `general-ledger.controller.ts` | `accounting` | `accounting` | A journal entry / GL account id | `JournalEntryService`/`LedgerService` capable; `ExcelService`/`FinancialEventService`/`FinancialReportingService` are not — those code paths stay Tier-2-style even inside this Tier-1 controller |
| `customer-ledger.controller.ts` | `customer-finance` | `sales` (UNVERIFIED — no `@RequireModule`, §2.6) | A customer id | `CustomerLedgerService` fully capable |
| `invoices.controller.ts` | (no class prefix) | `finance` | An invoice id | `InvoiceService` fully capable |
| `payments.controller.ts` | (no class prefix) | `finance` | A payment id | `PaymentsService`/`EventBusService` capable; `IdempotencyService` not — idempotency-key paths need Tier-2-style follow-up |
| `inventory-valuation.controller.ts` | `inventory/valuation` | `inventory` | A valuation run/product id | `InventoryValuationService` fully capable |
| `inventory.controller.ts` | `inventory` | `inventory` | An inventory item/warehouse id | `InventoryService` capable; `ExcelService` not |
| `supplier-invoice.controller.ts` | `procurement/supplier-invoices` | `procurement` | A supplier invoice id | `SupplierInvoiceService` fully capable |
| `supplier.controller.ts` | `procurement/suppliers` | `procurement` | A supplier id | `SupplierLedgerService` capable; `SupplierService` not |
| `returns.controller.ts` | `returns` | `logistics` | A return id | `ReturnsService` fully capable |
| `sales-orders.controller.ts` | `sales-orders` | `sales` (UNVERIFIED — no `@RequireModule`, §2.6) | A sales order id | `SalesOrdersService` fully capable; also the scheduler-adjacent controller from Matrix §3 (`PreliminaryHoldExpiryScheduler`) — retrofit here must not regress that already-VERIFIED background path |
| `shipment.controller.ts` | `shipments` | `logistics` | A shipment id | `ShipmentService` fully capable |
| `treasury.controller.ts` | `treasury` | `finance` | A treasury account/transaction id | `TreasuryService` capable; `IdempotencyService` not |
| `accounting.controller.ts` | `accounting` | `accounting` | A closing snapshot id | `ClosingSnapshotService`/`PermissionService` capable (per ADR-074); 6 co-injected services are not — largest mixed-capability controller in Tier 1 |

## Tier 2 (30) — zero manager-capable services; needs service-layer `manager?:` work first, then guard + threading

| Controller | Route | `extraCompanyTags` | Representative resource |
|---|---|---|---|
| `ap.controller.ts` | `accounting/ap` | `accounting` | An AP adjustment/reconciliation id |
| `ar.controller.ts` | `accounting/ar` | `accounting` | An AR adjustment/reconciliation id |
| `cash-bank.controller.ts` | `accounting/cash-bank` | `accounting` | A cash/bank adjustment id |
| `fixed-asset.controller.ts` | `accounting` | `accounting` | A fixed asset id |
| `grni.controller.ts` | `accounting/grni` | `accounting` | A GRNI reconciliation id |
| `inventory-accounting.controller.ts` | `accounting/inventory` | `accounting` | An inventory adjustment id |
| `wip.controller.ts` | `accounting/wip` | `accounting` | A WIP reconciliation id |
| `attendance.controller.ts` | `attendance` | `attendance` | An attendance record id |
| `bom.controller.ts` | `bom` | `sales` | A BOM id |
| `price-lists.controller.ts` | `price-lists` | `sales` | A price list id |
| `products.controller.ts` | `products` | `sales` | A product id |
| `commission.controller.ts` | `commission` | `commission` | A commission policy/record id |
| `customers.controller.ts` | `customers` | `sales` | A customer id |
| `delivery.controller.ts` | `delivery` | `logistics` | A delivery id |
| `deposits.controller.ts` | `deposits` | `sales` | A deposit id |
| `fulfillment.controller.ts` | `fulfillment` | `logistics` (UNVERIFIED — no `@RequireModule`, §2.6) | A fulfillment id |
| `hr.controller.ts` | `hr` | `hr` | An employee record id |
| `warehouse-transactions.controller.ts` | `warehouse-transactions` | `inventory` | A warehouse transaction id |
| `work-order.controller.ts` | `manufacturing/work-orders` | `manufacturing` | A work order id |
| `payroll.controller.ts` | `payroll` | `payroll` | A payroll run id |
| `goods-receipt.controller.ts` | `procurement/goods-receipts` | `procurement` | A goods receipt id |
| `purchase-order.controller.ts` | `procurement/purchase-orders` | `procurement` | A purchase order id |
| `purchase-request.controller.ts` | `procurement/purchase-requests` | `procurement` | A purchase request id |
| `rfq.controller.ts` | `procurement/rfqs` | `procurement` | An RFQ id |
| `supplier-payment.controller.ts` | `procurement/supplier-payments` | `procurement` | A supplier payment id |
| `reports.controller.ts` | `reports` | **multiple — not yet enumerated** | N/A — see note below |
| `sales-returns.controller.ts` | `sales-returns` | `logistics` | A sales return id |
| `shipment-returns.controller.ts` | `shipment-returns` | `logistics` | A shipment return id |
| `sales.controller.ts` | `sales/reps` | `sales` | A sales rep profile id — **do not conflate with §2.3's platform-level `sales_rep` role finding; this is `SalesRepProfile`, a distinct, already Company-domain-shaped entity** |
| `target.controller.ts` | `targets` | `targets` | A target id |

**`reports.controller.ts` note:** module code `reporting` has no corresponding migration-tag folder (confirmed — `src/database/migrations/` has no `reporting/` directory), consistent with it being a cross-cutting read surface over other domains' tables rather than owning its own schema. Its test plan needs the migration tags of whatever domains its specific reporting endpoints actually query — not determined in this pass; flagged as **UNVERIFIED / needs a dedicated read of `reports.service.ts`'s query targets** before its own harness fixture can be finalized. This does not block the other 29 Tier 2 plans.

## Isolation-assertion helpers (harness extension, safe/non-destructive — built this pass)

Two reusable assertion helpers were added to the harness
(`src/foundation/testing/two-company-real-pg-harness.ts`) so each of the
43's eventual Test B/E/F does not hand-roll the same spy/poisoned-ambient
logic 43 times:

- `assertDataSourceNeverRequestedFor(connections, companyId, fn)` — wraps `CompanyConnectionManagerService.getDataSource` with a spy for the duration of `fn`, runs `fn`, then asserts the spy was never called with `companyId`. Directly implements Test B/E's "DB never even selected" bar.
- `assertDistinctCachedDataSources(harness)` — asserts `dsA !== dsB` and each `.options.database` matches the expected per-Company name, generalizing the existing self-test's isolation-contract assertion (§7) into a reusable call for any future per-controller spec.

Both are self-tested (2/2 new passing cases in
`two-company-real-pg-harness.spec.ts`) against real Postgres. Neither
touches, mocks, or bypasses any production code path — they wrap the
same real `CompanyConnectionManagerService` every other real-PG spec in
this program already uses.

## What this document is not

Not a decision on the 5 Mixed/Special (companion Matrix §2 covers those
separately — none of the 43 here include them). Not runnable test code
for all 43 (only the harness + its 2 new helpers are actual code; the
tables above are specifications, to be turned into real `.spec.ts` files
per controller once Retrofit Authorization is given and CODE→TEST
begins on that specific controller). Not a claim that every
`extraCompanyTags`/representative-resource choice above is exhaustive —
each is the minimum needed to run Tests A–F, not a full functional test
suite for the controller.
