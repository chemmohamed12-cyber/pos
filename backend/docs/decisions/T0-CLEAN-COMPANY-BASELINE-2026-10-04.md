# T0 — Clean-Company Baseline (2026-10-04) — COMPLETE (one STOP found, fixed, resumed)

Method: disposable real-Postgres harness (fresh control-plane + 2 fresh Company DBs per run, torn down; leftover-DB check = none). Spec: `domains/accounting/interface/t0-clean-company-baseline.spec.ts` (opt-in: `T0_BASELINE=1 [T0_EVIDENCE_FILE=…]`). Company A runs the scenario, Company B is the untouched witness. All services real (valuation, GL event pipeline via D10 `dispatchAfterCommit`, treasury, procurement); the ambient/control-plane connection holds only `core` tables and an inert outbox. The shared dev DB was never touched. T0 itself changed nothing; the single fix below was CTO-authorized after the STOP.

## STOP T0-F1 — fixed (CTO-authorized, minimal)
`SupplierInvoiceService.createDraftInvoice` called `numbering.registerDocumentType(...)` without a manager (ambient/Platform connection) in a Company-scoped write; `supplier-invoice.controller` was Area 21 CLOSED (§27) but its isolation spec covered only reads/list.
Fix: `supplier-invoice.service.ts` — pass `true, manager` (one line; `includeYear` default preserved). New write-path A/B isolation tests added to `supplier-invoice.company-isolation.spec.ts` (9/9 PASS): A write → A only (invoice + its own SINV sequence = 1), B untouched, B's DataSource never requested, no row in the Platform `numbering_sequences`, B writes with its own independent sequence, A→B DENY writes nothing. (Pre-fix the same call threw `No metadata for "NumberingSequence"` on the ambient connection — the T0 stop.)
**Follow-up finding (NOT fixed, per CTO):** `customer-ledger.service.ts` reverse path (~l.220–230) is fully ambient (`this.dataSource`, un-threaded `registerDocumentType`/`getNextNumber`) in a CLOSED controller's service. Evidence that earlier Area 21 isolation specs covered read/list but not all write paths — if T0 reaches a similar path, T0 stops again.

## Scenario (Company A) and result
Dataset: 1 Company; minimal chart (1101 Cash [bank], 1102 Bank [bank], 1120 Inventory, 2101 AP, 2115 GRNI — control functions set); 1 warehouse; 2 products; 1 supplier; 2 treasury accounts (BANK-1 GL-mapped→1102, MAIN-CASH unmapped), each funded 1000.00.
Flow: opening stock (P1 ×20 @4.00) → PO (P1 ×10 @5.00, P2 ×4 @12.50 = 100.00) submit/approve → GR1 (P1×10, P2×2) → GR2 (P2×2) → supplier invoice 100.00 (same prices) posted → payment 60.00 from BANK-1, payment 40.00 from MAIN-CASH.

## STOP conditions — all clear
| Condition | Result |
|---|---|
| Company DBs fresh/empty after provisioning | PASS (A and B: 0 rows in all 12 tracked tables; only migration-seeded `MAIN-CASH`) |
| No query touches Platform/shared DB | PASS (control-plane `event_outbox` = 0; control-plane has no accounting tables) |
| Company isolation | PASS (Company B: 0 rows everywhere after A's activity) |
| GL posting occurs, in the right Company | PASS (5 journals, all in A) |
| Journals balanced / Dr = Cr | PASS (ΣDr = ΣCr = 300.00, 0 unbalanced) |
| No failed/processing events | PASS (financial events: GR×2, SI×1, SP×2 all POSTED; 0 REJECTED/IGNORED; outbox all `dispatched`) |
| Unexplained opening balances / stale data | none (see observations) |

## Baseline observations (recorded, deliberately not asserted — inputs to D2/D3/D5)
1. **Procurement chain reconciles.** GL: GR Dr 1120 / Cr 2115 (75+25), SI Dr 2115 / Cr 2101 (100), SP Dr 2101 / Cr 1101 (60, 40). GL 2101 = 0 = supplier-ledger net (credit 100 − debit 60 − 40); GRNI 2115 = 0 (GR 100 = invoice 100; same-price case — price-variance case not exercised).
2. **D2 reproduced on a clean company.** The 60.00 payment from **BANK-1 (mapped to 1102)** credited **GL 1101 Cash on Hand**, not 1102; the 40.00 payment from the **unmapped** MAIN-CASH also credited 1101 and was not rejected. Result: BANK-1 Treasury balance 940.00 vs GL 1102 = 0; GL 1101 = −100.00 vs MAIN-CASH Treasury 960.00. The bank leg ignores the paying treasury account (two `bank` control accounts exist; resolution is by control function).
3. **D3 reproduced.** Opening stock (movement type `receipt`) +20 / valuation +80.00 and **no GL**; Inventory GL 1120 = 100.00 (GR only) vs valuation Σ = 180.00 → the 80.00 difference is exactly the opening stock.
4. **Treasury funding posts no GL** (contract `cashIn` is non-emitting): 1000.00 in each treasury account, GL cash 0 at that point (explained, by design; D2/TRS-01 context).
5. **D10 validated end-to-end in real service flows**: every GL entry above came from a Company outbox, dispatched via `dispatchAfterCommit` with the Company manager, posted in Company A only.
6. Not exercised: supplier price variance (GRNI residual / PPV), VAT, returns, customer payment, fixed assets (outside the CTO's T0 list).

## Status
**T0 = COMPLETE — clean baseline recorded.** Remediation order now open per CTO: D2 → D3 → D5 (then remaining P0). Nothing remediated yet beyond T0-F1.
