# Inventory lifecycle, GL and Trial Balance - Gate B Architecture Package (2026-10-17)

**Status: PROPOSED - for CTO review and approval. Nothing is implemented.** Binding constraints respected: no product code, schema, configuration or production data was changed in Gate B; no test movement touched production; no existing structure or approved contract is modified merely for design preference; every posting-policy change below is documented, justified and flagged for explicit approval. After this package the work **stops for review before Gate C.**
Base: branch `feature/inventory-lifecycle` (from `8d86e90`); inputs: `../INVENTORY-LIFECYCLE-GATE-A-DISCOVERY-2026-10-17.md` and its evidence.

## 1. Contents
| File | Decision |
|---|---|
| `ADR-INV-01-opening-balance-batch.md` | D-INV-1 Opening Balance Batch: dated, approved, locked, with an exceptional reversal path |
| `ADR-INV-02-business-date-propagation.md` | D-INV-2 movement/cut-off date reaches the event and journal; closed periods reject, never shift |
| `ADR-INV-03-manual-receipt-approval-and-sod.md` | D-INV-3 approval by financial effect; maker != checker on documents |
| `ADR-INV-04-reason-and-reference-matrix.md` | D-INV-4 reason catalog and mandatory references (and the issue -> COGS finding) |
| `ADR-INV-05-adjustments-f07-d3-coexistence.md` | D-INV-5 one path for stock effects; value-only write-downs that update valuation |
| `ADR-INV-06-rounding-policy.md` | D-INV-6 exact explanation first, same-figure postings second |
| `ADR-INV-07-08-...md` | D-INV-7 cost-first overview value; D-INV-8 valuation as of a date and a valuation report |
| `ADR-INV-09-reconciliation-v2.md` | D-INV-9 itemised, explained, read-only reconciliation |
| `ADR-INV-10-continuous-refresh.md` | D-INV-10 in-request flush, posting-status endpoint, auto-refresh hook |
| `ADR-INV-11-12-...md` | D-INV-11 GL/TB read models; D-INV-12 transfer stays immediate (Model A) |

## 2. New findings made while designing (added to the Gate A register)
| ID | Finding | Evidence | Where handled |
|---|---|---|---|
| G-ISS-1 | A warehouse **issue** document posts a `dispatch` movement; the `dispatch` event kind always posts `Dr COGS / Cr Inventory`. Any internal issue (consumption, sample, scrap) is booked as COGS. | `warehouse-transactions.service.ts` postTransaction (issue branch); `inventory-costing-handler.service.ts` (dispatch branch) | ADR-INV-04 (policy decision, flagged) |
| G-SOD-2 | Warehouse document approval/posting never compares the approver with the creator (FA-01 does, `approval-engine.service.ts:312`). | `transition()`; only `approvedByUserId` stored | ADR-INV-03 |
| G-TB-2 | TB -> GL drill-down drops the period (`TrialBalance.tsx:96`); the GL page ignores `from`/`to` in the URL. | code | ADR-INV-11 |
| G-VAL-4 | `inventory_valuation_movements.kind` has a DB CHECK (`receipt, issue, transfer_out, transfer_in, reversal`) - a revaluation kind needs a small reversible migration. | `inventory/1755860000000-CreateInventoryValuationTables.ts:44` | ADR-INV-05 |
| G-F07-2 | F07 hard-codes currency `'EGP'`. | `inventory-adjustment.service.ts` (ingest call) | ADR-INV-05 |
These five are code-evidenced; the measuring cases are in the Gate D plan.

## 3. Target data flow (what changes is marked **NEW**; everything else is today's flow)
```mermaid
flowchart TD
  subgraph Docs[Operational sources]
    WD[Warehouse document\nreceipt / issue / transfer / adjustment / count]
    GR[Goods Receipt (PO)]
    OB[**NEW** Opening Balance Batch\n(draft -> submitted -> approved -> posted)]
    RET[Returns - return_in at original cost]
  end
  WD -->|**NEW** reason + reference validated;\napproval by effect; maker != checker| POST
  OB -->|FA-01 2 approvers, then explicit post| POST
  GR --> POST
  RET --> POST
  POST[recordMovement\n**NEW** optional businessDate + pre-mutation period gate]
  POST --> SM[(stock_movements)]
  POST --> VAL[(valuation state + movements\n**NEW** businessDate; revaluation kind)]
  POST --> OUTBOX[(event_outbox)]
  OUTBOX -->|**NEW** in-request flush after commit;\n30 s sweep stays as safety net| FE[Financial Event engine\nPOSTED / REJECTED / IGNORED, re-drive]
  FE --> HANDLER[Inventory costing handler\naccounts + period resolved BEFORE any valuation change]
  HANDLER --> JE[Journal entry (period gate, balanced)\ndated = business date]
  JE --> GL[GL ledger read model\n**NEW** status, source, links]
  JE --> TB[Trial Balance\n**NEW** periodic mode: opening / debit / credit / closing]
  VAL --> REC[Reconciliation v2 (read-only)\n**NEW** event view, categories, as-of]
  JE --> REC
  OUTBOX --> PS[**NEW** posting-status endpoint]
  FE --> PS
  REC --> PS
  PS --> UI[Screens: Overview (cost first), GL, TB, Reconciliation, Financial Events\n**NEW** auto-refresh hook + pending/failed chip]
  F07[F07 value-only write-down (FA-01)] -->|**NEW** product+warehouse required;\nsame transaction updates valuation| FE
```
Invariants kept end to end: movement + outbox row in one transaction; one event per movement (idempotency key); accounts and period resolved before any mutation; journals balanced and period-gated; reads are live SQL over posted lines; reconciliation never posts.

