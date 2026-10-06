# AREA 21 — Decision Packages (5) — for CTO ruling

**Prepared**: 2026-10-04 · **Status**: EVIDENCE ONLY. No production code, no engine change,
no controller work was done for this document. Every recommendation below is a
*recommendation*, not an authorization — nothing proceeds until you issue the
Retrofit Authorization.

Working rule from here (per your directive):
`Evidence → Decision → Authorization → Code → Real-PG → Regression → Closure`.

## 0. One-page summary

| # | Package | The question | Unblocks (controllers) | Depends on | My recommendation |
|---|---|---|---|---|---|
| 5 | Tax / Invoice | Is `TaxCode` Company data? | `invoices`, `returns` (2) | — | **Company-scoped** |
| 3 | `sales_rep` | Company-local role or platform designation? | `sales` (1) + `admin` sales-reps route | — | **Company-local** |
| 4 | Config Engine | Installation-wide or per-Company policy values? | none directly — gates Gate D, and package 1's TTL | — | **Layered: installation registry/flags/edition, per-Company policy values** |
| 2 | Event Engine | Company-aware dispatch? | none directly — **Area 21 cannot be VERIFIED without it** | — | **Company-aware handler context + per-Company dispatcher (ADR)** |
| 1 | Approval Engine | Company-scoped or installation-wide? | 13 (`supplier ap ar cash-bank inventory-accounting fixed-asset attendance commission hr payroll rfq target accounting`) | 2 (callbacks), 4 (TTL) | **Company-scoped (ratify Area 9)** |

Suggested ruling order (smallest independent first, largest dependent last):
**5 → 3 → 4 → 2 → 1.** Remaining after all five are decided and implemented:
16 controllers → 0.

Counts: 27 technically verified (general-ledger pending ratification, so formally
26 + GL), 16 remaining = 13 (Approval) + 2 (Tax/Invoice) + 1 (`sales_rep`).

---

## Package 5 — Tax / Invoice

**Evidence**
- `TaxEngineService` (accounting-owned, `src/domains/accounting/application/tax-engine.service.ts`)
  has exactly two public methods — `calculateForInvoice`, `resolveTaxAccountCode` — and both read
  `TaxCode` through the **ambient** `this.dataSource.getRepository(TaxCode)`. No `manager?`.
- Sole business consumer: `InvoiceService` — three call sites (draft calculation, and tax-account
  resolution on post and on void). Reached through `TAX_ENGINE_CONTRACT`
  (`foundation/module-registry/contracts/tax-engine.contract.ts`), which would need the matching
  `manager?` widening (same contract-drift pattern as §21.1/§23.0).
- `TaxCode` maps to `accounting_tax_codes`, created by the **accounting** migration tag
  (`1755854400000-CreateAccountingTables`) — i.e. the table already exists inside every
  Company database provisioned with `accounting`. `TaxCode` is **not** in
  `COMPANY_ENTITY_REGISTRY` today, so no Company DataSource can query it.
- `InvoiceService.getInvoice(invoiceId, actorUserId)` also has no `manager?` (§23.1). This is
  **not a decision** — it is customer-finance's own in-domain gap and belongs to the
  `invoices.controller.ts` retrofit scope; `returns.controller.ts` (`applyCreditToInvoice`) is
  unblocked by it. Listed so it isn't mistaken for a second open question.
- Tax *account codes* are GL account codes; the chart of accounts is per Company (Model B).

**Options**
- **A (recommended): `TaxCode` is Company-scoped.** Rates and the tax GL account are per legal
  entity/jurisdiction and bound to that Company's chart. Work: register `TaxCode` in
  `accounting-company-entities.ts`; add trailing `manager?` to the 2 engine methods + contract;
  retrofit `invoices.controller.ts` (including `InvoiceService.getInvoice`), then
  `returns.controller.ts`.
- B: tax master is installation-wide (one shared rate table). Contradicts the fact that the
  resolved value is a Company GL account code and that invoices are Company data; would leave a
  Platform-DB read on a Company request path — a Gate A violation by construction.

**Blast radius if A**: 1 accounting-owned service (2 methods) + 1 contract + registry entry +
2 controllers. Not a shared engine; no other consumer of `TaxEngineService` (the
`accounting.controller` tax code/period CRUD is in the Approval-blocked set and is handled there).

