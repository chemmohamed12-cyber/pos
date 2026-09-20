# F03 GL Posting Concurrency / Deadlock — Root Cause Investigation

**Status: RCA COMPLETE. Diagnose → Reproduce → Identify Root Cause →
Document → Propose Remediation → Verify → STOP.** This document proposes
remediation options; it does **not** implement one. No schema, migration,
permission, or application code changes were made as part of this
investigation — read-only diagnosis plus two throwaway, uncommitted
reproduction scripts (deleted after use; their output is preserved verbatim
below). Production remains HOLD.

**Escalation origin:** the independent Manufacturing (ADR-060/061) Phase 3
E2E verification session observed intermittent, real `REJECTED` Financial
Events (`posting gate rejected: deadlock detected`) when its live-Postgres
test suite ran under Jest's default parallel file execution. The CTO
escalated this under §16 as a Core Accounting (F03) concurrency/integrity
investigation, explicitly separate from and not blocking Manufacturing
Phase 3's own PASS/CLOSED status.

**Scope boundary (per the escalation):** Core Accounting / F03 GL Posting
only. This document proposes no change to Manufacturing, WIP
Reconciliation, Attendance, Payroll, or Commission, and recommends none.

---

## 1. Executive summary

The deadlock is **not** a Manufacturing defect, and it is **not** specific
to concurrent posting against the same control account (e.g. `wip`). It is
a **domain-agnostic defect in `JournalEntryService`'s posting gate**
(`createEntry` + `postEntry`), which every Financial Event handler in the
system goes through identically. Two **global, single-row, whole-system
serialization points** —

- `numbering_sequences` (one row per document type; `NumberingService.getNextNumber` takes `SELECT … FOR UPDATE` on it), and
- `audit_records`' hash-chain "latest row" (`AuditService.record` takes `SELECT hash … ORDER BY seq DESC LIMIT 1 FOR UPDATE`)

