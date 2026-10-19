# Inventory lifecycle, General Ledger and Trial Balance - Gate A (Discovery and Root Cause), 2026-10-17

**Scope of this document: Gate A only.** Read-before-write review of what exists today, a measured trace of real behaviour, and an evidence-backed gap register. **No product code, schema, configuration or data was changed.** The one tool used for measurement (a throw-away probe spec on the isolated test cluster 5546) was removed from the source tree; its source and raw output are kept as evidence in `evidence-2026-10-17-inventory-gate-a/`. Nothing was run against production or against any real balance.
Code reference: branch `feature/inventory-lifecycle`, base `8d86e90` (integration / 1.1.10 candidate).

## 0. Verdict in one page
Most of the posting chain the directive describes **already exists and works**: movements publish through a transactional outbox, a Financial Event engine turns them into balanced journals with fail-closed account resolution, re-drive and idempotency, the GL and Trial Balance read live from posted journal lines, and a reconciliation service exists. The gaps are in **governance (who may create financial effect, with what reference, at what date)**, **dates**, **valuation reporting and reconciliation precision**, and **screen refresh / traceability**. Eleven of the nineteen gaps below were reproduced by measurement, not only read.

The two questions that started this work:
1. **"Why does the value on the warehouse screen differ from the trial balance?"** Confirmed root cause (G-VAL-1): the Warehouse Overview "Total Inventory Value" is `on-hand x product SELLING price` (code and UI label say so). It has never been a cost or ledger value. In the probe it showed 140.00 while valuation = GL account 1120 = 58.00. The valuation engine and the GL agree with each other; the screen is simply a different quantity.
2. **"Is the opening balance a controlled process?"** No (G-OB-1..3). There is no opening batch, cut-off date, approval or lock. Stock can enter as "opening" through (a) the Excel opening-stock import and (b) any manual receipt whose reason code is mapped to an opening-equity account; (b) posts a financial entry **immediately on submit, with no approval, by a plain warehouse worker, dated today**.

## 1. Method and evidence
- Source review of the actual implementation (inventory, warehouse documents, valuation, accounting handlers, ledger, reconciliation, events, frontend pages) plus the standing decisions: `D3-INVENTORY-POSTING-POLICY-2026-10-04.md` (CTO-approved posting policy, D3-A/D3-B/D4), `ERP-FUNCTIONAL-INTEGRITY-AUDIT-2026-10-04.md`, ADR-054/056 (GRNI), the F07/F08 code comments (ADR-040/041).
- Measurement: `evidence-2026-10-17-inventory-gate-a/probe-run/gate-a-observations.json` (observations O1-O10, Q pack) produced by driving the REAL services (event bus, financial-event engine, moving-average valuation, costing handler, journal posting, process engine) on disposable Company databases, with a fiscal year, a chart of accounts and the D3 configuration. Probe source: `gate-a-probe.spec.ts.txt`; jest log: `probe-jest-log.txt`.
- `daii_dev` (experimental) holds no inventory or accounting data (0 movements, 0 journals, empty chart in all four Companies), so it could not be used for tracing; production data was not touched. A read-only SQL pack for the owner is in section 8.
- Limits: the probe uses the shared test harness, which builds the inventory service without the manual-receipt policy; the probe therefore constructs a production-shaped pair (policy bound, stub reason check) for the manual-receipt observations. It does not exercise the HTTP layer, permissions or Company isolation (those are covered by the existing A/B specs, section 7).

