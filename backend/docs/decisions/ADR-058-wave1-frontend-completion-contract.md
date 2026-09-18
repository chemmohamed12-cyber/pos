# ADR-058 — Wave 1 Frontend Completion: Implementation Contract (Phase 0)

**Status:** Approved baseline for implementation (Phase 0 — contract only).
Scope: **Accounting / Procurement Operational UI Completion** — the exact
five gaps the Wave 1 Completion Audit found, nothing wider. Derived from
direct audit of the current frontend architecture (routing, navigation,
page/component patterns, permission model) plus the exact backend contracts
already shipped (ADR-050/051/054/056/057). No code, migration, schema,
permission, or backend change is authorized by this document.

## 0. Current frontend architecture (verified, not assumed)

- **Routing:** `react-router`, most domain pages flat (`/suppliers`,
  `/purchase-orders`), accounting pages nested (`/accounting/ar`,
  `/accounting/ap`, …) — an existing, pre-established inconsistency this
  contract does not fix, only follows (new accounting pages go under
  `/accounting/*`, matching every existing accounting page).
- **Navigation:** `src/components/Layout.tsx`, a flat array of `{ code:
  'nav_group.x', items: [{ to, code: 'nav.y', roles: [...] }] }` groups.
  Gating is **role-based only** (`roles: ['admin']` or `['admin',
  'finance']`) — there is no fine-grained permission-node check at the
  sidebar level anywhere in this codebase; the page itself calls the API
  and lets a 403 surface as an on-page error if the role gate was
  insufficiently strict. Existing precedent: **accounting internals
  (ledger, reconciliation, settings) are `roles: ['admin']` only**;
  **procurement/AR/AP subledger-facing pages are `['admin', 'finance']`**.
- **Page pattern** (verified against `ApReconciliation.tsx`, the closest
  existing analog to every new screen below): `useLanguage()` →
  `{ t, preload }`; `preload([...codes])` once per component; `api.get`/
  `api.post` from `lib/api`, catching `ApiError`; local `busy`/`error`/
  `notice` state; CSS classes `page-header`, `card`, `data-table`,
  `form-field`, `btn btn-primary|btn-secondary|btn-danger`, `empty-state`,
  `error-text`; `<StatusBadge code="value.x.y" />` for any status column
  (colors itself by keyword heuristics on the code — no new component
  needed for GRNI/Closing/Snapshot statuses).
- **Approvals:** `<ApprovalsPanel requestTypeCodes={[...]} decidePath={(id)
  => \`...\`} onDecided={...} />` is a **generic, already-reusable**
  component — fetches pending requests for any list of FA-01 request-type
  codes and renders approve/reject with a note field. **Reused as-is** for
  Period Close/Reclose/Reopen approvals — no new approval UI is built by
  this contract anywhere.
- **No existing "drill down to source document" pattern.** Verified:
  `FinancialEvents.tsx` displays `sourceEntityId` as a raw string, never a
  link. This is a real gap in the CURRENT codebase, not something Wave 1
  Frontend Completion can silently inherit a pattern for — see Open
  Decision L.1.
- **A concrete, currently-BROKEN control, found during this audit's own
  source read:** `AccountingSettings.tsx` (the ONLY existing fiscal-period
  UI — there is no separate page) renders, for a period in `reopened`
  state, a button calling `transitionPeriod(fy.id, p.id,
  'close_after_reopen')` — i.e. `POST /accounting/fiscal-periods/:id/
  transition {action: 'close_after_reopen'}`, the routine/ungated
  endpoint. `ADR-051 §1.2` (Month-End Phase 3/4) removed `close_after_
  reopen` from that endpoint's legal action list — **this button now
  always fails** with "must go through the FA-01 approval flow." This is
  not a missing feature, it is a regression this contract must fix.

## A. GRNI Reconciliation UI (new page)