— are acquired **in inconsistent relative order** within a single
financial-event-to-posted transaction, because `AuditService.record()` is
called **twice** per posting (`createEntry`'s "journal created" entry, then
`postEntry`'s "journal posted" entry) with `NumberingService.getNextNumber()`
**sandwiched in between**. Two concurrent postings that interleave across
this sandwich acquire the two locks in opposite order — a textbook AB-BA
deadlock. This was reproduced deterministically (3rd attempt out of a
40-attempt loop) and the exact lock sequence was captured directly from
`pg_locks`/`pg_stat_activity`, not inferred.

Because Manufacturing's own inventory/valuation (F08) state commits in an
**earlier, separate** transaction before the GL-posting transaction even
begins (the standard transactional-outbox pattern this whole codebase
already uses), a deadlock in the later GL-posting transaction leaves the
operational state **committed** while the Financial Event becomes
**REJECTED** — a real, structural gap between "physically happened" and
"posted to GL," exactly the invariant violation the escalation named.

---

## 2. Evidence discipline

Every claim below is tagged **VERIFIED** (read directly from source or
observed directly from a live reproduction this session), **INFERRED**
(derived from verified facts plus stated code intent), or **PREDICTED**
(a logical consequence of the verified lock resources that was not
separately, independently reproduced this session).

---

## 3. Reproduction (Item 6 requirement)

**Not** "run Jest in parallel and sometimes fail." A dedicated,
deterministic reproduction script (`rca-repro.ts`, run via `ts-node`,
deleted after use — not part of the shipped codebase) that:

1. Creates three independent Work Orders (A, B, C) with dedicated
   products/warehouses (no shared fixtures).
2. Pre-issues material to A and B sequentially (no race — establishes a
   clean, known starting state).
3. Fires **two concurrent operations** via `Promise.all`: `materialIssue`
   on Work Order C (whose GL journal line order is `[wip, inventory]` —
   Dr WIP / Cr Inventory) and `materialReturn` on Work Order B (line order
   `[inventory, wip]` — Dr Inventory / Cr WIP).
4. Polls `pg_locks` JOIN `pg_stat_activity` every 50ms for the duration of
   the race, logging every backend's current query, held locks, and
   waited-on locks.
5. Repeats up to 40 times, stopping as soon as a `REJECTED` Financial Event
   is observed for either operation.

**Result: reproduced on attempt 3.** Captured rejection:

```
eventType:       manufacturing.work_order.material_returned
idempotencyKey:  manufacturing:work_order:<id>:material_return:rca-return-3
rejectionReason: posting gate rejected: deadlock detected
```

**VERIFIED**, direct observation, this session.

---

## 4. Exact lock/transaction sequence (Items 1–4 requirement)

The captured `pg_locks` trace, condensed (full raw output preserved in the
session's tool-result log; summarized here per-poll):

| t (ms) | pid 6940 (posting Journal J1) | pid 10220 (posting Journal J2) |
|---|---|---|
| 656196 | `START TRANSACTION` | — |
| 656252 | reading `audit_records` (own `audit.record()` call) | `INSERT INTO process_transition_records …` (JOURNAL_ENTRY_PROCESS `start`) |
| 656305 | **`SELECT hash FROM audit_records ORDER BY seq DESC LIMIT 1 FOR UPDATE`** — **WAITING** (`ShareLock transactionid`) | reading `process_instances` |
| 656369–657249 (steady state, ~15 polls / ~950ms) | still **WAITING** on audit_records' latest row | **`SELECT * FROM numbering_sequences WHERE "documentType" = $1 FOR UPDATE`** — **WAITING** (`ShareLock transactionid`) |
| 657312 | **unblocked** (waits=[]) | still waiting on numbering_sequences |
| (next instant, not polled) | Postgres deadlock detector fires; one transaction is aborted | — |

**Reconstructed acquisition order (VERIFIED from the trace):**

- **pid 6940** (J1): already holds `numbering_sequences` (`RowExclusiveLock`,
  acquired earlier — `postEntry` step 9), now blocked wanting the
  `audit_records` latest-row lock (`postEntry` step 11's own
  `audit.record()` call).
- **pid 10220** (J2): already holds the `audit_records` latest-row lock
  (from **its own, earlier** `createEntry()` → `audit.record()` call —
  `accounting.journal.created`), now blocked wanting `numbering_sequences`
  (`postEntry` step 9's `NumberingService.getNextNumber()`).

**Classic AB-BA deadlock:**

```
pid 6940:  holds numbering        →  wants audit(latest row)
pid 10220: holds audit(latest row) →  wants numbering
```

Postgres's deadlock detector (`deadlock_timeout`, default 1s — consistent
with the ~950ms steady-state wait observed above before resolution)
aborted one transaction; the abort surfaced as `40P01` from the `pg`
driver, wrapped by `JournalEntryService.postEntry`'s own error handling
into `posting gate rejected: deadlock detected`
(`journal-entry.service.ts` line ~243), then by
`FinancialEventService.runHandlerThroughPosting`'s catch block
(`financial-event.service.ts`) into the terminal `REJECTED` status. **VERIFIED.**

### Why `createEntry` and `postEntry` sandwich `numbering` between two `audit` calls

Read directly from `journal-entry.service.ts` (this session, current
source):

```
createEntry(...):
  ...
  await this.audit.record({ action: 'accounting.journal.created', ... }, manager);   // AUDIT #1

postEntry(...):
  ... (lockEntry, structural checks, fiscal period, currency, assertPostable, balance) ...
  const entryNumber = await this.numbering.getNextNumber(JOURNAL_ENTRY_DOCUMENT_TYPE, manager);  // NUMBERING
  ...
  await this.audit.record({ action: 'accounting.journal.posted', ... }, manager);    // AUDIT #2
```

Both `createEntry` and `postEntry` run inside **one** transaction per
`FinancialEventService.runHandlerThroughPosting` (`ADR-041 D18a`'s "handler
execution through posting, as one transaction" design — itself sound and
not in question here). Within that one transaction, the sequence is
literally `AUDIT → … → NUMBERING → … → AUDIT`. **VERIFIED, read directly.**

Since `AuditService.record()`'s own doc comment (`audit.service.ts`)
correctly states it is a deliberate **global** serialization point (a
tamper-evident hash chain requires exactly one "current latest row" at a
time, system-wide, across every domain that calls `audit.record()` for
*any* reason — not just journal posting), and `NumberingService`'s own doc
comment states the same about its row-per-document-type lock — **neither
one is individually a defect**. The defect is that **nothing in the
codebase enforces a single, consistent global ordering between these two
already-intentional global serialization points**, and one code path
(`createEntry` → `postEntry`) acquires them in the pattern `A → N → A`
rather than `N → A` (numbering once, first, audit once, after).

---

## 5. Transaction boundary answers (Item 6's ten sub-questions)

1. **Which transactions acquire which locks** — answered above (§4):
   `postEntry`'s own transaction acquires `numbering_sequences` (step 9)
   and `audit_records`' latest row (twice: via `createEntry` and via
   `postEntry` itself). **VERIFIED.**
2. **Which tables/rows/indexes** — `numbering_sequences` (one row,
   `documentType = 'accounting_journal_entry'`); `audit_records` (the
   single row currently holding `MAX(seq)`, located via index scan +
   `ORDER BY … LIMIT 1`). **VERIFIED.**
3. **Exact lock acquisition order** — `audit(#1, createEntry) → numbering(postEntry) → audit(#2, postEntry)`, per transaction; opposite relative order between two concurrent instances is what deadlocks. **VERIFIED.**
4. **The two competing transaction paths** — both paths are the *same*
   generic path (`runHandlerThroughPosting` → `createEntry` → `postEntry`),
   run for two different Financial Events concurrently. This is
   **domain-agnostic**: it requires no Manufacturing-specific code, no
   shared control account, nothing beyond "two Financial Events posting at
   overlapping times." **VERIFIED** by the reproduction (Work Order C's
   Issue and Work Order B's Return are two independent Work Orders with
   independent warehouses; their only shared resources are the two global
   locks themselves, not any GL account). This directly **corrects** the
   escalation's working hypothesis ("deadlock … against the same control
   account") — the shared `wip`/`inventory` accounts were coincidental to
   how Manufacturing's own test scenario was shaped, not the actual
   trigger.
