# ADR-072 — Integrated Payroll + Commission + Attendance + GL: E2E Contract

**Status:** Contract Design — awaiting CTO review/approval as one package
with `ADR-070`/`ADR-071`, per the "CTO DIRECTIVE — Begin Implementation
Contracts" instruction (2026-09-20). This is not a summary of the other
two contracts — it specifies the integration surface *between* them: data
ownership, event contracts, transaction/idempotency boundaries, and the
cross-context invariants neither `ADR-070` nor `ADR-071` can define alone.
Built strictly from `ADR-064`/`ADR-066`/`ADR-067`/`ADR-068`/`ADR-069`/
`ADR-070`/`ADR-071` — **no new policy is introduced.** No code, schema,
migration, API, frontend, or seed change is authorized by this document.
Production remains HOLD.

## 1. Purpose / Scope

Proves, on paper, that the two chains the CTO specified are internally
consistent end to end:

```
Employee → Sales Rep → Customer → Sale → Invoice/Collection →
Commission Policy → Commission Result → Approval → Payroll → GL

Employee → Attendance → Day Type → Payroll Pay Impact
```

**In scope:** cross-context ownership, the full event/read-contract chain,
transaction and idempotency boundaries at each hop, the timing/cutoff rule
between an in-flight Commission Adjustment and an already-posted
`PayrollRun`, and consolidated E2E acceptance criteria spanning both
chains. **Out of scope:** re-deciding anything `ADR-067`/`ADR-068` already
ratified, or re-specifying anything `ADR-070`/`ADR-071` already
specified within their own bounded context — this document does not
restate their internals, only how they meet.

## 2. Bounded Context

Not a new bounded context — this document is the integration map across
nine already-scoped contexts: `hr`, `attendance`, `crm` (Sales Rep/
Customer), `finance`/`accounting` (Invoice/Collection/GL), `commission`,
`targets`, `payroll`, `treasury`. No code lives "in" ADR-072.

## 3. Dependencies

Union of `ADR-070 §3` and `ADR-071 §3`, unchanged. The one dependency this
document adds that neither individual contract needed alone: **Payroll
depends on Commission's read contract (`ADR-071 §9`'s
`listApprovedCommissionResults`) at a specific point in its own lifecycle (§9 below)** —
both contracts named this boundary; this document fixes exactly when it
is called.

## 4. Domain Model

None new. This document references `ADR-070 §4` and `ADR-071 §4`/§5's
entities only by name.

## 5. State Machines — cross-context interlock

Three independent `ProcessEngineService` instances never share a
transaction, only events:

```
Target:                  draft → pending_approval → approved
CommissionApprovalBatch: draft → submitted → approved
PayrollRun:               draft → calculated → reviewed → approved → posted
```

`PayrollRun.calculate` (§9) reads whatever `CommissionResult`s are
`approved` **at the moment it runs** — it does not wait for, subscribe to,
or block on Commission's own approval timing. This is the single most
important cross-context timing rule in this document (§14, §18 elaborate
the consequence).

## 6. Invariants (cross-context)

- A `PayrollRunLine.commissionAmount` is only ever populated from a
  `CommissionResult` whose batch was `approved` **before** the
  `PayrollRun`'s `calculate` step ran (§5). A `CommissionResult` approved
  *after* a `PayrollRun` already calculated is **not** retroactively
  pulled into that run (§18).
- No `PayrollRun` may reach `posted` while any `CommissionResult` it
  consumed has since been reversed by a `CommissionAdjustment` dated
  before the `PayrollRun`'s own `approved` transition — this is a
  point-in-time consistency check, not a live re-validation (§14).
- `AttendanceDay` facts consumed by a `PayrollRun` are always read via
  `ADR-070 §9`'s `listApprovedDaysByBatch` — never raw `AttendanceRawRecord`
  data, preserving `ADR-062 §8`'s facts-only boundary across this entire
  chain.
- Every GL journal this chain ever produces originates from exactly one
  domain's Financial Event (`payroll.run.posted`, per `ADR-070 §16`) —
  Commission never posts (`ADR-071 §16`), Attendance never posts
  (`ADR-062 §8`), preserving one single point of GL entry for this whole
  chain.

## 7. Service Boundaries