## 2. Current data flow (as implemented)
```
Operational document / call                         Inventory (source of truth for quantity)
  warehouse document (receipt|issue|transfer|          stock_movements (append-only ledger; on-hand = SUM)
  adjustment|count)  ->  postTransaction ------------>  recordMovement()  [same DB transaction]
  Goods Receipt (PO)  ----------------------------->     |-- audit record
  Opening-stock Excel import ---------------------->     |-- valuation bootstrap at the supplied cost (receipt/return_in)
  POST /inventory/movements (manual receipt only)->     |-- publish `inventory.movement.recorded` to event_outbox
  Sales return / Shipment return (return_in) ------>        (only for glKind: dispatch, opening_stock, adjustment, return_in, manual_receipt;
                                                             Goods Receipt has its own GRNI event; transfers never publish)
                       |
        in-request flush (`dispatchAfterCommit`) where the caller calls it ... else the 30 s per-Company sweep (5 attempts, then `failed`)
                       v
Accounting: FinancialEventService.ingest  ->  accounting_financial_events (POSTED | REJECTED | IGNORED, rejectionReason, re-drivable)
  InventoryCostingHandlerService:  accounts resolved BEFORE any valuation mutation (fail-closed, no fallback account)
     dispatch Dr COGS/Cr 1120 | opening_stock Dr 1120/Cr opening-equity | manual_receipt Dr 1120/Cr reason-mapped account
     adjustment +: Dr 1120/Cr gain (at current moving-average) | -: Dr loss/Cr 1120 | return_in Dr 1120/Cr COGS (original cost)
                       v
  JournalEntryService (draft -> POST through the fiscal-period gate; sourceType FINANCIAL_EVENT; balanced check)
                       v
  LedgerService (live SQL over POSTED/REVERSED entries): account ledger (opening, debit, credit, closing, running balance), trial balance
                       v
  Screens: General Ledger, Trial Balance (load on mount / filter change only)         Valuation: inventory_valuation_state (moving average, 4 dp)
  Reconciliation: InventoryReconciliationService (manual run; valuation total vs GL `inventory` control account)
```
Model A is in force: one central Inventory control account (`1120`); transfers carry valuation between warehouse ledgers and post **no** journal. Counter accounts are configuration keys, empty by default, and a missing key REJECTS the event (visible, re-drivable) - nothing is invented.

## 3. What already satisfies the directive (not re-opened)
| Directive item | Existing mechanism | Evidence |
|---|---|---|
| No silent edit/delete of posted movements | Append-only ledger; documents reverse (never delete) | `warehouse-transactions.service.ts` reverse path |
| Atomicity / idempotency of movement + event | Outbox row written in the movement's own transaction; idempotency key `inventory:movement:<id>:recorded`; re-drive is idempotent (3 re-drives add nothing) | `inventory.service.ts:253-307`; T-11 (business suite, passed 2026-10-16) |
| No fallback accounts; clear blockers | Unconfigured/invalid counter account -> event REJECTED with the reason, stock unchanged in valuation | `inventory-costing-handler.service.ts`; probe Q3 |
| Purchase receipt reference | Goods Receipt requires an approved/partially-received PO, rejects over-receipt, takes cost from the PO line, posts Dr 1120/Cr GRNI (ADR-054) | `goods-receipt.service.ts:62-141` |
| Transfers: no unjustified quantity, no financial entry | One document posts both legs atomically at approval; valuation carried at the source's average; no journal | `inventory.service.ts:415-432`; probe O7 |
| Returns | `return_in` only at the ORIGINAL cost (fail-closed otherwise): Dr 1120/Cr COGS (D4) | `recordSaleReturnIn`, `resolveOriginalSaleCost` |
| Adjustments/counts need approval | `adjustment`, `count`, `issue`, `transfer` documents need supervisor approval before posting | `NO_APPROVAL_REQUIRED` = `receipt` only |
| Raw ledger bypass closed | `POST /inventory/movements` accepts only a manual receipt (410 for every other type) | `inventory.controller.ts:359-371` |
| Period control | Journals post only into an open fiscal period | `journal-entry.service.ts:352` |
| GL/TB are live | No cached balances: every figure is SQL over posted lines (so a stale screen can only be a stale client) | `ledger.service.ts` |
| Inventory <-> GL reconciliation | Service + run entity + close action + permissions `accounting.inventory.view/create` | `inventory-reconciliation.service.ts`, `inventory-accounting.controller.ts` |
| Opening-balance precedent for AR/AP/Cash | `opening_balance` adjustment kinds are always gated by FA-01 with 2 approvers | `domain/ar.ts:38`, `domain/ap.ts:44` |
| Company isolation | A/B real-PG specs for inventory posting, manual receipt, warehouse transactions, valuation; Platform DB never touched | section 7 |

## 4. Gap register (each with evidence, root cause and the decision it needs)
Severity: **P0** financial effect without proper control or wrong figures; **P1** misleading or incomplete reporting / precision; **P2** usability or consistency. "Measured" = reproduced by the probe.