## 4. Change inventory
| Area | Added | Changed (additive) | Not changed |
|---|---|---|---|
| Company DB schema (inventory tag) | `inventory_opening_batches`, `inventory_opening_batch_lines` (+ partial unique index); `warehouse_transactions.referenceType/referenceId` (nullable); `inventory_valuation_movements.businessDate` (+ index, backfill) and a replaced CHECK adding `revaluation` | - | `stock_movements`, `warehouse_transaction_lines`, `inventory_valuation_state` |
| Company DB schema (accounting tag) | `inventory_reconciliation_runs.explainedBase/unexplainedBase/basis` (nullable) | - | journals, lines, financial events, fiscal tables |
| Core (terminology) | label seeds (`ON CONFLICT DO NOTHING`) | - | existing codes |
| Configuration keys | `inventory.movement_reason_catalog`, `accounting.inventory_issue_reason_accounts` (optional), `accounting.inventory_opening_correction_account_code` (after O-1), flags: `inventory.opening_batch_required`, `inventory.document_business_date`, `inventory.receipt_approval_required`, `inventory.document_sod_enforced`, `inventory.reference_enforcement`, `accounting.inventory_f07_updates_valuation`, `inventory.valuation_round_to_base`, `accounting.inventory_reconciliation_schedule`, `ui.auto_refresh` | manifest version bumps | all existing keys and values |
| Permissions | `inventory.opening_batch.create/approve/correct/override` | role templates for the new nodes | all existing nodes |
| Backend services | `InventoryOpeningBatchService`, `InventoryValuationReportService`, posting-status + financial-status readers, `LedgerService.getPeriodicTrialBalance` | `recordMovement` family (optional `businessDate`), `WarehouseTransactionsService` (policy by effect, SoD, reference/reason validation, overview cost KPI), costing handler (kinds `opening_reversal`, optional issue-reason posting), `InventoryAdjustmentService` + handler (valuation update, base currency), valuation engine (`applyRevaluation`, `getValuedPositions`, phase-2 rounding), `InventoryReconciliationService` | Event bus/outbox, `FinancialEventService`, `JournalEntryService`, fiscal period gate, GRNI path, returns (D4), shipment/fulfilment, `getTrialBalance` default payload |
| Contracts | optional parameters/methods on `InventoryValuationContract`; `InventoryPostingPolicy` (+`assertPostingDateOpen`); event payload optional fields (`businessDate`, `batchId`) | - | `INVENTORY_EVENT_TOPICS`, existing payload fields, TB gross-total contract |
| API | opening-batch routes; `valuation/report`; `posting-status`; document `financial-status`; `trial-balance?mode=periodic` | overview and ledger responses gain fields | every existing route and field |
| Screens | Opening Batches; Valuation report; auto-refresh + chips; GL/TB columns and drill | Overview, receipt/adjustment forms (reason, reference, approval) | all other screens |

## 5. Backward compatibility, data protection, migration, rollback
1. **Compatibility.** Every new parameter is optional and defaults to today's behaviour; new response fields are additive; default TB payload is golden-tested; the `excel_import` history and legacy documents remain valid and loadable.
2. **Behaviour changes only behind flags**, each with `off -> warn -> on` where meaningful, default `off`; turning a flag off restores the previous behaviour without data repair. No flag is switched on by a migration.
3. **Migrations** are additive and reversible (`down()` removes only what `up()` added); PostgreSQL 10.23-safe (no extensions, no generated columns, no `INCLUDE`/procedures; `gen_random_uuid()` comes from the existing compatibility function); the backfill is idempotent. **Company databases:** every migration ships with the fan-out instruction learned from the 1.1.10 incident (`RELEASE_COMPANY_MIGRATIONS=dry-run` then `on`, or the reviewed catch-up tool) and a release checklist item "Company databases migrated and verified (Stage A)". The package is never considered deployable on the platform migration alone.
4. **Data protection.** Gate C/D work runs on disposable databases only. Before any production use: the read-only Q-pack (Gate A section 8) is run by the owner on the real databases and reviewed; no automatic correction of history is ever performed (reconciliation attributes, accountants decide); opening batches never edit existing movements; reversal uses append-only offsetting rows.
5. **Rollback.** Application rollback keeps the (additive) schema and works because flags default off; documents/batches created under the new rules stay valid under the old code because they are ordinary movements and events. Schema `down()` is available but destroys new batch data and is not the recommended rollback.

