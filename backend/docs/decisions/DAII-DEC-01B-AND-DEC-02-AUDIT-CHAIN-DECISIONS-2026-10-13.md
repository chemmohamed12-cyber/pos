# DAII — Audit-chain decisions prepared for the authority: DEC-01b (realignment responsibilities) and DEC-02 (already-broken chains) — 2026-10-13

**Status: PREPARED FOR DECISION.** Nothing here is executed, and nothing here authorises an operation on any real database. Names of people are not requested; functional titles are used and are placeholders until the authority assigns holders. Assigning a title grants no permission. Direction already decided by the CTO (2026-10-12): Option B — the audit writer fails closed on sequence lag and never realigns the sequence by itself (`4d4ed0d`).

## 0. What is proven, and what still needs an authority or an independent decision
| Subject | Proven (author-track evidence, disposable databases only) | Still needs an authority-holder / independent review |
|---|---|---|
| DEC-01b — writer behaviour | The writer refuses **before** `nextval` when the next value would not exceed the stored tail, never realigns (`setval` only in a comment), and leaves the sequence unchanged: code read; T-28 12/12 and T-26 3/3 on `bcfce72`; T-04 alone on the Option B writer and the 91-spec regression (0 FAIL) on `4dc3862` | independent review of the guard (`4d4ed0d`); the CTO's recording of Option B verbatim |
| DEC-01b — operator realignment | The runbook §5 template (advisory lock + one `setval`) was rehearsed on a disposable database (T-28 B5/B5b/B7) and its post-checks measured | **every real use**: holders of the four functions, a diagnosis, a scope, a recovery plan, written approval; nothing here authorises it |
| DEC-01b — assumption | Increment 1 / cache 1 is asserted by test B9 only | a runtime/startup assertion does not exist and is not authorised here |
| DEC-02 — new breaks | The cause family (hash/sequence mismatch after a rolled-back insert) is fixed for new writes by `c764fc5` (T-22/T-23); existing rows untouched | independent review of `c764fc5` |
| DEC-02 — existing breaks | **Not proven**: whether any real database has a break, where, or why — no inventory exists | the decision between (a) and (b); read-only access for the inventory (WP-AUD-02) |

## 1. DEC-01b — responsibilities for a future operator realignment of the audit sequence
Source of the mechanics: `DAII-RUNBOOK-AUDIT-SEQUENCE-LAG-2026-10-12.md` (roles there are `DB_OPERATOR`, `APPROVER`, `ESCALATION_OWNER`, `OPS_CONTACT`). This section fixes the four functions the owner asked for and maps them to the runbook's roles; the runbook's steps are unchanged.

| Function (requested) | Functional title | Runbook role | Authority and limits | Must not be the same holder as |
|---|---|---|---|---|
| Executor of the realignment | `AUDIT_DB_OPERATOR` | `DB_OPERATOR` | Runs only the §5 template (advisory lock `7419203511` + one `setval` to `max(seq)`), only on the database named in the written approval, only after the approval exists; records before/after values. May not diagnose-and-approve in one person; no other write to `audit_records` | Approver, Independent reviewer |
| Approver | `AUDIT_CHANGE_APPROVER` | `APPROVER` | Approves each execution in writing, per incident: names the database, the diagnosis reference, the recovery plan and the window. Default holder proposed: the CTO or a delegate named in writing | Executor, Independent reviewer |
| Independent reviewer | `AUDIT_INDEPENDENT_REVIEWER` | (new; the runbook §9 asks for independent review) | Reviews the diagnosis and the §6 post-checks. For an **unexplained** lag the review must exist before the approval can be given. Must not have written the guard (`4d4ed0d`), the runbook or the verification being relied on | Executor, Approver, and anyone in the independence register of the review pack |
| Operations / escalation owner | `AUDIT_OPS_ESCALATION_OWNER` | `ESCALATION_OWNER` + `OPS_CONTACT` | Receives every report of a refused append, opens the incident, stops the prohibited activities (runbook §2), escalates to the Approver (L3). Performs no remediation | Executor |