**Required proof**: real-PG A/B — Company A and B hold *different* `TaxCode` rates for the same
code; an invoice drafted in A uses A's rate, in B uses B's; A→B DENY on a foreign `taxCodeId`.

**Decision requested**: *Is `TaxCode` Company-scoped (A) or installation-wide (B)?*
And: *authorize editing `TaxEngineService` + `TaxEngineContract` (accounting-owned)?*

---

## Package 3 — `sales_rep`

**Evidence**
- `sales_rep` is one of the six **v1 role keys seeded by the `core` migration**
  (`1755840300000-CreateAuthorizationTables`). The `core` tag is applied to every Company DB, and
  `Role`/`UserRole` are already in `COMPANY_ENTITY_REGISTRY` (`core-company-entities.ts`) — so a
  Company-local `sales_rep` role **already exists in each Company database**.
- Yet every `sales_rep` read/write goes to the **platform** mechanism:
  `SalesService.createSalesRepProfile → AuthorizationService.assignRole`,
  `SalesService.isSalesRep → hasRole`, `admin.controller GET /admin/sales-reps →
  getUserIdsForRole('sales_rep')`. `AuthorizationService` is `@InjectRepository`-bound with no
  `manager?`, documented in its own class comment as platform-level role grants.
- `AuthService` bootstraps the first **platform** `admin` through the same `assignRole` — that use
  is legitimately platform-level and is not part of this decision.
- The only other occurrences of the string `sales_rep` are the commission **policy scope** enum
  (`'sales_rep' | 'customer' | 'customer_group'`) — an unrelated Company-data value, unaffected.

**Options**
- **A (recommended): Company-local role.** `SalesService` uses manager-capable role operations
  against the Company DB (`manager?` on `assignRole`/`hasRole`/`getUserIdsForRole`, additive). The
  admin list becomes a Company-scoped route (needs a Company context); the platform
  `GET /admin/sales-reps` is removed or reduced to a platform-admin "pick a Company" wrapper.
- B: platform-wide designation. `SalesRepProfile` stays Company data but the role flag is global:
  a user flagged in Company A passes the role check in Company B — contradicts the membership
  model (Membership is the authority for "who is in which Company").

