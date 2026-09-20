# ADR-071 — Commission & Target Phase 1: Implementation Contract

**Status:** Contract Design — awaiting CTO review/approval as one package
with `ADR-070`/`ADR-072`, per the "CTO DIRECTIVE — Begin Implementation
Contracts" instruction (2026-09-20). Built strictly from `ADR-066`
(Commission/Target backlog) and `ADR-068` (Commission & Target Policy,
RATIFIED) — **no policy is introduced, reopened, or reinterpreted here.**
No code, schema, migration, API, frontend, or seed change is authorized by
this document. Production remains HOLD.

## 1. Purpose / Scope

Converts `ADR-068`'s five ratified decisions (§1–§5) plus its binding
specifications (§A–§H) into a buildable design. **In scope:** Target as an
independent bounded context; the Commission Resolution Engine (Customer →
Customer Group → Sales Rep); per-policy calculation basis; marginal-tier
target-driven commission; the immutable Commission Snapshot; FA-01
approval; the Payroll consumption boundary. **Out of scope:** anything
`ADR-068` did not itself ratify — in particular, no commission rate, tier
threshold, or precedence rule beyond what §2/§A already fixed is invented
here.

## 2. Bounded Context

Two new, separate module codes — neither is a promotion from
`RESERVED_MODULE_CODES` (that list is `pos, projects, assets, operations,
payroll` only; `commission`/`targets` are genuinely new additions to
`ModuleCode`, the same situation `attendance` was in per `ADR-065 §2`):

- **`commission`** — `domains/commission/`, own manifest, own
  `@RequireModule('commission')` gate, `commission.*` permission
  namespace.
- **`targets`** — `domains/targets/`, own manifest, own entities/service.
  **Structural decision (not a policy reopening):** for Phase 1 licensing
  simplicity, `targets` is entitlement-gated under the `commission` module
  (its only Phase 1 consumer) rather than sold as an independent SKU —
  the code/data ownership separation `ADR-068 §D` ratified is fully
  preserved (`domains/targets/` owns its own tables, `commission` never
  writes them), only the *entitlement flag* is shared for now. This is
  revisitable without a rebuild if a future need (a standalone dashboard
  consumer, a separate SKU) requires promoting `targets` to its own gate.

## 3. Dependencies