### Opening balances and controls
| ID | Gap | Evidence | Root cause | Sev |
|---|---|---|---|---|
| G-OB-1 | No opening-balance cycle: no batch, cut-off date, quantity/cost/total review, approval, lock or "closed" state. The only guard is "one opening import per (warehouse, product)". A NEW product can still be imported as "opening" after operations have started. | `inventory.service.ts:1088-1150` (guard at 1128-1139); **measured O2**: second import of the same pair refused, late import of a new product accepted | D14 of ADR-040 deferred the inventory opening boundary entirely (`domain/inventory.ts` header); D3-A added posting but not governance | P0 |
| G-OB-2 | A manual receipt with a reason code mapped to an opening-equity account is a second, ungoverned opening path: it **auto-posts on submit, no approval**, by `warehouse_worker`, with a free-text reference and a worker-typed cost, creating `Dr 1120 / Cr 3105` immediately. | `warehouse-transaction-type.ts:14` (`NO_APPROVAL_REQUIRED = receipt`); `warehouse-transaction-action-roles.ts:11` (`submit` = warehouse_worker); **measured O3**: state `posted` after one submit, journal 24.00 posted by the next sweep | D3-B required cost + reason but kept the pre-existing "receipts need no approval" rule, written when a receipt had no financial effect | P0 |
| G-OB-3 | No exceptional-correction path: a cost-bearing manual receipt cannot be reversed as a document (code rejects it; "post an Adjustment (decrease) instead"), so correcting a wrong opening goes through Adjustment gain/loss accounts (P&L) rather than the opening-equity account, without a documented reason/approval specific to the opening. | `warehouse-transactions.service.ts:620-625` | A document reversal cannot unwind valuation exactly (D3-B decision) - the alternative path was never built | P1 |
| G-DATE-1 | Inventory journals are dated **the publish date (today, UTC)**, never the document's `movementDate` or an opening cut-off. A receipt document dated 30 days earlier posted on today's date; an opening cannot be dated at go-live / year start, although the GL already has an `OPENING` source type designed for backdated go-live entries. | `inventory.service.ts:289`; `financial-event.service.ts:153`; `journal-entry.service.ts:585`; **measured O1/O3** (document 2026-09-17 -> journal 2026-10-17, sourceType FINANCIAL_EVENT) | `recordMovement` has no business-date parameter; the document date is not passed to the event | P0 |

### Reasons and reference documents
| ID | Gap | Evidence | Root cause | Sev |
|---|---|---|---|---|
| G-REF-1 | No reason -> reference-document matrix. Only `receipt` has a coded reason (config map); issue/transfer/adjustment/count carry a free-text `reason`; the `reference` column is free text (varchar 255) and never validated. A manual receipt through the service or `POST /inventory/movements` is stored with `referenceId = NULL`. | `warehouse_transaction.entity.ts` (`reference`, `reason`, `reasonCode`); **measured O9** (`referenceId` null); O3 (`referenceFieldValidated` false) | The coded-reason concept was added for receipts only (D3-B); other types predate it | P1 |
| G-SOD-1 | Segregation of duties: a role that can only "submit" can create financial entries (see G-OB-2); Count/Adjustment documents have supervisor approval but no accounting-side check. | as G-OB-2 | as G-OB-2 | P0 |

### Adjustments, quantity and value
| ID | Gap | Evidence | Root cause | Sev |
|---|---|---|---|---|
| G-ADJ-1 | Two adjustment mechanisms with overlapping purpose and no link: (1) D3 - warehouse adjustment/count documents move stock AND post a journal at the current moving average; (2) F07 - `accounting.inventory.physical_count_variance` / `valuation_write_down` (FA-01 maker/checker, maker-typed amount) post a GL entry only. Nothing consumes the F07 approval event on the valuation side, so a F07 entry changes GL 1120 but not `inventory_valuation_state`, i.e. it creates a permanent, explainable-only drift and can double-count a variance already posted by D3. | `inventory-adjustment.service.ts` (header, line 158); no subscriber of `INVENTORY_ADJUSTMENT_APPROVED_EVENT` outside accounting | F07 pre-dates D3/F08; its header says routine counts "never reach FA-01" - no longer true after D3 | P0 |
| G-QTY-1 | Quantity can exist without value. (a) An adjustment increase for a (warehouse, product) with no valuation state commits the stock movement, then the event is REJECTED `no_valuation_source` (documented, re-drivable, T-11) - the document shows `posted` meanwhile. (b) A transfer from a source that has no valuation moves quantity with no value ("no cost carried"). (c) Receipts recorded without cost by raw/legacy paths. | **measured O6** (on-hand 3, value 0, no journal), **O7** (destination on-hand 4, no valuation rows); `inventory.service.ts:415-432`; D3 doc section 6 | Valuation is mutated at event time, not movement time (design); (b)/(c) are tolerated by design for non-blocking operations | P1 (data-state risk; Q1 measures it) |
| G-EVT-2 | A document reports `posted` even when its financial event is REJECTED or still pending; documents carry no financial status or journal link. The only surface is the Financial Events screen. | **measured O6/O10** (documents have no such column); D3 doc "adjustment events ... posted by the 30 s sweep" | Event delivery is decoupled from the document by design | P1 |