**Separation rule:** the four titles are held by at least three different people; Executor, Approver and Independent reviewer are always different. Time targets for escalation are not invented here; the owner sets them.

**Preconditions — all of them, for any realignment of a real database (none is met today):**
1. an approved read-only diagnosis (sequence state, `count`/`max(seq)`, existing chain-verification result) with a cause classification: *explained* (documented restore/import/reset) or *unexplained* (treated as a possible integrity incident);
2. a defined scope: the one database and Company, the sequence, the stored tail `seq` and hash, the target value;
3. a recovery plan: a verified backup or restore point and the recorded `last_value`/`is_called` before the change (a `setval` is not rolled back by a transaction rollback);
4. explicit written approval by the Approver, and for an unexplained lag the Independent reviewer's written review;
5. evidence retention: incident id, executor, approver, reviewer, approval reference, times, before/after values, post-check results (counts and numbers only — no audit content).
Without all five: **no realignment**, no automation, no exception. Realignment on a real database is **not authorised by this document**; the experiment-only status of the runbook stands (virtual roles, never performed).

**Status of DEC-01b:** direction DECIDED (Option B); implementation `4d4ed0d` IMPLEMENTED; VERIFIED on clean snapshots (T-28 12/12 on `bcfce72`, T-26 3/3, T-23 7/7; regression 89/1/1/0 on `4dc3862`); **not independently accepted**; holders for the four titles: **not assigned — authority required**. Runbook note: its §8 says the §5-template re-run and test B9 were awaiting a run; both ran in `bcfce72` (T-28 12/12 incl. B9 and the runbook-exact realignment). A runtime or startup assertion that the audit sequence is increment 1 / cache 1 still does not exist in the product (only test B9) — recorded as an open item, not implemented here.

## 2. DEC-02 — already-broken audit chains
**Question.** For a Company whose chain already fails verification: accept and annotate the break, or authorise a repair procedure?
**What is known (VERIFIED):** the cause family of new breaks was the hash/sequence mismatch after a rolled-back insert (F-AUD-003, fixed in `c764fc5`); the fix touches no existing row. **What is not known:** how many real databases already contain a break, where, and whether all are rollback-caused — no inventory exists because no approved read-only access exists (same blocker as PA-43, see `DAII-PA43-WP-AUD-09-STATUS-2026-10-13.md`).
**Options (as documented in the register; no others exist):**
| Option | Content | Conditions |
|---|---|---|
| (a) Accept and annotate | Keep every row untouched; record per database the first broken `seq`, the cause class (rollback / import-restore / unknown) and the detection evidence in a break register | needs only read-only verification |
| (b) Authorised repair | A repair/re-anchoring procedure | only with a verified backup, independent review, separate written approval and evidence; **no in-place rewrite without separate approval** (roadmap P0A-5); no such procedure is designed |
**Recommendation (non-binding, prepared for the authority):** adopt (a) as the standing policy now; treat (b) as not available until a procedure has been designed, reviewed independently and approved for a named database. Reasons: it needs no privilege beyond read-only verification, it changes no evidence, and a repair would be the only operation in the program that rewrites history.
**Procedure that follows from (a) (documentation only; nothing is run):** (1) detect with the product's existing read-only chain verification; (2) write the break-register entry (database, first broken `seq`, cause class, date, verifier output hash — numbers only); (3) keep rows as they are — the chain continues after the break from the stored tail hash, so verification keeps failing at the same point; (4) do not re-hash, normalise, delete or re-order. **Limit to state openly:** the product has no feature that marks a known break as annotated, so an annotated chain still reports "broken" at the first break; a product-level annotation mechanism would be a separate work package and is not designed or authorised.
**Prohibitions that stand regardless of the decision:** no change to the historical record, no automatic realignment, no UUID repair (DEC-25 interim policy), no hiding or deleting of failing tests or assertions.
**Status: DECISION REQUIRED** (CTO with the security/audit owner). **Blocker:** the authority's decision; the inventory (WP-AUD-02) additionally needs approved read-only access. Until decided, the documented interim stance — accept, annotate, do not rewrite — is the only permitted handling.