## 6. Test plan (real PostgreSQL, Company A/B, per Gate D of the directive)
| # | Directive requirement | Evidence to produce |
|---|---|---|
| 1 | Stock receipt with correct financial effect | specs per source: manual receipt (approved), opening batch, Goods Receipt (unchanged), return_in; exact journal lines and valuation |
| 2 | Correct entry in the GL after posting | GL read model returns the line with status/source/links |
| 3 | Reflected in the TB for the right period | periodic TB opening/debit/credit/closing for back-dated documents |
| 4 | Screens update after posting without restart | in-request flush spec + browser verification on the preview (second session sees the change within the interval; filters preserved) |
| 5 | Retry / reconnect without duplicate | idempotent re-drive, double-click, post retry, hook back-off; counts of journals/events before/after |
| 6 | Failed or pending financial event | REJECTED (config removed) and pending (outbox) shown on the document, `posting-status`, Overview chip, reconciliation category |
| 7 | Debit/credit totals per report scope | three balance tests in periodic TB |
| 8 | Valuation vs GL with explanation | reconciliation v2 categories built deliberately; rounding property test; as-of tests |
| 9 | Company isolation, permissions, filters, periods | A/B on every new route and flow; Platform DataSource never requested; F6 scope; permission matrix |
| 10 | Regression of existing functions | full isolation regression (101/102 baseline exception documented), business suite T-00..T-31, CI, frontend build/lint, A/B specs named in Gate A section 7 |
Plus: migration tests (up/down/up, backfill idempotence, PG10 syntax scan), flag matrix (off/warn/on) on the same scenarios, T-10 R1-R10 extended with the new categories, and "refused operations change nothing" snapshot tests in the T-11 style. New business-suite steps follow the existing `T-xx` convention with preserved evidence.

## 7. Proposed Gate C sequence (each slice independently releasable, with its own evidence and regression)
1. **C1 observe-only:** valuation `businessDate` + as-of + report (ADR-08), overview cost KPI (ADR-07), reconciliation v2 (ADR-09, phase-1 rounding attribution), posting-status + financial-status + in-request flush + auto-refresh hook (ADR-10), GL/TB read models (ADR-11). No policy change.
2. **C2 dates:** business-date propagation behind its flag (ADR-02).
3. **C3 warn mode:** reason/reference validation and SoD in `warn` (ADR-03/04); measure real data.
4. **C4 opening batch:** ADR-01 with flag off.
5. **C5 enforcement:** switch `warn -> on` per flag after the owner's data review.
6. **C6 financial alignment (needs explicit approval):** ADR-05 and ADR-06 phase 2; issue-reason accounting only if G-ISS-1's policy is approved.
Rationale: observability first, so every later policy change can be measured and reversed.

## 7a. Operational note
The deployment of each slice must follow the Company-database procedure above; the owner-side Stage A/B tools remain valid for any Company migration shipped by these slices.

## 8. Risks and open points
| # | Item | Mitigation / owner |
|---|---|---|
| R1 | Production data is unknown (Q1/Q2 not yet run) | owner runs the Q-pack; no cut-over flag before review |
| R2 | Opening-correction accounting (O-1) | CTO/accounting decision; reversal-batch path independent |
| R3 | Retiring F07 `physical_count_variance`, revaluation rows | explicit approval of ADR-INV-05 matrix; `warn` first |
| R4 | Issue documents booked as COGS (G-ISS-1) | accounting policy decision; capture-only until approved |
| R5 | Rounding phase 2 changes valuation figures | after phase-1 residuals reviewed |
| R6 | Moving average follows processing order, not business date | stated limitation, no retro-costing |
| R7 | Polling load on shared hosting | single-flight, visible-tab only, 30 s default, flag |
| R8 | Behaviour change for storekeepers (receipts need approval) | flags, communication, `warn` period |
| R9 | Company databases left behind after deploy (1.1.10 lesson) | fan-out checklist + Stage A verification per slice |

## 9. Approvals requested
1. Approve the 12 ADRs as the Gate C scope, **or** list changes. The three you asked to review first - **ADR-INV-01 (opening), ADR-INV-05 (F07/D3), ADR-INV-06 (rounding/reconciliation with ADR-INV-09)** - are written to be reviewed on their own.
2. Decide O-1 (opening-correction account), the G-ISS-1 policy (issue reasons -> expense vs COGS), and whether rounding phase 2 is in scope after phase 1.
3. Confirm the C1-C6 sequence, and that C1 (no policy change) may start first once approved.
No Gate C work starts until these are answered.
