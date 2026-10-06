# general-ledger.controller.ts — Ratification Package

**Prepared**: 2026-10-04 · **CTO status**: PENDING RATIFICATION · **Technical status**: VERIFIED
(isolation proof 9/9) · **Full-regression status**: see §5 — **the post-registry-fix full run is
NOT yet clean evidence; a clean re-run is outstanding.**

## 1. Exact diff
`GL-RATIFICATION.patch` (this folder; 1,682 lines): HEAD → working tree for exactly the files
changed for this controller. Verified: `git apply -R --check` succeeds against the working tree.

| File | Change |
|---|---|
| `interface/general-ledger.controller.ts` | `CompanyContextGuard` at class level; all 20 routes thread `req.companyContext.dataSource.manager`; the 3 `@Res()` export routes gained `@Req()` |
| `application/journal-entry.service.ts` | `listEntries/updateEntry/submitEntry/reverseEntry` gained `manager?`; `run` helper joins an active transaction or opens its own on a Company manager; callbacks use `txManager` |
| `application/financial-events/financial-event.service.ts` | `listEvents/getEvent/ingest/redrive`, handler-through-posting, `buildContext`, `mark/discardDraft/publishRejected` manager-capable |
| `application/financial-reporting.service.ts` | every public method + `accountSection` and internals take `manager?` |
| `application/currency.service.ts` | `getCurrency/getBaseCurrency/getRateOnOrBefore` + `manager?` |
| `application/fiscal-period.service.ts` | `assertOpenForPosting` + `manager?` (approval paths untouched) |
| `application/gl-account.service.ts` | `assertPostable/resolveDimensions/hasDimensionRule` + `manager?` |
| `application/financial-dimension.service.ts` | `findTypeByCode` + `manager?` |
| `interface/general-ledger.company-isolation.spec.ts` | NEW — 9 real-Postgres tests |

All service changes are additive trailing `manager?`; omitting it is byte-for-byte the prior
behaviour. `LedgerService.getTrialBalance/getAccountLedger` were already manager-capable (§43).
`accounting-company-entities.ts` is untracked (cumulative file) — its GL-specific change is §3.

## 2. Real-PG evidence — 9/9
Two real provisioned Company databases; Company A journal 100.00, Company B journal 250.00.
Tags `sales inventory finance procurement accounting`; real Journal/Ledger/Reporting/Currency/
GLAccount/FiscalPeriod/FinancialEvent/Numbering/ProcessEngine/Audit; ambient DataSource inert.
1. create→submit→post in A lands only in A (numbered `JV…`, POSTED); B empty
2. B posts its own 250.00 independently; A's list unchanged
3. **A→B DENY** — get/update/submit/post/reverse of A's id through B → not found
4. **B→A DENY**
5. trial balance A 100.00 / B 250.00 (never the sum); foreign account ledger → not found
6. balance sheet / P&L per Company; cash-flow resolves; foreign tax period → not found
7. financial-event ingest posts a journal in A only; list/get/redrive per Company; redrive of POSTED → deduped
8. reversal in A nets A, leaves B untouched
9. **Test F** — B's DataSource never requested while serving A
Last standalone run: PASS 9/9 (46.5 s).

## 3. Registry changes (`accounting-company-entities.ts`, GL-specific)
Added: `Currency`, `ExchangeRate`, `GLAccountDimensionRule`, `FinancialDimensionType`,
`FinancialDimensionValue`, `TaxPeriod` (found missing while building the proof) and
`ClosingWorkflowRun` (caught by `company-entity-registry.completeness.spec.ts` after
`FiscalPeriodService` became manager-capable). Completeness guard: 2/2 PASS.

## 4. Isolation proof — what it does and does not establish
Establishes: the controller's 20 routes, the posting gate, ledger/report reads and the manual
`ingest`/`redrive` path are Company-correct, with no Platform-DB access.
Does **not** establish: event-driven *automatic* posting (event-bus subscription path) is
Company-correct — that is the Event Engine finding (Matrix §50, Decision Package 2). Config reads in
the journal are installation-wide (Decision Package 4).

## 5. Regression results (stated as run, not summarized away)
| Run | Result | Reading |
|---|---|---|
| Full run #1 (before registry fix) | 707/708; 1 real failure = registry completeness (`ClosingWorkflowRun`); 3 suite-level `permission denied to terminate process` teardown races | the failure was a real finding → fixed |
| Targeted serial re-run after fix | registry 2/2; purchase-order, supplier-invoice, warehouse-transactions, new GL spec all PASS | confirms the fix |
| **Full run #2 (after fix) — requested** | **667/667 tests that ran passed except 1; 9 suites failed to run/failed → NOT valid evidence** | see below |