| | |
|---|---|
| **Route** | `/accounting/grni` |
| **Navigation** | `module.accounting` group, immediately after `nav.inventory_accounting` (mirrors `InventoryReconciliationService`'s adjacency to GRNI in the backend's own reconciliation list). `roles: ['admin']` — matches every other accounting-internals page (`ar`/`ap`/`cash-bank`/`inventory`), not procurement's `['admin','finance']`, since this is the GL-side reconciliation view, not an operational procurement screen. |
| **API contract** | `GET /accounting/grni/reconciliations` (list), `GET /accounting/grni/reconciliations/:id` (detail), `POST /accounting/grni/reconciliations` (run — body `{}` or `{fiscalPeriodId?, asOfDate?, orgUnitId?}`), `POST /accounting/grni/reconciliations/:id/close`. All four already exist, unchanged by this contract. |
| **Data displayed** | Per run: `asOfDate`, `subledgerTotalBase`, `glBalanceBase`, `driftBase`, `status` (`StatusBadge`, values: `open\|matched\|drift_found\|closed\|no_subledger_source`). On `drift_found`, `driftBreakdown.subledgerBalances[]` (`goodsReceiptId`, `goodsReceiptNumber`, `purchaseOrderId`, `supplierId`, `balance`) — the received-vs-invoiced exposure per receipt, exactly `ADR-054` item 4's traceability requirement made visible. |
| **Actions** | Run reconciliation (button, mirrors `ApReconciliation.tsx`'s "run" button exactly); Close a run (per-row button, `status !== 'closed'`). **No adjustment form** — unlike AP/AR/Cash-Bank, GRNI has no adjustment mechanism (`ADR-057 §4`: no correction/reversal path exists yet, deliberately not built) — this page must not invent one. |
| **Permission** | `accounting.grni.view` (read-only: list/get) / `accounting.grni.create` (editable: run/close) — both already registered (`ADR-057`), no new node. |
| **Read/write boundary** | Entirely read/derive — "run" only computes and records a comparison, never posts a correcting entry (same as every other reconciliation page). |
| **States** | Loading: `runs === null` → `"Loading…"` (matches existing pages verbatim, including their un-localized literal — not fixed here, out of scope). Empty: new `panel.no_grni_reconciliations_yet`. Error: `error-text` from `ApiError.message`. |
| **Audit** | None added — every action already produces its own backend `AuditService` record (`accounting.grni_reconciliation.run`/`.closed`); the UI does not need its own audit trail. |
| **Relationship to existing screens** | Sibling of `ApReconciliation.tsx`/`InventoryAccounting.tsx` — same shape, same list, same drift display. Per-receipt rows in the drift breakdown reference `purchaseOrderId`/`goodsReceiptId` — see Open Decision L.1 for whether these become links. |

## B. Month-End (new pages: Closing Audit, Closing Exceptions)

Two screens, deliberately kept separate (Audit = a run + its snapshot of
findings at that moment; Exceptions = the live, resolvable queue) rather
than one page trying to be both.

### B.1 Closing Audit dashboard

| | |
|---|---|
| **Route** | `/accounting/fiscal-periods/:periodId/closing-audit` |
| **Navigation** | Not a sidebar item — reached FROM the Fiscal Period row in `AccountingSettings.tsx` (a new "View Closing Audit" link per period row), matching how this codebase already nests detail views under a parent list rather than flattening everything into the sidebar (e.g. `accounting/journals/:id`). |
| **API contract** | `POST /accounting/fiscal-periods/:id/closing-audit` (run a fresh audit — this is the SAME endpoint `submitPeriodClose` calls server-side; the UI calling it directly is a **preview**, not a second workflow), `GET /accounting/fiscal-periods/:id/closing-audit` (list prior runs), `GET /accounting/fiscal-periods/:id/closing-workflow-runs` (the `audit_run → exceptions_open/final_reconciliation_passed → approval_submitted → period_locked` evidence trail). |
| **Data displayed** | Per audit run: `asOfDate`, `status` (`clean\|exceptions_found`), `createdAt`. Per workflow run: `entryState` (`soft_close\|reopened`), `status`, `approvalRequestId`, `completedAt` — the six-check summary (AR/AP/Cash-Bank/Inventory/Fixed-Asset/GRNI) is **not** a separate field to display; it is entirely represented by the linked `ClosingException` rows (section B.2) for that run. |
| **Actions** | "Run Closing Audit" (preview button) — the ONLY action here. No approve/resolve controls on this screen (those live on Exceptions and on the Fiscal Period row respectively) — this screen is a **read/preview surface**, per the CTO directive's explicit "must not introduce a second business workflow." |
| **Permission** | `accounting.fiscal_period.view` (read-only) for everything on this page, including the "run" preview button (already the exact node the backend route uses). |
| **Read/write boundary** | The "run" action writes (`ClosingAuditRun` + `ClosingException` rows), but produces no accounting effect and gates nothing by itself — identical read/write shape to every other reconciliation "run" button already in this codebase. |
| **States** | Loading/empty/error: same convention as A. Empty workflow-run list: new `panel.no_closing_workflow_runs_yet`. |
| **Audit** | None added — `ClosingAuditService.run()` already records via `AuditService`. |
| **Relationship to existing screens** | Reached from `AccountingSettings.tsx`'s period row (new link). Links forward to Closing Exceptions (B.2) filtered to this run/period. |

### B.2 Closing Exceptions

| | |
|---|---|
| **Route** | `/accounting/fiscal-periods/:periodId/closing-exceptions` |
| **Navigation** | Same as B.1 — reached from the period row, not the sidebar. |
| **API contract** | `GET /accounting/fiscal-periods/:id/closing-exceptions` (list, all severities/statuses), `POST /accounting/closing-exceptions/:id/acknowledge` (body `{note}`), `POST /accounting/closing-exceptions/:id/annotate-test-artifact` (body `{reason}`). All three exist, unchanged. |
| **Data displayed** | `module`, `category` (6 values — `LIVE_DISCREPANCY`, `DORMANT_SOURCE`, `EXPECTED_BUSINESS_REJECTION`, `CONFIGURATION_EXCEPTION`, `HISTORICAL_TEST_ARTIFACT`, `UNCLASSIFIED_REJECTION`), `severity` (`blocking`/`informational` — **the field that actually gates closing**, must be the most visually prominent column, e.g. `StatusBadge`), `problem`, `requiredAction`, `status` (`open\|acknowledged\|resolved\|waived`), `documentType`/`documentId`/`transactionRef`/`accountOrSubledgerRef`/`amount` (traceability fields), `annotation` (when present: who/when/why, rendered read-only — never editable once set). |
| **Actions** | Acknowledge (only when `status === 'open'`, requires a note — form field, not a bare button); Annotate as test artifact (only when `module === 'financial_events'` and `category !== 'HISTORICAL_TEST_ARTIFACT'` already, requires a reason). **No "resolve" button anywhere** — `resolved` is only ever set by a fresh Closing Audit run finding the exception no longer reproduced (`ADR-051 §2`); the UI must not imply a human can resolve one directly, and must not add a control that tries to. |
| **Permission** | `accounting.closing_exception.resolve` gates Acknowledge (the node name reflects the overall workflow, not literally "resolve" — `ADR-051 §15`, already frozen); `accounting.closing_exception.annotate_test_artifact` gates the annotation action — its own separate, narrower node, deliberately. `accounting.fiscal_period.view` gates the list itself (implicit — the list route requires no extra node beyond viewing the parent period's data, consistent with B.1). |
| **Read/write boundary** | Acknowledge and Annotate are the only writes; both are narrow, single-purpose, already-built backend actions — the UI adds no new business rule. |
| **States** | Empty: `panel.no_closing_exceptions`. A `HISTORICAL_TEST_ARTIFACT` category is disclosed in the study (`Month-End Study §2.3`) as something to restrict outside Production by policy — **this UI does not enforce that restriction itself** (no environment check exists in the frontend layer anywhere in this codebase); flagged as Open Decision L.2. |
| **Audit** | None added — both actions already call `AuditService.record` server-side. |
| **Relationship to existing screens** | Filtered view reachable from B.1; `severity: blocking` items here are exactly what `submitPeriodClose` on the Fiscal Period row (section C) will refuse to proceed past — the UI should make that connection legible (e.g., a period row's "Submit Close" button being disabled/explained when open blocking exceptions exist is a **nice-to-have**, not required — the backend already refuses correctly regardless of what the UI shows; see Open Decision L.3). |

## C. Period Closing (extend the existing Fiscal Period UI in `AccountingSettings.tsx` — not a new page)

This is a **fix + a small addition to existing code**, not new screen
construction — precisely bounded by what was found broken/missing in §0.

1. **Fix the broken button** (regression, not a feature): for `p.status
   === 'reopened'`, replace the `transitionPeriod(fy.id, p.id,
   'close_after_reopen')` call with `submitPeriodClose(fy.id, p.id)` — the
   SAME function already used for `soft_close` state. `ADR-051`'s unified
   `submitPeriodClose` entry point already picks the correct FA-01 request
   type (`accounting.fiscal_period.reclose`) and target transition
   server-side; the frontend needs no new logic, only to call the
   already-correct existing function instead of the now-blocked one.
2. **Add `accounting.fiscal_period.reclose` to `FISCAL_CLOSING_REQUEST_
   TYPE_CODES`** (currently `['accounting.fiscal_period.close',
   'accounting.fiscal_period.reopen', 'accounting.fiscal_year.close']`) so
   a pending reclose approval actually appears in the existing
   `<ApprovalsPanel>` already rendered on this page — a one-line array
   addition, the panel itself needs no change.
3. **Rename the button's label** for the `reopened`-state action from
   `action.close_after_reopen` to reuse `action.submit_period_close`
   (already exists, already used for the `soft_close`-state button) — both
   states now go through the identical maker-side action, the label should
   say so.
4. **Link to Closing Audit/Exceptions** (B.1/B.2) — add a "View Closing
   Audit" link per period row, next to the existing status/action cell.

No other change to this page. Fiscal Year create/activate/close and the
routine `soft_close`/`reopen_from_soft_close` transitions are unaffected
and already correct.

| | |
|---|---|
| **Permission** | Unchanged — already `accounting.fiscal_period.edit`/`.reopen`/`.view`, all already wired on this page. |
| **Audit** | None added — unchanged backend actions. |

## D. Immutable Black Box (new page: Snapshot list + detail)

| | |
|---|---|
| **Route** | `/accounting/fiscal-periods/:periodId/closing-snapshots` |
| **Navigation** | Reached from the period row (B.1/C), not the sidebar — same rationale as B. |
| **API contract** | `GET /accounting/fiscal-periods/:id/closing-snapshots` (list), `POST /accounting/closing-snapshots/:id/verify` (recompute hash/signature/chain — **never mutates**). No "download raw file" endpoint exists today — see Open Decision L.4. |
| **Data displayed** | Per snapshot: `closeSequence`, `status` (`pending\|complete\|failed`), `supersedesSnapshotId` (rendered as "supersedes Close #N" when present — the chain, made legible), `contentHash`, `manifestHash`, `signingKeyId`, `generatedAt`, `approvalRequestId`. Verify result (on demand, not auto-run for every row — a real cryptographic operation per click): `ok`, `contentHashMatches`, `signatureValid`, `chainValid` (`true\|false\|null` — `null` rendered distinctly as "no predecessor to check", never conflated with `false`). |
| **Actions** | "Verify" (per row, read-only recomputation) — **no other action**. Explicitly **no delete, no re-generate, no edit of any field** — the CTO directive's own "no destructive actions" requirement; the UI must not add a control for anything the backend itself has no mutating endpoint for. |
| **Permission** | `accounting.closing_snapshot.view` (list) / `accounting.closing_snapshot.verify` (the verify action) — both already registered, no new node. |
| **Read/write boundary** | 100% read-only from the UI's perspective — "verify" performs real computation server-side but writes nothing (confirmed: `ClosingSnapshotService.verify()` never calls `.save()`). |
| **States** | A `'pending'` or `'failed'` row (the recovery-sweep's own territory, `ADR-051 §12/§14`) should render distinctly (e.g. a neutral/warning badge, not an error) with a short explanatory note — never imply the user should act on it (no "retry" button — that's the scheduler's job, not a user action, and no endpoint exists for it). Verify failure: show which of the three checks failed (content/signature/chain), matching the backend's own three-way distinction — never collapse to one boolean. |
| **Audit** | None added — snapshot generation and verification already audit-record server-side. |
| **Relationship to existing screens** | Reached from the period row; the chain (`supersedesSnapshotId`) visually connects multiple close/reclose cycles for the same period, giving the "September Close #1 → Reopen #1 → Close #2" narrative the original directive asked for a physical home in the UI. |

## E. UX / Permissions (cross-cutting, applies to A–D)

- **RTL:** every new page follows the existing pattern exactly (`useLanguage()`'s `t()`, no hardcoded direction/layout — the existing CSS/layout system already handles RTL globally; no new page-level RTL logic is introduced anywhere in this codebase's existing pages and none should be here).
- **Sidebar:** only A (GRNI) gets a new sidebar entry (`module.accounting` group, `roles: ['admin']`). B, C(link only), D are reached via in-page navigation from the Fiscal Period row, not new top-level nav items — matching this codebase's own existing "detail views nest, they don't flatten into the sidebar" convention.
- **Permission model:** every screen above reuses an **already-registered** permission node — this contract introduces **zero new permission nodes, zero manifest changes, zero admin-grant migrations**. Confirmed: `admin`'s existing blanket `accounting: editable` role grant already covers every node listed above via the Permission Engine's ancestor walk (the same mechanism confirmed for every prior phase this program).
- **No package/edition bypass:** every new page calls the SAME `api` client, under the SAME `RequireModuleGuard`-gated `accounting` module the rest of the accounting section already requires — no new entitlement check, no hardcoded skip.
- **Terminology:** every `t('field.x')`/`t('action.x')`/`t('panel.x')`/`t('value.x.y')` code referenced above is **new** and does not yet exist in the Terminology Registry — seeding them (an idempotent `ON CONFLICT` migration, matching every prior terminology addition this program made) is implementation work, correctly **out of scope for this Phase 0 contract**, but the exact code list is enumerated per-screen above so the implementation phase does not have to re-derive it.

## F. Explicit relationship to the backend lifecycle (the CTO directive's own requirement, restated precisely)

None of A–D introduce a second business workflow:

- GRNI reconciliation's "run" button is a **preview** of the exact same computation `ClosingAuditService` already performs as part of closing — not a parallel check.
- Closing Audit's "run" button is the exact same `POST .../closing-audit` endpoint `submitPeriodClose` calls server-side — the UI exposing it separately is for **visibility before committing**, never a different computation.
- Closing Exceptions' only writes (acknowledge, annotate) are the exact two human-settable transitions the backend already defined — no "resolve" control is added, preserving `ADR-051 §2`'s "resolution is proven by a fresh audit, never asserted" invariant.
- Period Closing's fix routes the SAME action through the SAME unified `submitPeriodClose` entry point already used for the first-close case — it does not create a second close path, it removes the UI's own accidental use of a blocked one.
- Black Box's only action (verify) performs the exact server-side recomputation already defined, writes nothing.

## G. Open Decisions (explicit sign-off requested before implementation)

1. **Drill-down linking** (§A, §B.2): should `purchaseOrderId`/
   `goodsReceiptId`/`supplierInvoiceId` references become real
   `<Link>`s to the existing Procurement pages, or stay as plain text
   (matching `FinancialEvents.tsx`'s current, established precedent of
   showing a raw ID)? No existing page in this codebase currently deep-links
   into another list by ID — introducing that pattern here is a small but
   real, disclosed, new UX capability, not free.
2. **`HISTORICAL_TEST_ARTIFACT` Production posture** (§B.2): the backend
   study flagged restricting this category outside Production as a
   decision never made concrete anywhere. Should the frontend show/hide
   the "Annotate as test artifact" action based on environment, given no
   such environment-aware UI gating exists anywhere else in this codebase
   today?
3. **Blocking-exception visibility on the Fiscal Period row itself**
   (§B.2): nice-to-have vs. required — does the CTO want the existing
   "Submit Close" button pre-emptively disabled/annotated when open
   blocking exceptions exist, or is "the backend already refuses with a
   clear message" sufficient for V1?
4. **Snapshot raw-file access** (§D): no download/export endpoint exists
   today for a Black Box snapshot's actual signed JSON file — is that
   needed for Wave 1 (e.g., for handing evidence to an external auditor),
   or deferred?

## H. Proposed implementation sequence (after sign-off)

1. **C** (fix the broken button + add the reclose request-type code + link
   to B) — smallest, highest-priority (an active regression), touches one
   existing file.
2. **A** (GRNI Reconciliation) — net-new but a near-exact mirror of an
   existing page, lowest design risk.
3. **B.1 + B.2** (Closing Audit + Closing Exceptions) — net-new, two
   screens, moderate complexity (structured exception data, two write
   actions).
4. **D** (Black Box) — net-new, read-only, cryptographic-result display is
   the only new UI concept.
5. Terminology seed migration (all codes enumerated per-screen above, one
   idempotent migration, mirroring every prior terminology addition).
6. Manual verification pass (live, in-browser) against each screen's own
   states table above — no automated frontend test suite exists in this
   codebase to extend.

---

**No code, migration, schema, UI, permission, or backend change was made to
produce this document.** Production remains HOLD. Awaiting sign-off on §G
before implementation begins.
