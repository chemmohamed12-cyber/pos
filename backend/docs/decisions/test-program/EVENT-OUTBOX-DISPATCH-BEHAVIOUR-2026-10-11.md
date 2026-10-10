# Event outbox dispatch — behaviour, measured facts, and evidence still needed for high volume

Source of every statement below: `src/foundation/events/event-bus.service.ts` and `company-event-dispatcher.scheduler.ts` (read 2026-10-11) and the local runs T-15/T-16. Labels: **VERIFIED** (code or measured), **INFERRED** (reasoned, not measured), **UNKNOWN**.

## 1. Behaviour (VERIFIED from code)
| Aspect | Behaviour |
|---|---|
| Write path | A business write inserts an `event_outbox` row (`pending`) in the SAME transaction as the business effect (transactional outbox). |
| In-request flush | After the transaction commits, controllers/services call `dispatchAfterCommit(manager)`. If the manager is inside an active transaction it is a no-op; otherwise it claims up to **50** pending rows (`UPDATE … status='processing' … FOR UPDATE SKIP LOCKED`, ordered by id), runs the subscribed Company-scope handlers **inline in the request** (journal posting etc.), and marks each `dispatched` / `skipped` / back to `pending` with `attempts+1`. |
| Concurrency between requests | `SKIP LOCKED` + a lease (5 min): two concurrent flushes never process the same row; a crashed dispatcher's rows are re-claimable after the lease. Rows claimed by different requests are processed concurrently, so cross-row processing order is **not** globally guaranteed (each batch is sorted by id, batches interleave). |
| Failure | A failing handler marks the row retryable (`attempts+1`, status `pending`) up to `MAX_ATTEMPTS = 5`, then `failed` (visible dead-letter by status; no separate queue). |
| Background sweep | `CompanyEventDispatcherScheduler` every **30 s**, per ACTIVE Company, up to **5 batches × 50 = 250 rows per Company per sweep**; skipped when `NODE_ENV=test`; a slow sweep never overlaps itself. The ambient/Platform outbox is not swept. |
| Cost per request | The request that happens to flush pays for up to 50 events (GL posting for events of OTHER requests included) — latency of an unlucky request grows with the backlog. |

## 2. Measured facts (local, 2 cores, load generator in-process — not extrapolable)
- T-15 (service level): 380 on-account payments produced 760 outbox events (≈2 per payment); a single `dispatchAfterCommit` processes at most 50, so a loop was needed to drain (the test drains explicitly).
- T-16 (HTTP, ~35 req/s sustained, 10,495 requests, mix 35 % payments): the final backlog after the whole run was **16 events**; the in-request flush kept the outbox essentially empty at that rate; all financial events ended POSTED, journals balanced, no `failed` rows.
- Not measured: backlog growth over time under sustained load, the per-event handler duration, the share of request latency spent in the flush, behaviour with several application instances, behaviour when handlers fail repeatedly.

## 3. Risk assessment (INFERRED, to be tested)
1. **Latency coupling:** because the flush is inline, request latency includes other requests' event processing; at higher write rates a request may carry up to 50 events' worth of GL posting.
2. **Backlog ceiling:** capacity of draining ≈ (in-request flushes) + 250 rows/Company/30 s from the sweep. If events are produced faster than they are processed, the outbox grows and ledger/GL lag behind business data (eventual consistency window grows). The reconciliation oracle (R7) tolerates `pending` only if drained, so a sustained backlog is visible, not silent.
3. **Ordering:** concurrent batches may post events out of id order; correctness then depends on each handler being order-independent for different documents (VERIFIED only for the scenarios in T-01…T-16, where the oracle held).
4. **Failure amplification:** a handler failing for a systemic reason (missing configuration) makes every flush retry the same rows up to 5 times, adding latency, before they become `failed`.

## 4. Evidence required to assess a high-volume deployment (not collected)
1. Backlog depth (`SELECT status,count(*) FROM event_outbox GROUP BY 1`) sampled every 5 s during a sustained run at 1×, 3× and 10× the proposed write rate, on a staging-like host.
2. Handler duration distribution per topic (instrument or log timing), and the share of request latency spent in `dispatchAfterCommit`.
3. A run with ≥ 2 application instances against one Company database (claim/lease behaviour, duplicate-processing check, ordering effects on the oracle).
4. A fault-injection run: a failing handler (e.g. a missing GL configuration) under load — time to `failed`, latency impact, recovery after fixing the cause and re-driving.
5. Backlog recovery time after a peak (time for `pending` to reach 0).
No product behaviour was changed because of this analysis; any change (e.g. decoupling the flush from the request) is an architectural decision for the CTO after items 1–5.