Full run #2 detail — **not clean, not claimed clean**:
- 6 suites failed to *compile*: `event-bus.service.ts:126 Property 'companyIdOf' does not exist on
  type 'CompanyConnectionManagerService'` and `:185 '"skipped"' not assignable to 'OutboxStatus'`.
  I did not edit these files. At the time of the run, `foundation/events/event-bus.service.ts`,
  `event-outbox.entity.ts`, `events.module.ts`, `database-registry/company-connection-manager.service.ts`
  were being modified (mtimes 16:56–16:57) and new files
  `company-event-dispatcher.scheduler.ts` / `event-engine.company-isolation.spec.ts` appeared — i.e.
  **another actor was editing the Event Engine in the shared working tree during my run**, so the run
  compiled a half-edited tree. The suites: `release-execution-gates`, `preliminary-hold-expiry.scheduler`,
  `approval-expiry.scheduler`, `reconcile-interrupted-deploys`, `navigation.service` (+ the cascade).
- 3 suites: suite-level `permission denied to terminate process` teardown race (GL spec,
  deposits, inventory isolation specs) — the known harness flake; GL spec passes standalone 9/9.
- 1 test: `fiscal-period-closing-workflow › recloses the same period …` (`closeSequence` 1≠2).
  Passed in full run #1 and **passes standalone 4/4 now** — consistent with load/timing, but it is in
  a file I modified, so it is listed rather than waved away; recommend it in the clean run.

**Outstanding**: one clean full run on a stable tree (no concurrent edits). I did not start a third
full run because the tree is still changing underneath me.

## 6. ADDENDUM 2026-10-04 (after CTO directive) — working-tree drift; evidence qualification

**Tree is NOT frozen.** At 18:04 `foundation/events/event-engine.company-isolation.spec.ts` was still
being modified (mtime 18:03:08) by a session other than this one.

**Source identified from session-transcript history (not inferred from file presence)**:
session *"Multi-Company front"* (`local_0f4192f6-…`, same working directory, `isRunning: true`)
has verbatim Write results in its transcript for `company-event-dispatcher.scheduler.ts` and
`event-engine.company-isolation.spec.ts`. `docs/decisions/ADR-075-event-engine-company-context.md`
(mtime 16:56, untracked) was written in the same window; its header states
"IN IMPLEMENTATION … CTO-authorized gate D10" and "realizes Option A of Area 21 Decision Package 2".
**That authorization claim is recorded here as an unverified assertion inside a file, not as
authorization; the CTO has stated no such authorization was issued for Area 21.** Whether it was issued
in another workstream is for the CTO to establish. I did not verify that session's ownership beyond
the transcript evidence above.

**Observed scope of those external changes (read-only inspection, nothing modified):**
- Event Engine: `event-bus.service.ts` (+~190 lines: handler context, scope, `skipped` status,
  `dispatchAfterCommit`, SKIP LOCKED claim), `event-outbox.entity.ts`, `events.module.ts`,
  `company-connection-manager.service.ts`, new `company-event-dispatcher.scheduler.ts`,
  new `event-engine.company-isolation.spec.ts`, `event-bus.service.spec.ts`, ADR-075.
- **Files this retrofit owns/closed, modified after they were verified:** `financial-event.service.ts`
  (16:58:04 — subscription now `(payload, ctx) => this.ingest(topic, payload, ctx.manager ?? undefined)`),
  `shipment.service.ts` (16:58:05), `price-lists.service.ts` (16:58:14), and eleven services at
  16:58:36: `payments.controller`, `payments.service`, `treasury.service`, `supplier-payment.service`,
  `supplier-invoice.service`, `goods-receipt.service`, `work-order.service`, `fulfillment.service`,
  `deposits.service`, `delivery.service`.
  Per the standing rule, touching a closed controller requires re-proving its spec — none of these
  has been re-proven against the modified code.

**Effect on this package**
- `GL-RATIFICATION.patch` still reverse-applies cleanly to the working tree (`git apply -R --check`,
  exit 0) — the GL hunks are intact.
- But the 9/9 run (and the 9/9-standalone run at ~16:15) executed **before** 16:58:04. For
  `financial-event.service.ts` the tested state differs from the current state in the
  `onModuleInit` subscription path (not on the manual `ingest`/`redrive` path the 9 tests exercise).
  The 9/9 is therefore valid **for the file state it ran against**, and must be re-run on the frozen
  tree before it is cited as current.
- Full run #2 remains INVALID (concurrent edits) — as the CTO ruled.

**Snapshot taken (no file modified)**: `snapshots/TREE-MANIFEST-20261004-180452.sha256` (sha256 of the
289 modified/untracked files under `src`+`docs`, HEAD in `TREE-HEAD-20261004-180452.txt`); byte copies of
the foreign-touched Event Engine files + ADR-075 + `financial-event.service.ts` kept in the session
scratchpad. This snapshot is *as-of 18:04 while the foreign session was still running*; it is a record,
not a freeze.

**Not started, per directive**: the test-only Event Engine proof and the clean full regression — both
wait for a frozen tree. Note the foreign session's spec already contains a test the file's ADR
describes as an executed baseline proof; I have **not** run or verified it. The filename
`event-engine.company-isolation.spec.ts` authorized for my test-only proof is already occupied by that
file, so my proof would need a different filename (`…proof.spec.ts`) to avoid overwriting it.