### Valuation and reconciliation
| ID | Gap | Evidence | Root cause | Sev |
|---|---|---|---|---|
| G-VAL-1 | **Warehouse Overview value = on-hand x selling price**, not cost/valuation. This is the direct cause of "the warehouse value differs from the TB". | `warehouse-transactions.service.ts:250-283` (`totalInventoryValueAtSellingPrice`), `WarehouseOverview.tsx:132` ("at selling price"); **measured O4**: overview 140.00 vs valuation 58.00 = GL 58.00 | The KPI was built before any cost layer existed (comment in the service); F08 later added valuation but the KPI was not revisited | P0 (misleading figure) |
| G-VAL-2 | No valuation report: the only valuation endpoint is `GET /inventory/valuation/current-cost` (one item/warehouse). There is no value by warehouse and item, no total, no as-of view. | `inventory-valuation.controller.ts` (one route) | F08 was scoped as an engine + maker aid, not a report | P1 |
| G-VAL-3 | Valuation is not as-of capable: `getValuedOnHandTotal(asOfDate)` ignores the date and reads the current state, while the GL side honours it. Any reconciliation run with a past date compares "now" with "then". | `moving-average-cost-engine.service.ts:411`; **measured O8**: as-of 2000-01-01 -> valuation 67.78 vs GL 0.00, `drift_found` | The engine keeps a running state, not a dated history (the movement table `inventory_valuation_movements` exists but is not used for as-of) | P1 |
| G-RECON-2 | Reconciliation demands exact equality; valuation keeps 4 decimals, journal lines are rounded to the base currency's 2 decimals. Result: a **false `drift_found` of 0.0022** after an ordinary adjustment at an average of 4.8889. Such differences accumulate with every fractional average. | `inventory-reconciliation.service.ts:126` (`matched = drift === 0`); **measured O8/O8b**: line transaction amount 9.7778 -> base 9.78; valuation 67.7778 vs GL 67.78 | No rounding policy between the valuation engine and the posting currency | P0 (the control reports false differences) |
| G-RECON-3 | The reconciliation only compares totals (warehouse totals in the breakdown). It does not attribute a difference: no pending/REJECTED events, no F07 entries, no per-item rows, no movements without an event, no entries without a movement. It is run manually; the last result is not shown anywhere central. | `inventory-reconciliation.service.ts` (breakdown keys: note, warehouseBreakdown, glClosingBalanceBase, glLineCount); the T-10 R1-R10 oracle exists only as a test | Built as the minimal F07 mirror of the AP reconciliation | P1 |

### Events, GL, TB and refresh
| ID | Gap | Evidence | Root cause | Sev |
|---|---|---|---|---|
| G-EVT-1 | Inventory events are not flushed in-request: nothing under `inventory-warehouse` calls `dispatchAfterCommit`; manual receipts, opening imports and adjustments reach the GL on the next 30 s sweep (and after up to 5 failed attempts the outbox row is `failed`, outside the Financial Events screen). | grep: no `dispatchAfterCommit` in `domains/inventory-warehouse`; `company-event-dispatcher.scheduler.ts:5`; **measured O3/O5**: journals unchanged before flush, 2 outbox rows pending | Other domains (GR, returns, treasury ...) flush after commit; inventory documents do not | P1 |
| G-GL-1 | The General Ledger screen cannot trace an entry: the API returns `sourceType` but the UI shows only entry number/date/description/amounts; no status, no source document, no link to the journal or financial event; `journalEntry.financialEventId` exists but is not exposed. | `GeneralLedger.tsx:130-150`; `ledger.service.ts` line shape | Read model built for F03 before event traceability was needed | P1 |
| G-TB-1 | The Trial Balance shows one net debit/credit figure per account for the window; with a `from` date it excludes the opening balance, so a period TB is not a closing-balance TB. No opening / period debit / period credit / closing columns; no "as of" or last-updated indication. (The footer gross/net issue was fixed in F11.) | `ledger.service.ts:175-210`; `TrialBalance.tsx:48-58` | The GL read model supplies the four figures per account, the TB does not | P1 |
| G-UI-1 | No refresh mechanism anywhere in the frontend: no polling, SSE, WebSocket, focus refetch or query-cache library (a deliberate "useEffect + fetch" convention). GL/TB/Recon/Overview load on mount or filter change only. There is no backend cache either, so a stale figure is always a stale client. No "posting pending" indicator exists to tell the user a figure is incomplete. | grep over `frontend/src` (no match); `lib/companyScope.ts:4`; `TrialBalance.tsx:58` | Not built; the outbox decoupling (G-EVT-1) makes it visible | P1 |
| G-TRF-1 | Transfers post both legs at approval (no in-transit state, no receiving confirmation). Consistent with Model A and sufficient to prevent unjustified quantity, but "transfer status / receipt linked to the source dispatch" in the directive is satisfied only implicitly (same document id on both legs). | `inventory.service.ts:415-432`; probe O7 (`referenceId` = document on both legs) | Design choice (immediate transfer) | P2 - needs an architecture decision |