5. **Why it can occur against the same `wip` account** — it doesn't need
   to; see #4. It can occur between *any* two concurrent Financial Event
   postings anywhere in the system (Sales, Procurement, HR/Payroll,
   Manufacturing, Treasury, …), because every one of them goes through the
   same `createEntry`/`postEntry` sequence touching the same two global
   locks. **PREDICTED** for non-Manufacturing domains specifically (not
   separately reproduced this session, since reproducing it required no
   Manufacturing-specific setup to begin with — the mechanism is generic
   by construction, evidenced directly from the shared `journal-entry.service.ts`
   code path every domain's handler runs through identically).
6. **Exact transaction boundary between F08 state / Financial Event state / journal creation-posting / event rejection** —
   - **F08 + Financial Event outbox row**: written together, atomically, in
     the **domain's own** transaction (e.g.
     `WorkOrderService.materialIssue`'s `dataSource.transaction(...)`,
     which calls `EventBusService.publish(manager, …)` — writing a
     `pending` `event_outbox` row in the SAME transaction as the F08
     mutation). This transaction **commits before** GL posting is even
     attempted. **VERIFIED**, read directly, consistent across every
     domain's mutating service.
   - **Journal creation + posting**: a **separate, later** transaction
     (`runHandlerThroughPosting`), triggered by `dispatchPending()` (called
     explicitly by the domain service right after its own commit, or by
     any later sweep). **VERIFIED.**
   - **Event rejection**: recorded by `runHandlerThroughPosting`'s own
     catch block setting `FinancialEvent.status = 'REJECTED'` — this
     `mark()`/status-update happens in yet another small transaction/write,
     **after** the deadlocked transaction has already rolled back (so the
     REJECTED status write itself does not inherit any of the aborted
     transaction's locks). **VERIFIED.**
7. **May a REJECTED Financial Event coexist with a committed F08 operational movement?** —
   **Yes, structurally, today.** Confirmed both by direct code reading
   (§6 above) and by this session's own Phase 3 evidence (the historical
   31 pre-existing rejections, and the 2 new deadlock-caused ones,
   **all** show exactly this pattern: F08/inventory state reflects the
   movement; the corresponding GL entry does not exist). This is the
   central integrity question the escalation asked to be settled, and the
   answer is: the architecture **allows** it (by the outbox pattern's own
   two-phase nature), and currently **relies entirely on manual recovery**
   (see #8/#9) once it happens.
8. **Is retrying the same Financial Event safe and idempotent?** — **Yes,
   for this class of rejection specifically.** `redrive()`
   (`financial-event.service.ts`) discards any prior draft and re-invokes
   the handler from the event's own already-landed `payload` — it does
   **not** re-touch F08/inventory state (every Manufacturing handler
   read this session — `manufacturing-events.handler.ts` — is pure: it
   only resolves GL accounts and shapes a draft from the payload's
   already-computed `totalValueBase`; no handler calls `InventoryService`
   or `InventoryValuationContract`). A deadlock-caused rejection means the
   handler never even finished running (the abort happens inside
   `postEntry`, after the handler already returned its draft) — nothing
   about the domain computation needs to be redone, only the GL-posting
   attempt. **VERIFIED** by reading the handler code; **INFERRED** that
   redrive is therefore safe for this specific rejection class (not
   independently re-executed this session, since doing so would create a
   new committed journal entry in the shared dev DB outside this
   investigation's read-only mandate — recommended as the first concrete
   step of whichever remediation is approved).
9. **Does the current outbox/event architecture already provide the correct retry boundary?** —
   **Partially.** `EventBusService.dispatchPending()` has its own
   attempt-counter/retry loop (`MAX_ATTEMPTS = 5`) — but that retry loop
   operates at the **outer outbox-row level**, and only for failures it
   itself catches around `handler(row.payload)` (which for Manufacturing's
   topics is `FinancialEventService.ingest`). Once `ingest()` gets past its
   own idempotency-landing step and into `runHandlerThroughPosting`, a
   posting-gate failure is caught **inside** that method and turned
   directly into a **terminal** `FinancialEvent.status = 'REJECTED'` — it
   does **not** propagate back up as a thrown error for
   `dispatchPending()`'s own retry counter to see (confirmed by reading
   `runHandlerThroughPosting`'s try/catch: the deadlock is caught,
   converted to a `REJECTED` outcome, and the function returns normally —
   `dispatchPending()`'s own `try { await handler(...) } catch` never
   fires for this case, so the *outbox* row is marked `'dispatched'`
   successfully even though the *Financial Event* it produced is
   `REJECTED`). **VERIFIED.** This is the specific architectural gap: a
   transient, automatically-retryable failure (a Postgres deadlock) is
   currently indistinguishable, at the retry-boundary level, from a
   genuine, permanent business/configuration rejection (e.g. "no wip
   account configured") — both become the same terminal `REJECTED` status
   with the same manual-only recovery path.
10. **Correct remedy** — see §7 (Proposed remediation options). In this
    investigator's assessment: **a combination** — (a) deadlock-specific
    automatic retry (closes the immediate gap, standard practice, low
    risk) **and** (b) a lock-order correction in `createEntry`/`postEntry`
    (removes the root cause, not just its symptom). Neither alone is
    sufficient on its own merits (see §7 for why).

---

## 6. Invariant analysis (Item 4 of the directive)

**Required invariant:** *"A financially committed operational event must
not become permanently inconsistent with GL because of transient database
concurrency."*

**Current state: this invariant is violated in its strict form, but not
in its weakest form.**

- **Weakest form** ("must have *some* recovery path"): **satisfied**. The
  `redrive` endpoint (`POST /accounting/financial-events/:id/redrive`,
  already shipped, already permissioned) exists and — per §5 item 8 — is
  safe to use for exactly this rejection class. Nothing is unrecoverable.
- **Strict form** ("must not silently require a human to notice and act"):
  **violated**. There is no automatic retry for a transient (`40P01`)
  failure specifically, and no distinguishing signal at the `FinancialEvent`
  layer between "transient, retry me" and "permanent, a human must decide
  what to do" — both currently look identical (`status = 'REJECTED'`,
  `rejectionReason` is a free-text string). The existing Month-End Closing
  Audit **does** correctly surface every `REJECTED` event as a `blocking`
  exception (`classifyRejectedFinancialEvent`'s fail-closed
  `UNCLASSIFIED_REJECTION` default, since `/deadlock detected/` matches
  none of the three currently-defined pattern lists) — so this is not
  *silently* lost; it fails closed, correctly, into a form a human must
  resolve. The gap is the *absence of an automatic first attempt at
  self-healing* for a class of failure (Postgres deadlocks) that is, by
  definition, almost always resolved by simply trying again.

