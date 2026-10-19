# ADR-INV-10 - Continuous update of posting and screens (no new infrastructure)

**Status: PROPOSED (Gate B) - awaiting CTO review.** **Answers:** D-INV-10. **Gate A evidence:** G-EVT-1 (inventory documents never call `dispatchAfterCommit`; journals appear on the next 30 s sweep; O3/O5), G-EVT-2, G-UI-1 (no polling/SSE/WebSocket/focus/query library anywhere in the frontend; `lib/companyScope.ts` states the deliberate `useEffect + fetch` convention).

## 1. Context
The backend has a sound pipeline (transactional outbox, idempotent events, re-drive) but inventory documents rely on the periodic sweep, nothing tells the user a posting is pending or failed, and no screen refreshes after data changes. There is no backend cache, so staleness is purely client-side.

## 2. Decision
### 2.1 Backend (smallest change that closes the lag)
1. After the document transaction commits, inventory entry points call `EventBusService.dispatchAfterCommit(companyManager)` exactly as Goods Receipt, returns and treasury already do: warehouse document transitions (`post`/`approve`/`submit` that post), `POST /inventory/movements`, opening-batch `post`, opening import. The 30 s sweep remains the safety net. No change to the outbox or handlers.
2. **Posting status read endpoint** `GET /accounting/posting-status?domain=inventory` returning `{pendingEvents, rejectedEvents, failedOutbox, lastPostedAt, lastReconciliation: {asOf, status, unexplainedBase}}`, from the outbox and `accounting_financial_events` (module-boundary safe: accounting reads its own table and the shared outbox). Cheap indexed counts. Permission `accounting.inventory.view`.
3. **Per-document financial status** (derived, no new column): `GET /inventory/warehouse-transactions/:id/financial-status` returns, per line, the event status, rejection reason and journal entry id by the idempotency key `inventory:movement:<movementId>:recorded`. The document detail page shows "Posted to GL / Posting pending / Rejected (reason, re-drive)" so a document no longer says only `posted`.

### 2.2 Frontend (existing conventions, one reusable hook)
A small `useAutoRefresh(load, { intervalMs, enabled })` hook in `frontend/src/lib`: refetch on window focus/visibility and on an interval (default 30 s) **only while the tab is visible**; one request in flight at a time (skip, never queue); abort the previous request on filter change; exponential back-off on errors; never triggers writes. It re-runs the screen's own `load` with the **current** filters, company and period, so nothing is reset. Applied to: General Ledger, Trial Balance, Inventory Accounting/Reconciliation, Warehouse Overview, Financial Events, Opening Batches. Each shows "Updated hh:mm:ss" and, from `posting-status`, "Posting pending (N)" / "Failed (N)". This is deliberately polling + focus refetch rather than SSE/WebSocket: it reuses HTTP, needs no new server component, respects per-Company auth on every call, and is trivially reversible. SSE can be evaluated later if latency matters.

## 3. Alternatives
*SSE/WebSocket push* - deferred (new infrastructure, auth/connection lifecycle, hosting-environment constraints on shared hosting). *Add react-query* - rejected (new dependency against the project convention). *Rely on the sweep only* - rejected (that is the gap).

## 4. Impact / compatibility / rollback
Backend: 3 small call sites + 2 read endpoints; frontend: 1 hook + 7 screens. No schema, no contract change (additive endpoints). Flag `ui.auto_refresh` (client config, default on once verified; off restores today's behaviour). Request volume bound: at most one request per visible screen per interval; documented. Rollback = flag off / remove calls.

## 5. Tests
Real-PG: a manual receipt/adjustment/opening post produces its journal **in the same request** (no sweep needed) and exactly once; a failing event is shown as rejected and does not block the document response; re-drive after fixing configuration posts once. Browser (preview, per the verification workflow): post from one session and see GL/TB/Overview update in another within the interval with filters preserved; no duplicate requests (network log); hidden tab makes no requests; error back-off; "pending/failed" chip appears for a deliberately rejected event. Company isolation of `posting-status`.