**Open sub-decision (needs your call under A)**: existing **platform** `user_roles` rows for
`sales_rep` — backfill into each Company the user is a member of, or start clean (the V1 install
base's real count is unknown to me; I have not queried production data).

**Blast radius if A**: 3 methods on one foundation service (additive `manager?`; platform callers
unchanged) + `sales.controller` (42 lines) + the admin route. `AuthorizationService` is a
foundation service — hence this needs explicit authorization.

**Required proof**: real-PG A/B — rep assigned in A is not a rep in B; `getUserIdsForRole`
through A returns only A's reps; A→B DENY; platform `admin` bootstrap path unchanged.

**Decision requested**: *Company-local (A) or platform-wide (B)? Backfill policy? Authorize the
additive `manager?` on `AuthorizationService`?*

---

## Package 4 — Config Engine

**Evidence**
- `ConfigurationEngineService.get(key, ctx?)` is **synchronous** over an in-process cache loaded from
  the **ambient** DataSource at boot and reloaded every 300 s (`core.config.cache_reload_seconds`).
  `ConfigContext` carries `userId` and `orgId` only — **no `companyId`**.
- `config_keys` / `config_values` are **not** in `COMPANY_ENTITY_REGISTRY`.
- 19 non-test files consume the engine (accounting 8, approval-engine 2, config-engine 4,
  module-lifecycle 2, limit-engine 1, authentication 1, returns 1) — about 54 call sites.
- **Concrete correctness exposure, not just a hygiene gap**: ten keys resolve **GL account codes**
  — `accounting.ap_expense_account_code`, `ap_opening_balance_…`, `ap_write_off_income_…`,
  `ar_opening_balance_…`, `ar_write_off_expense_…`, `cash_bank_opening_balance_…`,
  `cash_movement_clearing_account_code`, `fixed_asset_gain_on_disposal_…`,
  `fixed_asset_loss_on_disposal_…`, `inventory_cogs_account_code`. The chart of accounts is per
  Company database; an installation-wide value naming account `5100` is looked up in each
  Company's own chart (`FinancialEventService.resolveConfiguredPostableAccount`). Two Companies
  with different charts cannot both be right.
- Other consumers are genuinely installation-level: edition/entitlement
  (`ActiveEditionProvider`), feature flags (`RequireFeatureGuard`, used by 6 files), module
  lifecycle, the cache-reload interval itself.
- Not blocking any of the 16 controllers directly; it is **Gate D** (cache/state) and it feeds
  package 1 (`core.approval.request_ttl_hours`).

**Options**
- **A (recommended): layered.** Registry (keys/defaults/types), edition and feature flags stay
  **installation-wide** by explicit decision. **Policy values** (anything Company-owned — account
  codes, backdating days, return window, P&L dimension policy, approval TTL) become
  **per-Company overrides** stored in each Company DB (`config_values` joins the Company registry),
  resolved Company-value → installation default. API: `get(key, { companyId, … })`; the engine keeps
  one sync cache **per Company** (loaded when the Company connection is created, reloaded on the
  same interval). Callers pass the Company from their request context.
- B: everything installation-wide, documented exception. Cheapest, but leaves the ten account-code
  keys incorrect for any Company whose chart differs, and silently shares policies.
- C: fully per-Company including registry/edition. Over-reaches; edition licensing is per
  installation.

**Blast radius if A**: engine change + ~54 call sites passing `companyId` + one Company-DB
migration (`config_values` table) + a seeding story for existing values. Largest of the "small"
packages. Because it is an engine change, it must be a dedicated foundation task, not part of any
controller turn.

**Required proof**: real-PG A/B — same key, different values in A and B; a GL handler in A resolves
A's account code, in B resolves B's; changing A's value never changes B's after reload.

**Decision requested**: *A, B, or C? If A: which keys are "policy" (Company) vs "platform"
(I can produce the full classified key list for your sign-off).*

---

## Package 2 — Event Engine  *(highest blast radius; Area 21 cannot be VERIFIED without it)*

**Evidence** (Matrix §50, re-read against current source today)
- `EventBusService.publish(manager, …)` writes the outbox row through the caller's manager →
  for a Company-routed request, the row lands in the **Company's** `event_outbox`
  (`EventOutbox` is in the Company registry).
- `dispatchPending(batchSize, manager?)` reads the Company outbox only if given that manager, else
  the ambient outbox; **and** invokes `handler(row.payload)` — no manager, no `companyId`.
  Every subscriber is a singleton using its own ambient `this.dataSource`.
- 27 non-test `subscribe(` call sites. Affected: **every automatic GL posting**
  (`FinancialEventService` — one handler per finance topic), Fulfillment→Shipment handoff,
  product → price-list and 4 integrations topics, approval callbacks, commission topics.
- Net effect today for a Company-routed operation: dispatch with the ambient repo finds nothing →
  **the side effect never runs**; dispatch with the Company manager finds the row but runs the
  handler against the **ambient DB**. Neither is Company-correct. I have established this by reading
  the dispatcher and every subscriber — I have **not** yet executed an end-to-end test (proposed
  below, needs your go-ahead because it is a new test file).
- The retrofits so far use three different dispatch conventions (Matrix §50, "disclosed"):
  (i) `dispatchPending(undefined, manager)`, (ii) `if (!manager) dispatchPending()`, (iii) ambient.
  None is right; I changed none of them.
- Existing pattern that already does the right thing: `ApprovalExpiryScheduler` and
  `PreliminaryHoldExpiryScheduler` iterate ACTIVE Companies through
  `CompanyConnectionManagerService.listActiveCompanyIds()`.

**Options**
- **A (recommended): Company-aware dispatch.** Handler signature
  `(payload, ctx: { manager, companyId }) => Promise<void>`; `dispatchPending` passes the Company
  manager through; every subscriber threads `ctx.manager` (mechanical — their services are manager-
  capable after this program); in-request dispatch passes the Company manager; a **per-Company
  dispatcher** (scheduler pattern above) retries pending rows. The outbox stays in the same database
  and transaction as the business write — the transactional-outbox guarantee is preserved.
- B: Platform-side outbox with a `companyId` envelope; handlers resolve the Company DataSource.
  Breaks the transactional guarantee (outbox in a different database from the business write →
  dual-write window) — I recommend against it.
- C: keep as is, document. Leaves automatic GL posting non-functional/incorrect for every
  Company-routed operation. Not acceptable for closure.

**Open sub-decisions under A**: (1) classify the 27 subscribers into Company-level vs genuinely
Platform-level (I can produce the table); (2) multi-instance dispatcher locking (`SKIP LOCKED`);
(3) whether handler signature change is breaking-by-design (all 27 updated in one change) or
backward-compatible (`ctx` optional).

**Required proof (needed for Gate B regardless)**: real-PG — publish `deposit.verified` /
`collection.remitted` inside Company A; assert the GL journal exists in A and **nowhere else**.

**Decision requested**: *A / B / C, plus authorization to write the failing end-to-end proof test
now (test-only, no production code) so the ADR is based on an executed result, not a reading.*

---

## Package 1 — Approval Engine  *(largest: 13 controllers)*

**Evidence** (Matrix §2.2, §30, §36, §49; re-checked today)
- The Area 9 decision **already placed the Approval tables in each Company's own database**:
  `ApprovalRequest`, `ApprovalRequestType`, `ApprovalMatrixRule`, `ApprovalDecision` are in
  `CORE_COMPANY_ENTITIES`. `ApprovalExpiryScheduler`'s own header says `approval_requests` lives
  inside each Company's database and sweeps every active Company; `ApprovalEngineService.expire`
  already takes a `DataSource`. So the *data placement* question in §2.2 has effectively been
  answered by Area 9; what is unfinished is the **service**: `submit`, `decide`, `withdraw`,
  `escalate`, `getRequest`, `listRequests`, `registerRequestType`, `upsertMatrixRule`,
  `listMatrixRules`, `listRequestTypes` all use the ambient `this.dataSource` (only `expire`
  accepts a DataSource).
- 26 non-test files import `ApprovalEngineService`; call-graph verified (§49) that 13 controllers
  route into it: `supplier`, `ap`, `ar`, `cash-bank`, `inventory-accounting`, `fixed-asset`,
  `attendance`, `commission`, `hr`, `payroll`, `rfq`, `target`, and `accounting`
  (`FiscalPeriodService.submitPeriodClose/Reopen/YearClose`). `approval.controller.ts` itself is the
  fifth CTO-excluded special surface.
- **Registration problem**: request types and matrix rules are registered in `onModuleInit` of
  consumers (e.g. `FiscalPeriodService`) — **once per installation, ambiently**. Under Model B each
  Company database needs those rows; today a new Company's `approval_request_types` is empty unless
  something seeds it.
- **Callbacks**: `approval.request.approved/rejected` are Event Engine topics with subscribers in the
  consuming domains → package 2 must be decided with, or before, this one.
- **TTL**: `core.approval.request_ttl_hours` comes from the installation-wide Config cache →
  package 4.
- `FiscalPeriodService` is the only approval consumer I have already touched (read-only
  `assertOpenForPosting` path, for general-ledger); its approval paths are untouched.

**Options**
- **A (recommended): Company-scoped — ratify Area 9.** `ApprovalEngineService` gains `manager?` /
  `dataSource` threading (additive); request-type/matrix registration becomes per-Company
  (seed at provisioning + ensure-on-first-use); `approval.controller.ts` retrofitted first as the
  proving consumer; then the 13 controllers one at a time. No per-`resourceType` ownership lookup is
  needed — request and resource live in the same Company database, so the original §2.2(a)
  complexity disappears.
- B: installation-wide by design. Contradicts the Area 9 data placement already in the registry;
  would require moving the four tables back, a per-`resourceType` ownership check on every decide,
  and lets one approver population span Companies. I recommend against it.

**Work if A** (separate foundation task before any controller): service threading (~10 methods),
per-Company registration/seeding, scheduler already per-Company, callbacks via package 2, TTL via
package 4, existing ambient `approval_*` rows (backfill or accept as legacy — needs your policy).

**Required proof**: real-PG — maker in A submits; an approver in B cannot list/decide it (A→B
DENY); request types/matrix differ per Company; expiry sweep expires only the owning Company's
requests; an approved request in A fires its callback inside A only (needs package 2).

**Decision requested**: *Company-scoped (A) or installation-wide (B)? Seeding policy for request
types/matrix per Company? Backfill policy for existing ambient rows? Authorize the foundation
task after packages 2 and 4 are decided?*

---

## What I am NOT doing until you rule

No change to Approval, Event, Config, Tax, `InvoiceService`, `AuthorizationService`/`sales_rep`.
No controller code. The one optional evidence item I would like authorization for is the
**executable `deposit.verified` → GL-in-Company-A proof test (package 2)**, because it converts the
single largest risk in this program from "established by reading" to "established by execution".