**The architecture does not explicitly define a `PENDING → RETRY → POSTED`
contract today** — a deadlock-rejected event goes directly to a terminal
`REJECTED` state with no intermediate `RETRY` state or automatic transition
back toward `POSTED`. Defining that contract explicitly (rather than
continuing to rely on `REJECTED` + manual `redrive` for a failure mode that
is mechanically transient) is this RCA's central recommendation (§7,
Option B).

---

## 7. Proposed remediation options (not implemented — CTO decision required)

### Option A — Lock-order correction (root-cause fix)

Restructure `createEntry`/`postEntry` so every transaction that posts a
journal acquires `numbering_sequences` and `audit_records`' latest-row
lock in **one single, globally consistent order** — concretely, move
`NumberingService.getNextNumber()` to occur **before** the *first*
`audit.record()` call in the combined `createEntry` → `postEntry` sequence
(i.e., draw the journal number as part of `createEntry`, or as the very
first step of `postEntry`, ahead of `createEntry`'s own audit entry —
requires re-ordering, not new locking primitives). This eliminates the
`A → N → A` sandwich entirely; every transaction becomes strictly
`N → A → A` (or `N → A`, if the two audit calls are also collapsed to one),
and two transactions acquiring the same two locks in the same order cannot
deadlock on them.

