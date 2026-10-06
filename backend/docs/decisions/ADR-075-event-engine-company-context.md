# ADR-075 — Event Engine Company Context (D10)

**Status: IMPLEMENTED — REAL-PG VERIFIED — CLOSED (2026-10-04); verification record in §7. CTO-authorized gate "D10 — Event Engine Company Context" (P0 / CRITICAL).**
Realizes Option **A** of Area 21 Decision Package 2 / Matrix §50. Rejects B (Platform outbox + `companyId` envelope: breaks the transactional-outbox guarantee) and C (leave as is).

## 1. Problem (proven by execution, not only by reading)

`EventBusService.publish(manager, …)` writes the outbox row through the caller's manager, so for a Company-routed request the row lands in **that Company's** `event_outbox`. `dispatchPending` then invoked `handler(row.payload)` with no manager and no Company id; every subscriber is a singleton using its own ambient `DataSource`.

Executed proof (`event-engine.company-isolation.spec.ts`, BASELINE test, run against unmodified code, real Postgres, two Company DBs + a control-plane DB acting as the ambient connection): an event published inside Company A and dispatched with A's manager returned `{ dispatched: 0, failed: 1 }` — the GL handler ran against the ambient connection (which has no accounting tables). No journal was produced. Consequence: **every automatic GL journal for a Company-routed operation was not Company-correct** (either never ran, or ran in the wrong database).

## 2. Decision

Required end state (CTO): `Event → Company context → Company event processing → Company DataSource → GL`; *Company A event → Company A DB, Company B event → Company B DB, never the shared/default DB*. Connection-level isolation (Model B) stays; no `companyId` column is added to any entity.

1. **Handler context.** `EventHandler = (payload, ctx: EventContext) => Promise<void>` with `EventContext = { manager: EntityManager | null; companyId: string | null }`. `manager === null` ⇒ ambient/Platform processing (legacy behavior, unchanged).
2. **Handler scope (sub-decision 1 — subscriber classification).** `subscribe(topic, handler, { scope })`, `scope: 'ambient' | 'company'`, **default `'ambient'`** (backward compatible, safe-by-default).
   - `'company'` handlers receive the Company `manager`/`companyId` and MUST use `ctx.manager` for every read/write.
   - Under a **Company dispatch**, `'ambient'` handlers are **not run** (running them would write/read the wrong database — the §50(b) failure). Under an **ambient dispatch**, all handlers run, exactly as before.
   - Migrated in this ADR to `'company'`: `FinancialEventService` (all `SUBSCRIBED_TOPICS` — every automatic GL journal), `ShipmentService` (`fulfillment.ready-for-dispatch`), `PriceListsService` (`commerce.product.created`).
   - Left `'ambient'` (documented, not silently dropped — see §5): the approval-callback subscribers (their events are published by `ApprovalEngineService`, which is still ambient — Decision Package 1), `commission` (`finance.invoice.posted`, `collection.remitted` — its controller is still blocked), `integrations` (4 product topics — excluded Mixed/Special surface), `fixed-asset-disposal` `JOURNAL_REVERSED_EVENT`.
3. **Outbox status `'skipped'`.** A Company-outbox row that had handlers but none runnable under Company dispatch (only `'ambient'` ones) is marked `skipped` (visible, never confused with `dispatched`, never retried forever, never silently lost). Rows with zero subscribers stay `dispatched` as before.
4. **In-request dispatch.** New `EventBusService.dispatchAfterCommit(manager?)`: no manager ⇒ ambient dispatch (unchanged); manager inside an **active transaction** ⇒ no-op (the caller owns the boundary — unchanged); otherwise (a Company root manager, e.g. `req.companyContext.dataSource.manager`) ⇒ Company dispatch. This replaces the three inconsistent conventions listed in §50 at the call sites reachable from CLOSED controllers (`if (!manager) dispatchPending()` dispatched nothing for a controller-supplied Company manager).
5. **Per-Company retry dispatcher.** `CompanyEventDispatcherScheduler` (same `OnModuleInit` + `setInterval` shape as `ApprovalExpiryScheduler`/`PreliminaryHoldExpiryScheduler`; inert under `NODE_ENV=test`; `runOnce()` exercised directly): iterates `CompanyConnectionManagerService.listActiveCompanyIds()`, dispatches each Company's own outbox with that Company's manager/`companyId`; one Company's failure is logged and does not stop the rest. Ambient outbox is not swept (unchanged — nothing swept it before).
6. **Concurrency (sub-decision 2).** Company dispatch claims rows with `SELECT … FOR UPDATE SKIP LOCKED` inside a short claim transaction, so the in-request flush and the scheduler (or two app instances) never process the same row twice. Ambient dispatch is unchanged (no claim).
7. **Compatibility (sub-decision 3).** Backward-compatible: `ctx` is a trailing argument and `scope` an optional option; no subscriber is *required* to change in the same commit. Safety does not depend on every subscriber being migrated, because un-migrated ones default to `'ambient'` and are never run against a Company outbox.
8. **companyId resolution.** `CompanyConnectionManagerService.companyIdOf(dataSource)` (identity lookup in its own cache); `EventBusService` takes it as an `@Optional()` dependency, so existing `new EventBusService(repo)` constructions are unaffected.