No service in this chain calls another domain's *write* path directly.
Every hop is either a read-only query (Payroll ← Attendance, Payroll ←
Commission, Commission ← HR/CRM/Targets) or a published event consumed by
a registered handler (Sales/Finance → Commission's trigger, Payroll →
Accounting's Financial Event, §9). No new "god service" spans more than
one bounded context.

## 8. Data Ownership (full chain)

| Data | Owning domain | Who else reads it |
|---|---|---|
| `Employee` | HR | Attendance, Commission, Payroll (all read-only) |
| `CustomerAssignment`, `Customer` | CRM | Commission (read-only) |
| Sales Order / Invoice / Collection | Sales / Finance | Commission (via event, read-only) |
| `AttendanceDay`, approval batches | Attendance | Payroll (via `ADR-070 §9`'s read method) |
| `Target` | Targets | Commission (read-only) |
| `CommissionPolicy`, `CommissionResult`, `CommissionApprovalBatch` | Commission | Payroll (read-only, approved results only) |
| `PayrollPeriod`, `PayrollCompensation`, `PayrollRun`, `PayrollRunLine`, `PayrollDeductionLine`, `PayrollAttendanceDayClassification` | Payroll | No other domain reads these directly |
| `GLAccount`, `JournalEntry` | Accounting | Nothing upstream reads GL back into this chain — the chain is write-only into Accounting |
| `TreasuryAccount`, disbursement transactions | Treasury | Payroll calls the contract method only (`ADR-070 §3`) |

No table in this list is owned by more than one domain. No domain in this
chain writes another domain's table directly, anywhere.

## 9. Events / Integration Contracts — the full chain

```
HR Employee
      │ (read, employeeId)
      ▼
CustomerAssignment.salesRepUserId → Employee (reverse lookup, ADR-071 §9)
      │
      ▼
Customer ──► Sales Order ──► Invoice.posted / Collection.recorded|remitted
                                   │ (existing Financial Event topics, ADR-071 §9)
                                   ▼
                        Commission Resolution Engine (ADR-071 §9)
                                   │
                                   ▼
                     Immutable CommissionResult (ADR-071 §5)
                                   │
                          CommissionApprovalBatch → FA-01 → approved
                                   │
                                   ▼ (read-only, ADR-071 §9's listApprovedCommissionResults)
                          ┌────────────────────────┐
Attendance approved facts │                        │
  (ADR-069, "period.      │      PayrollRun         │
   approved" event         │      .calculate()       │
   + ADR-070 §9's new      │                        │
   listApprovedDaysByBatch)└────────────────────────┘
                                   │
                    Draft → Calculated → Reviewed → Approved (FA-01)
                                   │
                                   ▼
                     payroll.run.posted (new Financial Event, ADR-070 §16)
                                   │
                                   ▼
              Dr Salaries & Wages Expense / Cr Wages Payable
                                   │
                                   ▼
              Disbursement: Dr Wages Payable / Cr Treasury (ADR-070 §9)
```

Every arrow above is either a read-only query or an already-existing/
newly-specified event — none is a new synchronous cross-domain write
call.

## 10. Authorization / SoD (cross-context)

No single actor can, alone, carry a transaction from Sale to GL: a Sales
user creates the Invoice; a Commission approver (distinct from whoever
triggered the calculation) approves the `CommissionApprovalBatch`; a
Payroll reviewer and a separate Payroll approver carry the `PayrollRun`
through `reviewed → approved`; disbursement is a distinct Treasury action.
FA-01's maker≠checker rule applies independently at each of these three
approval points (Commission batch, Payroll run) — this document does not
add a fourth, cross-context approval gate; it relies on each domain's own
already-specified gate.

## 11. Audit

No new audit mechanism. The full chain is reconstructable after the fact
by following: `AuditService` records at every write in every domain, plus
`CommissionResult`'s and `PayrollRunLine`'s own immutable snapshots
(`ADR-071 §5`, `ADR-070 §4`) — between the generic audit log and the two
domain-specific snapshots, the entire Sale→GL and Attendance→Payroll paths
are traceable without a new cross-domain audit table.

## 12. Idempotency (end to end)

Each hop's idempotency is independently guaranteed by its own owning
domain (§9's diagram) — this document does not add a chain-level
idempotency key. The end-to-end guarantee is compositional: if every hop
is individually idempotent (Commission's calculation dedup, `ADR-071
§12`; F03's `idempotencyKey`, `ADR-070 §12`), redelivering any single
event in the chain cannot produce a duplicate outcome anywhere downstream,
because each domain independently refuses to reprocess what it has
already processed.

## 13. Transaction Boundaries

**There is no cross-domain transaction anywhere in this chain, by
design.** Each domain's own transaction boundary (`ADR-070 §13`, `ADR-071
§13`) is the unit of atomicity; consistency *between* domains is achieved
through the event/read-contract boundary (§9), not a distributed
transaction. This is deliberate and matches every other cross-domain flow
already proven in this codebase (e.g. Sales → Accounting via Financial
Event, never a shared transaction).

## 14. Failure Modes (cross-context)

- **A `CommissionResult` is adjusted (`CommissionAdjustment`) after the
  `PayrollRun` that consumed its original value has already posted:** the
  posted `PayrollRun` is **not** reopened or retroactively corrected by
  this event. The adjustment amount flows into a **future** `PayrollRun`
  as its own `PayrollAdjustment`/earning line — the same "corrections are
  new records, never retroactive overwrites" discipline both `ADR-070
  §18` and `ADR-071 §18` already independently established, now stated as
  a cross-context rule: **a downstream domain's immutability is never
  broken by an upstream domain's later correction.**
- **A `CommissionApprovalBatch` approves after a `PayrollRun` already
  calculated (but before it posted):** the newly-approved results are
  **not** pulled into the already-calculating run — `ADR-070 §12`'s
  `calculate` semantics only ever read what is approved *at the moment it
  runs* (§5, §6). They become eligible for the *next* `PayrollRun`.
- **`AttendanceDay` classification cannot resolve** (`unclassified`, per
  `ADR-070 §6`'s fail-safe): that employee's `PayrollRunLine` proceeds
  with `payImpact='none'` for that day — the run is not blocked entirely
  by one unresolvable day, only that day's own deduction is withheld.
- **Sales Rep unresolvable** (`ADR-071 §14`): no `CommissionResult`, not a
  chain-halting failure — that transaction's commission is simply absent
  until the underlying `User`↔`Employee` link is fixed.

## 15. Retry / Reconciliation

No new chain-level reconciliation job. Each domain's own reconciliation
(`ADR-070 §15`, `ADR-071 §15`) is sufficient because ownership never
overlaps (§8) — there is nothing for a chain-level reconciliation to
detect that a domain-level one would miss, since no data is duplicated
across domains, only referenced by immutable snapshot.

## 16. Financial Integration

Exactly one GL entry point for this entire chain: Payroll's
`payroll.run.posted` Financial Event (`ADR-070 §16`). Commission,
Targets, and Attendance never post. This is the chain's single most
important financial-control property: **however complex the upstream
resolution (Commission's Rule Resolution Engine, Attendance's day-type
determination), the GL only ever sees one balanced journal per
`PayrollRun`, sourced through the one already-proven `resolveControlAccount`
mechanism.**

## 17. Period Control

Three independent period concepts exist in this chain and are
**deliberately not merged into one**: `CommissionApprovalBatch`'s period
(Commission's own), `PayrollPeriod` (Payroll's own, monthly per `ADR-067
§A`), and the Financial Period (Accounting's own, enforced automatically
via `assertOpenForPosting` at the moment Payroll posts, `ADR-070 §17`).
Alignment between a `PayrollPeriod` and the `CommissionApprovalBatch`
periods it draws from is a **Payroll-side read-time concern** (`ADR-070
§9`'s query is parameterized by the `PayrollRun`'s own period) — Commission
does not need to know Payroll's period shape, only to expose approved
results queryable by date range.

## 18. Correction / Immutability (cross-context rule)

**The chain-wide rule, stated once here because both `ADR-070 §18` and
`ADR-071 §18` independently need it stated consistently:** every domain
in this chain produces immutable, snapshot-based results
(`AttendanceDay` via its approval batch, `CommissionResult`, `PayrollRunLine`)
that are never retroactively altered by an upstream correction. A
correction always creates a **new** record in the domain where the
correction originates, and — if it has downstream financial consequence —
flows forward into the **next** period's processing in the consuming
domain, never backward into an already-approved/posted one. This is what
makes the chain auditable end to end: at any point in the past, replaying
what each domain knew *at that time* reproduces exactly what was
calculated, regardless of what has been corrected since.

## 19. E2E Acceptance Criteria

**Chain A — Sales → Commission → Payroll → GL:**
1. An `Employee` linked to a `User` who is a `CustomerAssignment`'s
   `salesRepUserId`, selling to a `Customer` with an active Customer-level
   `CommissionPolicy`, produces one `CommissionResult` correctly reflecting
   that policy (not the Sales Rep default) once its `Invoice`/`Collection`
   posts.
2. That `CommissionResult`, once its batch is FA-01-approved, is readable
   by Payroll's `listApprovedCommissionResults` and appears on the
   corresponding employee's `PayrollRunLine.commissionAmount`.
3. The same `PayrollRun`, once `posted`, produces exactly one balanced GL
   journal crediting `wages_payable` — traceable back through
   `PayrollRunLine` → `CommissionResult` → the originating `Invoice`/
   `Collection`.

**Chain B — Attendance → Day Type → Pay Impact:**
4. An `Employee` with an approved-leave day, a genuine unexplained absence
   on a working day, and an absence on an unconfigured (unclassified)
   date all produce three different `PayrollAttendanceDayClassification`
   outcomes (`none`/`deduction`/`none`, per `ADR-070 §9`'s table) inside
   the same `PayrollRun` — proving the day-type rule discriminates
   correctly, never defaulting every `'absent'` day to the same treatment.

**Cross-chain:**
5. A `CommissionAdjustment` created after a `PayrollRun` has posted does
   not alter that run's already-posted `PayrollRunLine`/GL entries (§14,
   §18) — it is only visible in a subsequent run.
6. The full chain's audit trail (§11) reconstructs, after the fact, every
   decision point from `Employee` to `GL` for one transaction, using only
   `AuditService` records plus the `CommissionResult`/`PayrollRunLine`
   snapshots — no gap requiring a live re-query of upstream data.

## 20. Non-Goals

Everything `ADR-070 §20` and `ADR-071 §20` already named, unchanged. This
document adds no additional non-goal beyond confirming: **no cross-domain
transaction, no shared table, no new approval engine, no new audit
mechanism, no new GL entry point** beyond Payroll's single one.

## 21. §16 Escalations / Open Dependencies (consolidated)

Every item `ADR-070 §21` and `ADR-071 §21` already named, unresolved here
too, consolidated for one CTO-facing view before implementation begins:

| Escalation | Blocks | Source |
|---|---|---|
| Holiday Calendar source/weekend pattern | Full accuracy of `PayrollAttendanceDayClassification` (fail-safe already prevents incorrect deduction, §14) | `ADR-070 §21` |
| Tax bracket / social insurance rates | Any tax/insurance deduction line | `ADR-070 §21` |
| Overtime rate/eligibility | `PayrollRunLine.overtimeAmount` (reserved, zero) | `ADR-070 §21` |
| Gratuity/end-of-service rule | Any gratuity calculation | `ADR-070 §21` |
| Leave encashment conversion rule | Any automatic encashment (manual input path unaffected) | `ADR-070 §21` |
| **Structured Customer Group entity does not exist in CRM** | The `customer_group` tier of Commission's Resolution Engine (§9) | `ADR-071 §3`/§21 |
| Initial Commission policies/rates | Any commission resolving at all until configured | `ADR-071 §21` |
| `Net Sales` basis precise composition | Any policy using `basis = 'net_sales'` | `ADR-071 §21` |

**None of these block Chain A/B's E2E proof for the scopes that
*are* ratified** (flat-rate Sales-Rep/Customer commission, gross/collected
basis, working/weekend/leave day classification with the unclassified
fail-safe, GL posting of gross pay + resolved commission) — they block
specific, named, already-disclosed sub-features only.

## 22. Implementation Sequence (proposed, not authorized)

Per the CTO's dependency order: `ADR-070` and `ADR-071` may be built in
parallel up through each one's own §22 steps 1–6 (both contracts'
internal foundations do not depend on each other). This document's own
integration points (§9's read contracts) are the **last** pieces of each:
Payroll's `listApprovedCommissionResults` consumption (`ADR-070` step 6)
cannot be tested until Commission's read contract (`ADR-071` step 6)
exists. Chain A/B's E2E acceptance criteria (§19) are the final gate
before this program moves to Testing → Verification → Delivery, and are
not attempted until both individual contracts' own stages are complete.
Production remains HOLD.