## 5. Answers to the directive's explicit questions
1. **Is the opening balance part of a dated, controlled process or an ordinary operational movement today?** An ordinary movement (two paths, G-OB-1/2), undated at cut-off (G-DATE-1), unapproved on the manual path.
2. **Opening without value?** The import requires a positive unit cost and the manual receipt requires cost + mapped reason, and both fail closed, so a quantity without value is not created by those paths. It can arise through the other paths listed in G-QTY-1.
3. **Duplicate opening entries?** Prevented per (warehouse, product) for the import only (G-OB-1); the manual path has no uniqueness concept.
4. **Does a transfer create a financial entry?** No (verified O7 and by the D3 contract); valuation is carried at the source average.
5. **Does the overview value match the TB?** No by construction (G-VAL-1); valuation and GL 1120 do match (O4) except for the rounding drift (G-RECON-2).
6. **Is every movement requiring a financial effect posted exactly once?** Yes for the allow-listed kinds (idempotency keys, unique per movement; T-11); the observable risks are delay (G-EVT-1) and non-visibility of failures on the document (G-EVT-2). Pre-D3 history has no events (Q2 measures it).
7. **Is balanced Dr = Cr proof of completeness?** No, and the code does not treat it as such: R7 of the business test oracle reconciles movement <-> event <-> journal separately.

## 6. Refresh and update mechanisms that exist today
| Layer | Mechanism | Status |
|---|---|---|
| Backend | Transactional outbox, in-request flush (`dispatchAfterCommit`) for most domains, 30 s per-Company sweep, 5 attempts then dead-letter-by-status, lease for crashed dispatchers, re-drive of REJECTED financial events | exists; inventory documents do not use the in-request flush |
| Backend cache | none (live SQL) | by design |
| Frontend | load on mount / filter change; no polling, SSE, WebSocket, focus refetch, invalidation or shared cache; no indicator of pending/failed postings | **absent** |
Existing infrastructure that Gate B can reuse without new building blocks: the outbox/financial-event status tables (a count of pending/REJECTED events per source is a cheap read), the `FinancialEvents` screen, and plain interval refetch in the existing `useEffect` pattern.

## 7. Verification that already exists (and was not weakened)
Real-PG A/B specs: `inventory-posting.company-isolation` (9), `manual-receipt.company-isolation` (12), `inventory.company-isolation`, `warehouse-transactions.company-isolation`, `inventory-valuation.company-isolation`, `accounting-policy-config.company-isolation`; business suite T-11 (rejected event -> re-drive, no duplicate), T-10 R1-R10 oracle (R2 valuation = GL 1120, R7 movement/event/journal). The full isolation regression (101/102, baseline exception documented) and T-00..T-31 passed on the 1.1.10 candidate on 2026-10-16.

## 8. Read-only SQL pack for the owner (production health, no change)
`evidence-2026-10-17-inventory-gate-a/diagnostic-queries.sql` (Q1-Q6). Run per Company database; each is a SELECT. It was executed on the empty experimental Company DB (syntax) and inside the probe on a populated test database, where it found exactly what the probe created: Q1 returned the three pairs whose valuation row is missing (the unvalued adjustment, the transfer destination and the transfer source remainder), Q3 the one REJECTED `no_valuation_source`, Q4 valuation 72.7778 vs GL 72.78. Interpretation: Q1 non-empty = G-QTY-1 exposure; Q2 non-empty = movements without an event (expected for history before the D3 release; investigate recent ones); Q3 REJECTED rows = unposted financial effect; Q4 difference = G-RECON-2/G-ADJ-1/pending events; Q5 = undelivered events; Q6 = how stock entered (opening-like references).