| Dependency | Direction | Mechanism |
|---|---|---|
| HR (`Employee`) | Commission → HR (read-only) | Direct module import — resolving "which `Employee` earns this" (§9) |
| CRM (`CustomerAssignment`, `Customer`) | Commission → CRM (read-only) | Direct module import — reading `salesRepUserId`, `customerId` |
| Sales/Finance (Invoice, Collection events) | Commission → Sales/Finance (event, read-only) | Subscribes to the **existing** `finance.invoice.posted` and `collection.recorded`/`collection.remitted` topics (`financial-event.service.ts:24-32`'s own `DOMAIN_OF_TOPIC` map) via `EventBusService` — the same topics F03 itself already consumes, not a new event Commission invents. |
| Targets (`ADR-068 §D`) | Commission → Targets (read-only) | Direct module import of a read-only query for an Approved Target — `depends_on: ['targets']` |
| Payroll (`ADR-070`) | Payroll → Commission (read-only) | Commission is depended *on*, never the reverse — no import back into `payroll` |
| FA-01 / `ProcessEngineService` / `AuditService` / `NumberingService` | Commission & Targets → Foundation | Reused exactly as every other domain — no new mechanism |

No other `domains/*` import exists in either direction beyond the above —
`commission`/`targets` do not import `attendance`, `payroll`, or
`manufacturing`, and nothing in those domains imports `commission`/
`targets` either.

**Blocking cross-domain dependency, not resolved by this document:**
`ADR-068 §1` ratifies **Customer Group** as an in-scope Phase 1 policy
scope. **Verified repository fact:** CRM's own `Customer` entity has no
structured customer-group concept — `customer.entity.ts:47` states
explicitly, in its own maintainer's words, *"Daii has no structured
customer-group entity yet (`classification` is free text)."*
`Customer.classification` is a free-text field, not a foreign key to
anything. **This contract does not invent a `CustomerGroup` entity** —
doing so would mean Commission building CRM's own data model to force-fit
its design, exactly what the CTO directive's governance rules prohibit.
The Customer-Group tier of the Resolution Engine (§9) is therefore
specified architecturally (a `scope = 'customer_group'` policy row with a
`scopeRefId`) but **cannot resolve any real policy until CRM provides a
structured Customer Group concept** — recorded as an open dependency in
§21, escalated rather than guessed.

## 4. Domain Model — Targets (`domains/targets/infrastructure/`)

- **Target** — `id, employeeId, periodStart, periodEnd, targetValue, teamId (nullable — OrgUnit reference, contextual metadata only per ADR-068 §D, never a standalone team-target engine), status (driven by ProcessEngineService, §5), approvalRequestId (nullable, FA-01), createdByUserId, approvedAt.` Matches `ADR-068 §E`'s closed field list (`Start Date, End Date, Status, Employee, Target Value, Approval State`) exactly — `periodStart`/`periodEnd` are the Start/End Date pair.
- **Non-overlap enforcement** (`ADR-068 §E`'s ratified requirement — mechanism is Implementation detail): a Postgres `EXCLUDE USING gist (employeeId WITH =, daterange(periodStart, periodEnd, '[]') WITH &&) WHERE (status = 'approved')` constraint — a genuinely new pattern for this codebase (no prior exclusion-constraint use found), the correct native mechanism for "no two approved ranges for the same key may overlap," stronger than the partial-unique-index pattern `AttendanceEmployeeMapping`/`PayrollCompensation` use (which only prevents more than one *currently active* row, not overlapping *date ranges*).

**Explicitly deferred dimensions (`ADR-068 §D`, not built, not stubbed):**
Region, Customer Group Target, Product Category Target, Campaign Target,
Territory Target, any multi-dimensional matrix.

## 5. Domain Model — Commission (`domains/commission/infrastructure/`)

- **CommissionPolicy** — `id, scope ('sales_rep'|'customer'|'customer_group'), scopeRefId (employeeId | customerId | customerGroupId depending on scope), basis ('gross_sales'|'net_sales'|'collected_amount'), rateModel ('flat'|'target_tiered'), flatRate (nullable — used only when rateModel='flat'), effectiveFrom, effectiveTo (nullable), status ('active'|'superseded'), createdByUserId, createdAt.` Effective-dated, new row per change, never mutated — same discipline `CustomerAssignment` already established, now formally required by `ADR-068`'s preserved reuse direction.
- **CommissionTier** — `id, policyId, tierOrder, fromPercent, toPercent (nullable — open-ended top tier), rate.` Populated only when the owning policy's `rateModel = 'target_tiered'`.
- **CommissionApprovalBatch** — mirrors `AttendanceApprovalBatch` exactly (`ADR-069 §1`'s own proven shape): `id, periodStart, periodEnd, status (ProcessEngineService, §5), approvalRequestId (FA-01), createdByUserId, decidedAt.`
- **CommissionResult** — the immutable snapshot, closing `ADR-068 §F`'s field list verbatim: `id, employeeId (resolved Sales Rep, §9), customerId, customerGroupId (nullable), sourceTransactionRefs (jsonb — invoice/collection ids), resolvedPolicyId (historical reference only — never re-read live), policyScope, calculationBasis, targetPeriodId (nullable reference to Target), targetSnapshot (jsonb — a copy of the Target's value/achievement at calculation time, never a live reference), applicableTier (jsonb, nullable), rate, calculationInputs (jsonb), calculatedAmount, calculationTimestamp, batchId (nullable, FK to CommissionApprovalBatch).` Immutable once written — no field is ever updated after insert.
- **CommissionAdjustment** — mirrors `ADR-070 §4`'s `PayrollAdjustment` exactly: `id, originalCommissionResultId, kind ('adjustment'|'correction'|'recalculation'), reason, amountDelta, createdByUserId, approvalRequestId (nullable, FA-01 where required).`

All additive, new tables. No existing CRM, HR, or Sales table is altered.

## 6. State Machines

Both driven by `ProcessEngineService` (`ADR-008`), not bespoke status
logic:

```
Target:                draft --submit--> pending_approval --approve--> approved
                                                             --reject--> rejected

CommissionApprovalBatch: draft --submit--> submitted --approve--> approved
                                                       --reject--> rejected
```

`CommissionResult` itself has no independent state machine — it is
calculated directly in its final, immutable form and only gains an
approval status via its `batchId`'s `CommissionApprovalBatch` state
(mirrors how `AttendanceDay` gains approval status via its `batchId`,
`ADR-065 §5`). `approved` transitions on both fire from the same FA-01
`approval.request.approved` event-handler shape every prior phase uses —
never a direct caller-invoked transition.

## 7. Invariants

- A `CommissionPolicy`'s `scope = 'sales_rep'` row's `scopeRefId` must be
  an `Employee.id`, never a raw `User.id` — the resolution step (§9)
  performs the `User → Employee` reverse lookup itself; policies are
  never stored keyed by `User`.
- A `CommissionResult` is **never** created for a `CustomerAssignment.
  salesRepUserId` that has no linked `Employee` (`Employee.userId IS
  NULL` for that user) — resolution fails closed (§10 Failure Modes),
  never guesses which Employee should be credited.
- `CommissionTier` rows for one policy must not overlap
  (`fromPercent`/`toPercent` ranges) and must be contiguous from `0` —
  enforced at write time, not by the resolution engine silently picking
  one.
- A `CommissionResult` field, once written, is never updated — only a new
  `CommissionAdjustment` row may reference it (`ADR-068 §H`).
- `Target` non-overlap (§4) is enforced at the database level, not only in
  application code.
- Commission basis and rate on a `CommissionResult` are always the values
  *resolved at calculation time* (`targetSnapshot`, `applicableTier`,
  `rate` are all copies) — a later `CommissionPolicy`/`Target` change can
  never alter an already-calculated `CommissionResult` (`ADR-068 §7`).

## 8. Service Boundaries

`TargetService` owns `Target` CRUD and FA-01 submission — it has no
knowledge of Commission. `CommissionResolutionService` owns §9's
resolution algorithm only (a pure query, no side effects). `CommissionService`
owns `CommissionPolicy`/`CommissionTier` CRUD, the calculation pipeline
(subscribes to Sales/Finance events, calls `CommissionResolutionService`,
reads an Approved `Target` via `TargetService`, writes `CommissionResult`),
`CommissionApprovalBatch` submission, and the adjustment flow. Payroll
(`ADR-070`) calls into `CommissionService` for one thing only: reading
Approved `CommissionResult`s for an employee/period — it never touches
`CommissionPolicy`, `CommissionTier`, or `Target`.

## 9. Events / Integration Contracts — Resolution Algorithm

**Inbound trigger:** Commission subscribes to `finance.invoice.posted`
(for `gross_sales`/`net_sales` basis) and `collection.recorded`/
`collection.remitted` (for `collected_amount` basis) — the exact same
topics `FinancialEventService` itself already subscribes to
(`financial-event.service.ts:81-85`), via the same `EventBusService`, not
a new event Commission invents.

**Sales Rep resolution** (`ADR-068 §G`, reaffirmed, not reopened):

```
CustomerAssignment.salesRepUserId (User)
        │
        ▼
Employee.findOne({ where: { userId } })   ← reverse lookup, new additive HR read method
        │
        ├─ found   → this Employee is the commission-eligible Sales Rep
        └─ not found → resolution fails closed (§10) — no commission calculated,
                        surfaced for admin remediation (link the User to an Employee)
```

**Policy resolution** (`ADR-068 §A`, ratified precedence, unchanged):

```
1. Active, effective-dated CommissionPolicy where scope='customer' and scopeRefId=customerId
   → found? resolved. stop.
2. Active, effective-dated CommissionPolicy where scope='customer_group' and scopeRefId=<customer's group>
   → BLOCKED today (§3) — no structured Customer Group exists to resolve against.
   → found (once §3's dependency closes)? resolved. stop.
3. Active, effective-dated CommissionPolicy where scope='sales_rep' and scopeRefId=<resolved Employee.id>
   → found? resolved. stop.
4. Nothing resolved → no commission for this transaction, surfaced, not silently zeroed
   (distinguishable from "resolved a policy with a zero rate").
```

**Calculation** (`ADR-068 §3`, §B/§C): apply the resolved policy's
`basis` to the transaction amount; if `rateModel = 'target_tiered'`, read
the Employee's Approved `Target` for the transaction's period from
`TargetService`, compute achievement percentage, apply `ADR-068 §C`'s
marginal/per-tier method (each `CommissionTier` band computed
independently and summed — never the top reached tier's rate applied to
the whole amount). Write one `CommissionResult` with every §5 snapshot
field populated.

**Outbound — Payroll (`ADR-070 §9`):** a read-only query,
`listApprovedCommissionResults(employeeId, periodStart, periodEnd)` — returns only
`CommissionResult` rows whose `batchId`'s `CommissionApprovalBatch.status
= 'approved'`. This is the exact method `ADR-070 §9` names as "Commission's
own deliverable."

## 10. Authorization / SoD

Candidate `commission.*`/`targets.*` permission nodes (naming only):
`commission.policy.{view,create,edit}`, `commission.result.view`,
`commission.batch.{create,approve}` (FA-01 checker side), `commission.
adjustment.create`; `targets.target.{view,create}`, `targets.target.
approve` (FA-01 checker side). FA-01's own SoD enforcement
(`approval-engine.service.ts:231-234`) covers both `approve` actions
automatically — zero new mechanism, per `ADR-068`'s preserved reuse
direction.

**Failure mode, not an authorization gap:** an unresolvable Sales Rep
(§9's fail-closed case) is not a permission failure — it surfaces as a
data-remediation task (link the `User` to an `Employee` via HR's existing
manual-link flow, `ADR-059` D2) for whoever holds `hr.employee.edit`, not
a Commission-side workaround.

## 11. Audit

Every `CommissionPolicy`/`Target` write, every calculation run, every
batch submit/approve/reject, and every `CommissionAdjustment` records via
`AuditService.record`. `CommissionResult`'s own immutable snapshot (§5) is
itself a form of built-in audit evidence beyond the generic audit log —
the same "evidence, not a working copy" discipline `ADR-062 §3` and
`ADR-067 §M` already established, now used a third time.

## 12. Idempotency

- **Invariant, corrected per CTO review (2026-09-20) — not a schema:**
  every Commission-triggering source event must carry a deterministic
  identity that guarantees idempotent processing across event redelivery.
  This identity must at minimum distinguish between the four kinds of
  event that can trigger Commission processing, since each has a
  different natural source-of-truth for what "the same event" means:
  - an **Invoice** event (identity keyed to the invoice),
  - a **Collection** event (identity keyed to the collection/receipt, not
    the invoice it applies to — a single invoice can have several
    collections, each its own distinct trigger),
  - a **Correction/Adjustment** (identity keyed to the `CommissionAdjustment`
    itself, never conflated with the original `CommissionResult`'s own
    identity — §18's immutability already requires these to be separate
    records, so their idempotency keys must be separate too), and
  - a **Recalculation** (identity keyed to the specific recalculation run,
    never silently reusing the original calculation's key — a
    recalculation is a deliberate, distinct, auditable event, not a retry
    of the original).
  A redelivery of any one of these four must be a safe no-op; two
  *different* ones sharing a transaction reference (e.g. an Invoice and a
  later Collection against it) must **not** collide as if they were the
  same trigger. The exact key/constraint shape that satisfies this
  invariant (a composite unique index, a generated hash, or another
  mechanism) is Implementation detail, not fixed by this contract — only
  the invariant itself is binding, per instruction.
- `Target`/`CommissionApprovalBatch` numbering via `NumberingService`,
  same pattern as every other numbered document.
- FA-01 submission failure recovery follows the exact pattern `commit
  d76e22e` already established for Attendance's approval batches (stamp
  only after successful submit, or reverse the stamp on failure) — not
  reinvented, reused as a known-correct shape.

## 13. Transaction Boundaries

- `Target` create/approve: one transaction per state transition
  (`ProcessEngineService`'s own row-locked transition).
- Commission calculation: reading the triggering event, resolving policy
  (§9), reading the Target (if tiered), and writing the `CommissionResult`
  row happen in one transaction — a partial calculation is never
  persisted.
- Batch submit/approve: mirrors `ADR-069`'s own proven Attendance-batch
  transaction shape exactly (stamp `batchId` only as part of the same
  transaction as a successful FA-01 submit).

## 14. Failure Modes

- **Sales Rep unresolvable** (§9): no `CommissionResult` is created; the
  triggering transaction is logged as "commission unresolved" for admin
  review — never defaulted to a zero-value result (which would look
  identical to "resolved, zero rate" and hide the real gap).
- **No policy resolves** (§9 step 4): same treatment — surfaced, not
  silently skipped or zeroed.
- **Target missing for a `target_tiered` policy**: calculation cannot
  proceed for that transaction; surfaced the same way, never falls back to
  a flat/default rate not itself configured.
- **FA-01 submit fails mid-batch**: recovery mirrors commit `d76e22e`'s
  proven pattern (§12) — no orphaned `batchId` stamp survives a failed
  submit.

## 15. Retry / Reconciliation

Redelivery safety inherited from the Transactional Outbox
(`EventBusService`) plus §12's dedup key — no new mechanism. A
reconciliation report (sum of a period's Approved `CommissionResult`s vs.
what Payroll actually consumed) is Implementation detail, following the
same shape as every other subledger reconciliation in this codebase.

## 16. Financial Integration

**None, directly.** Commission does not post to GL — it produces an
Approved `CommissionResult` that Payroll (`ADR-070 §9`, §16) consumes and
posts, via Payroll's own Financial Event, exactly as `ADR-068 §8`/`ADR-070
§J` already established. No `ControlFunction`, no journal, no
`resolveControlAccount` call exists anywhere in `domains/commission` or
`domains/targets`.

## 17. Period Control

`CommissionApprovalBatch`'s `periodStart`/`periodEnd` are Commission's own
concept, independent of Payroll's `PayrollPeriod` and any Financial
Period — Commission never posts, so `assertOpenForPosting` is never
invoked here; period alignment with Payroll's own period is Payroll's
concern when it reads Approved `CommissionResult`s (`ADR-070 §9`), not
Commission's.

## 18. Correction / Immutability

Identical shape to `ADR-070 §18`: post-approval, no `CommissionResult`
field is ever updated. A correction is always a new `CommissionAdjustment`
row, typed `adjustment`/`correction`/`recalculation`, each fully audited,
gated by FA-01 where the correction policy requires it. Historical
`CommissionResult` rows remain permanently queryable exactly as
calculated.

## 19. E2E Acceptance Criteria

1. A Customer-level `CommissionPolicy` resolves ahead of a Sales-Rep-level
   one for the same transaction — proving §9's precedence order live.
2. With no Customer or Customer-Group policy active, the Sales-Rep default
   resolves.
3. A `target_tiered` policy at 80% achievement against illustrative
   `0–50/50–70/70–90/90+` test tiers produces exactly the marginal sum
   `ADR-068 §C`'s worked example specifies — not the top-tier-on-everything
   result.
4. A `CommissionResult`'s snapshot fields remain unchanged after the
   originating `CommissionPolicy` is later superseded by a new effective-
   dated row — proving historical integrity (`ADR-068 §7`) live.
5. A `CustomerAssignment.salesRepUserId` with no linked `Employee`
   produces a surfaced, unresolved-commission outcome — never a silently
   wrong or zeroed result.
6. Two `Target`s for the same employee with overlapping periods are
   rejected by the database constraint, not just application code.
7. FA-01 SoD is proven live on both `Target` and `CommissionApprovalBatch`
   approval — the maker cannot also approve.
8. Payroll's read of Approved `CommissionResult`s never returns a
   `pending_approval`/`rejected`-batch result.
9. Unauthorized users are blocked from every sensitive action, each behind
   its own permission node.
10. Full regression, clean build, live-database verification.

## 20. Non-Goals

- No commission rate, tier threshold, or precedence rule beyond what
  `ADR-068` itself ratified.
- No `CustomerGroup` entity built inside Commission or Targets (§3) — that
  is CRM's own domain decision, not this contract's to make.
- No Region, Product Category, Campaign, or Territory Target dimension
  (`ADR-068 §D`, deferred).
- No GL posting from Commission (§16) — Payroll's exclusive responsibility.
- No modification to HR, CRM, or Sales/Finance domains.

## 21. §16 Escalations / Open Dependencies

- **Customer Group has no structured data source** (§3) — the single
  largest open dependency in this contract. Until CRM provides one, the
  Customer-Group tier of §9's resolution chain is architecturally present
  but functionally inert. Not resolved here; not invented here.
- **Initial `CommissionPolicy` rows, rates, and tier thresholds** are
  business configuration, not decided by this document (`ADR-068 §C`'s own
  explicit non-authoritative-example rule) — Phase 1 ships with zero
  seeded policies; nothing resolves until an authorized user configures
  one.
- **Commission calculation dedup key exact shape** (§12) — Implementation
  detail.
- **`Net Sales` basis's precise composition** (returns/discounts/tax
  treatment, `ADR-068 §3`... actually per `ADR-067 §B`'s parallel, this
  detail belongs to whichever ADR ratified it) — **not yet defined by any
  ratified document**; a `basis = 'net_sales'` policy cannot be
  implemented correctly until this is supplied. Flat/Gross/Collected
  bases are unambiguous and buildable today; Net Sales is not.

## 22. Implementation Sequence (proposed, not authorized)

1. `targets` module + `Target` entity + non-overlap constraint + FA-01
   wiring.
2. `commission` module + `CommissionPolicy`/`CommissionTier` + the HR
   reverse-lookup read method.
3. Resolution Engine (§9) — buildable now for `sales_rep`/`customer`
   scopes; `customer_group` scope wired but inert pending §21's CRM
   dependency.
4. Calculation pipeline (event subscription → resolve → snapshot →
   `CommissionResult`).
5. `CommissionApprovalBatch` + FA-01 (mirrors Attendance's proven shape).
6. Payroll-facing read contract (`ADR-070 §9`).
7. Adjustment flow.
8. Frontend.

Each stage tested before the next begins. Production remains HOLD.