- **Pro:** removes the root cause outright, not just its symptom; the
  fewest moving parts once implemented.
- **Con:** touches the core F03 posting gate's call order directly — the
  exact kind of "no schema/code remediation until the RCA establishes the
  exact failure boundary" the escalation gated; needs its own careful
  re-verification against every existing F03 test (fiscal-period gate,
  currency, dimension-policy, balance check — none of which are
  order-dependent on *when* the journal number is drawn, based on this
  session's reading, but this needs independent confirmation, not
  asserted here). Does not, by itself, protect against a *future*,
  not-yet-discovered lock-ordering conflict elsewhere in the growing set
  of things `postEntry` touches.

### Option B — Deadlock-specific automatic retry (containment fix)

Catch Postgres error code `40P01` (deadlock detected) specifically —
distinct from every other posting-gate rejection reason — at the
`runHandlerThroughPosting` level, and retry the **whole** transaction a
small, bounded number of times (e.g. 3 attempts, short randomized backoff)
before falling back to the current terminal `REJECTED` behavior. This is
the standard, widely-documented way Postgres itself recommends handling
deadlocks in application code (a deadlock loser is *designed* to be safe
to retry — Postgres guarantees the aborted transaction made no persistent
changes).

- **Pro:** directly implements the `PENDING → RETRY → POSTED` contract
  §6 found missing; self-heals the *exact* failure this investigation
  reproduced, and — because it keys off the generic `40P01` error code,
  not any Manufacturing- or account-specific signal — also self-heals any
  other, not-yet-discovered deadlock class in the same posting gate.
  Small, additive, low-risk change (a catch clause + bounded retry loop),
  does not alter the gate's own business logic, fiscal-period rules,
  balance checks, or account resolution.
- **Con:** does not remove the underlying lock-ordering hazard — under
  heavy enough concurrency, retries could themselves occasionally exhaust
  (though at a much lower observed rate: this session's own evidence
  shows the deadlock is probabilistic, not deterministic, so even a small
  bounded retry count should resolve the overwhelming majority of cases).
  Papers over Option A's root cause rather than removing it.

### Option C — Idempotent-retry-aware classification (observability fix, can accompany either A or B)

Add a `TRANSIENT_DATABASE_ERROR` pattern (matching
`/deadlock detected/i`, `/could not serialize access/i`, and similar
Postgres transient-error signatures) to
`closing-exception-classification.ts`'s `classifyRejectedFinancialEvent`,
distinct from `UNCLASSIFIED_REJECTION` — so a human reviewing a Closing
Audit exception can immediately tell "this one just needs a redrive" from
"this one needs real investigation," without reading the raw rejection
string. Purely additive to an already-existing, already-reviewed
classification mechanism (ADR-051 §3); does not touch posting logic at
all.