## 9. Decisions needed for Gate B (architecture), with a recommendation each
| # | Decision | Recommendation (for review, not implemented) |
|---|---|---|
| D-INV-1 | Opening-balance model | A dated **opening batch** document per Company/warehouse scope (cut-off date, lines with quantity, unit cost, total), maker/checker via the existing FA-01 pattern used for AR/AP/Cash openings (always gated, 2 approvers), posting as sourceType `OPENING` at the cut-off date, then **locked**; one open batch per scope; the Excel import becomes the batch's data-entry channel; no further `opening` receipts after approval; correction only by a reversal batch with permission, reason and approval |
| D-INV-2 | Date policy for inventory events | Carry the document `movementDate` (or the batch cut-off) into the event `businessDate`; the fiscal-period gate then applies to that date; define how a closed period is handled (reject, or post to the open period with a flag) |
| D-INV-3 | Approval policy for manual receipts | Receipts whose reason maps to an equity/clearing account need approval (checker holds a posting permission); keep straight-through only for receipts that clear against GRNI via a PO |
| D-INV-4 | Reasons and reference matrix | Controlled reason codes for every movement type, each with a required reference kind (PO/GR, source transfer, original sale/return document, count document, opening batch); `reference` validated against that kind |
| D-INV-5 | F07 vs D3 adjustments | Keep one financial path for stock-quantity effects (D3); restrict F07 to value-only write-downs and make it update valuation (or exclude it explicitly and itemise it in the reconciliation) |
| D-INV-6 | Rounding between valuation (4 dp) and GL (base dp) | Round the valuation amount to the base-currency scale when the journal is posted (so both sides carry the same figure), or reconcile within a defined tolerance and report the residual separately - never silently |
| D-INV-7 | Overview KPI | Show valuation (cost) by default, keep the selling-price figure as a separately labelled KPI |
| D-INV-8 | Valuation as-of | Compute as-of from `inventory_valuation_movements`, or restrict reconciliation to "current" and say so |
| D-INV-9 | Reconciliation scope | Per warehouse and item, with attributed differences (pending, REJECTED, F07, no-event movements), a scheduled run and a visible last result; strictly read-only |
| D-INV-10 | Refresh strategy | In-request flush for inventory documents; client: refetch on focus plus a bounded interval on GL/TB/Reconciliation/Overview, preserving filters; one small read endpoint returning "pending/failed financial events" so screens can show "posting pending" |
| D-INV-11 | GL/TB read models | TB: opening, debit, credit, closing per account, "as of" stamp, drill to GL with the same period; GL: status, source and link to journal/financial event |
| D-INV-12 | Transfer lifecycle | Keep immediate transfer (Model A) unless an in-transit state is required by the business |

## 10. Closing-condition status (directive section 8) - current state, not a promise
| Condition | Status today |
|---|---|
| Opening balances controlled, not repeatable/editable outside an approved path | **Not met** (G-OB-1..3, G-DATE-1) |
| Every movement has a suitable reason and reference | **Not met** (G-REF-1) |
| Quantity, value and cost consistent | Partly (G-QTY-1, G-RECON-2) |
| Each financially relevant movement posts once | Met for allow-listed kinds; delay/visibility open (G-EVT-1/2) |
| Transfer creates no unjustified financial effect | Met |
| Reconciliation works and reveals real differences | **Not met** (G-RECON-2/3, G-VAL-3) |
| No regression | Met at this stage (no change made) |
| Real PostgreSQL / isolation / regression | Existing suites pass; new coverage belongs to Gates C/D |
| Remaining gaps documented, none hidden | This register |

## 11. Not verified / limits
No HTTP/E2E, permission or A/B isolation run was performed in this gate (existing specs cover them). No production or hosted data was read. The probe's manual-receipt path used a stub reason check (the real check validates the configured reason map and the account). The rounding finding is proven for the base currency with 2 decimals (EGP); other currencies were not exercised. Pre-D3 history and legacy receipts without cost cannot be assessed without the owner's Q1/Q2 results on real databases.

## 12. Next step
Gate B (architecture and data flow) needs the decisions in section 9 (D-INV-1 to D-INV-12). No code, schema or data change starts before they are approved.