## 3. Scope boundary (what this ADR does NOT touch)

Approval Engine, Config Engine, Tax/Invoice, `sales_rep` (Decision Packages 1/3/4/5) — untouched. Call sites belonging to still-blocked controllers (`invoices.service`, `returns.service`, `payroll.service`, `approval-engine.service`) are left on the ambient path they are on today.

## 4. Blast radius

Production code: `event-bus.service.ts`, `event-outbox.entity.ts`, `events.module.ts`, `company-connection-manager.service.ts`, new `company-event-dispatcher.scheduler.ts`; subscribers `financial-event.service.ts`, `shipment.service.ts`, `price-lists.service.ts`; dispatch call sites in services behind CLOSED controllers (treasury, payments, deposits, delivery, fulfillment, goods-receipt, supplier-invoice, supplier-payment, work-order) — each is re-verified by its existing real-PG A/B isolation spec plus a full regression (CTO rule for changes touching closed controllers).

## 5. Known, documented limitations (not hidden)

- Commission and Integrations event consumers do not run for Company-routed events until their own Decision Packages land; their rows are `skipped`, not lost.
- `ConfigurationEngineService` reads inside GL handlers remain installation-wide (Gate D / Package 4).
- Approval-callback flows still resolve ambiently (Package 1).

## 6. Verification plan

Real-PG (`event-engine.company-isolation.spec.ts`): baseline proof → green; A/B isolation (different amounts; journal in A only, B only, never ambient); `dispatchAfterCommit` (root manager ⇒ dispatches; tx manager ⇒ no-op); per-Company scheduler sweep (+ one failing Company does not stop the other); `'ambient'` handler skipped under Company dispatch and run under ambient dispatch; concurrent claim (SKIP LOCKED) never double-processes. Then build, lint, the closed-controller isolation specs touched, and ONE full regression.

## 7. Verification record (2026-10-04)

**Executed proof (before):** BASELINE on unmodified code — event published in Company A, dispatched with A's manager → `{dispatched: 0, failed: 1}` (handler ran on the ambient connection).

**Real-Postgres after** (`domains/accounting/interface/event-engine.company-isolation.spec.ts` 8 tests + `foundation/events/event-bus.service.spec.ts` 7 unit tests — 15/15):
- A/B isolation with IDENTICAL event type, idempotency key, source-entity id and account codes: A dispatches → journal 40.00 in A only, B has no financial event and its outbox row stays `pending`; then B dispatches → 75.00 in B, A unchanged. `assertDataSourceNeverRequestedFor` proves the other Company's DataSource is never requested. The ambient outbox is inert (`{}`) and the control-plane DB has no accounting tables, so any ambient fallback would throw.
- `dispatchAfterCommit`: no-op inside an active transaction (row stays pending, no journal); Company dispatch with the root manager after commit.
- Per-Company scheduler sweep: both Companies processed with their own manager; a simulated Company-A connection failure does not stop Company B; A's row stays pending and is posted by the next healthy sweep.
- Subscriber classification: an ambient-only subscriber is never run on a Company event (row → `skipped`); a Company-scope subscriber runs with `{manager, companyId}`; an ambient sibling on the same topic does not run.
- Concurrent claims (`FOR UPDATE SKIP LOCKED`): three simultaneous dispatchers handle each of 6 rows exactly once.
- Lease recovery: a row `processing` past the lease is reclaimed; a freshly leased row is not.
- Failing Company handler: attempts incremented, row back to `pending`, other Company unaffected.

**Build** `nest build` clean. **Lint**: all D10 files clean; remaining findings are pre-existing in untouched files (`1789701100000-SeedDefaultBaseCurrency`, `attendance.service`, `work-order-phase3-e2e.spec`, `database-provisioning…unit.spec`, `company-connection-manager.service.spec`, `release-execution-gates.spec`).

**Full regression (one run):** 721 tests, 709 passed, 12 failed in 6 suites. Each disposed of by isolated serial rerun:
- `treasury.company-isolation.spec` — REAL, caused by D10: the spec built `TreasuryService` with `events = {}`, never touched while `if (!manager)` gated the flush; `cashInDirect` from a Company manager now flushes via `dispatchAfterCommit`. Spec fixed to use a real `EventBusService` (ambient repo still inert) — 11/11 PASS, and Company dispatch is now exercised there.
- `company-migration-runner.spec` — `permission denied to terminate process` teardown race; isolated PASS.
- `attendance-phase1`, `attendance-biometric-import`, `payroll-phase1`, `integrated-attendance-payroll-commission-gl-e2e` — known contention flakes; isolated PASS (37/37, 12/12). These paths use the unchanged ambient dispatch.

**Affected closed controllers** — real-PG isolation specs PASS: treasury (after fix), payments, deposits, delivery, fulfillment, goods-receipt, supplier-invoice, supplier-payment, work-order; also shipment, price-lists, products, inventory, general-ledger.