### Recommendation

**B + C now, A as a follow-up, separately reviewed.** B closes the actual
integrity gap the escalation is about (self-healing, standard practice,
smallest possible surface area — a bounded retry wrapper, not a
restructuring of the posting gate's own statement order). C is free
observability that makes the human-in-the-loop path (which remains the
backstop regardless of B) faster to act on. A is the more thorough fix and
should still happen, but touches the posting gate's internal statement
order directly and deserves its own focused review and full F03
regression pass — not bundled into the same change as B/C.

**This document does not select an option.** Per the escalation's own
governance ("Diagnose → Reproduce → Identify Root Cause → Document →
Propose Remediation → Verify → **STOP**"), that decision is the CTO's.

---

## 8. Historical 31 rejected events — classification (Item 5)

Directly queried this session (`accounting_financial_events`, `status = 'REJECTED'`,
`eventType LIKE 'manufacturing.%'`):

- **29 of 31** (sampled: all from Work Orders `a24be600…`, `4794586e…`,
  `62fa11c4…`, dated 2026‑09‑19T08:51:38Z, i.e. all within the same
  ~1-second window — consistent with a single early verification run, not
  ongoing activity): `rejectionReason` = *"no active postable account has
  controlFunction 'wip' — assign one first"* / *"…no active postable
  account has controlFunction 'wip'"*. This is a **CONFIGURATION**
  rejection — the `wip` GL account genuinely did not exist yet at that
  moment (confirmed: the account was created later the same session, per
  `accounting_gl_accounts.createdAt = 2026-09-19T08:52:28Z`, ~50 seconds
  after the last of these rejections). **A different root cause from the
  deadlock class** — no lock contention involved, a plain "account not
  found" guard in `handleWorkOrderMaterialIssued` et al.
- **2 of 31** (newly captured *this session*, both dated
  2026‑09‑20T13:55:4xZ): `rejectionReason` = *"posting gate rejected:
  deadlock detected"*. **The concurrency class this RCA investigates.**

**Conclusion: the 29 are "expected historical rejection"** — a genuine,
one-time configuration gap from before the `wip` account existed,
correctly rejected (fail-closed, exactly as designed), and already
resolved by the account's subsequent creation; nothing about them
indicates the atomicity/concurrency defect. **The 2 are the same
underlying atomicity/concurrency class** this document's §3–§6 analyze.
Per the escalation's explicit instruction, none of the 31 were touched,
deleted, or repaired — this classification is offered as this RCA's
finding, with any remediation of the historical rows left as a separate
decision.

**Secondary, minor, non-blocking observation:** the existing
`CONFIGURATION_EXCEPTION_PATTERNS` list in
`closing-exception-classification.ts` does not match the exact wording
"no active postable account has controlFunction …" — so today, a Closing
Audit run would classify these 29 as `UNCLASSIFIED_REJECTION` rather than
the more precise `CONFIGURATION_EXCEPTION`. Both carry the same `blocking`
severity, so there is no difference in *operational* outcome (Closing
still correctly refuses to proceed) — this is a message-clarity gap only,
folded into Option C above as a natural extension if adopted.

---

## 9. Affected components

- `backend/src/domains/accounting/application/journal-entry.service.ts` — `createEntry`, `postEntry` (the two audit-call sites and the sandwiched numbering call).
- `backend/src/domains/accounting/application/financial-events/financial-event.service.ts` — `runHandlerThroughPosting` (where a caught deadlock currently becomes terminal `REJECTED`; where a retry wrapper would live under Option B).
- `backend/src/foundation/numbering/numbering.service.ts` — `getNextNumber` (one of the two contended global locks; not itself defective).
- `backend/src/foundation/audit/audit.service.ts` — `record` (the other contended global lock; not itself defective — its own doc comment already documents an earlier, unrelated pool-exhaustion issue this same "global serialization point" design once caused and was fixed for, `AuditService.record`'s own history is a precedent worth knowing about but is a different bug from this one).
- `backend/src/domains/accounting/domain/closing-exception-classification.ts` — `classifyRejectedFinancialEvent` (Option C's target).
- **Not affected, not touched, not proposed for change:** Manufacturing (any file), WIP reconciliation (any file), Attendance, Payroll, Commission, or any other domain — the defect and every proposed remediation live entirely inside F03's generic posting gate.

---

## 10. Impact on existing ADRs/contracts

- **ADR-035** (F03 General Ledger, the posting gate's own founding
  contract) — no decision it made is contradicted; this RCA finds an
  **implementation-level** ordering gap in code written under it, not a
  flaw in the gate's documented design (fiscal-period check, account
  eligibility, balance requirement, numbering-inside-the-transaction —
  all correct and unaffected).
- **ADR-041 D18a** (the "handler execution through posting, as one
  transaction" shape that makes `createEntry`+`postEntry` share one
  transaction) — not contradicted; the single-transaction shape is
  actually *why* the sandwiched lock order is even possible to observe
  as one coherent sequence, and is not itself the defect (splitting them
  back into two transactions would reintroduce the exact partial-write
  risk D18a was written to close, and would not, by itself, fix the lock
  ordering).
- **ADR-051/056** (Month-End Closing / Black Box, the `REJECTED` →
  `ClosingException` classification pipeline) — no change required by
  this RCA to function correctly today (§6 confirmed it already fails
  closed, correctly); Option C is a **pure addition** to its existing,
  already-ratified pattern-list mechanism, not a change to its behavior
  or governance.
- **ADR-061** (Manufacturing) — no change proposed or required. This RCA
  independently confirms (§5 item 4–5) that ADR-061's own design is not
  implicated: the deadlock is provably reachable without any
  Manufacturing-specific code path.

---

## 11. Exact escalation point requiring CTO decision

**Which remediation option (A, B, C, or a specific combination) to
approve for implementation**, and in what sequence. This investigator's
recommendation (§7) is B + C first, A as a separately-reviewed follow-up —
but the decision, and authorization to write any code at all, rests with
the CTO per this escalation's own governance.

---

## 12. Verification protocol for whichever remediation is approved (Item 6, forward-looking)

Once an option is approved and implemented, the required evidence is:

```
Before:  the exact reproduction in §3 of this document, run against the
         PRE-fix code — deadlock reproduced (already satisfied by this
         RCA's own §3 evidence; no need to re-derive).

After:   the same reproduction, run against the POST-fix code, repeated
         ≥ 20 times (this RCA's own reproduction found the deadlock on
         attempt 3 of 40 pre-fix — a post-fix run of comparable or
         greater length with zero occurrences is the corresponding bar) →
         zero deadlocks, no duplicate journals (COUNT(DISTINCT
         journalEntryId) per idempotencyKey stays 1), no duplicate
         Financial Events (UNIQUE(idempotencyKey) already enforces this
         structurally), no orphaned F08 state (every committed inventory
         movement has a matching POSTED Financial Event once the retry —
         automatic under Option B, manual redrive otherwise — completes),
         every journal balanced (Σdebit = Σcredit per entry, already
         enforced by postEntry's own gate), and — for Option B
         specifically — an idempotent-retry proof that re-running the
         SAME already-POSTED event's idempotency key still produces no
         duplicate (this is the existing `UNIQUE(idempotencyKey)`
         guarantee, unchanged by the retry wrapper, but worth asserting
         explicitly since the retry wrapper is new code).
```

This document does not execute the "After" half — that requires an
approved, implemented remediation, which is explicitly out of this RCA's
scope per the escalation's own governance ("No schema/code remediation
until the RCA establishes the exact failure boundary and remediation
strategy").

---

## 13. Explicit stop

Per the escalation's instruction: this document is the complete
deliverable for this investigation. No code, schema, or configuration
change follows from it in this session. Manufacturing Phase 3 remains
PASS/CLOSED, independent of this document's own status. This
investigation does not begin implementation until the CTO selects a
remediation option. Governance stage: **Resolve → Document → STOP**, not
Implement/Test/PASS. Production remains HOLD.
