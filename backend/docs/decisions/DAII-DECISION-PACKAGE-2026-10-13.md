# DAII — Decision package: DEC-02, DEC-20, DEC-25, DEC-01b — 2026-10-13

**Status: PREPARED FOR DECISION. Nothing is approved by this document; silence is not approval; nothing is executed.** For each decision: available evidence, options, risks, dependencies, a recommended direction **only where the evidence supports one**, and the exact approval wording required. While a decision is pending the unrelated authorized work continues (see `DAII-CONSOLIDATED-OWNER-REQUEST-2026-10-13.md`). Details already written are linked, not repeated.

| Decision | Approver | Recommendation supported by evidence? | Pending effect |
|---|---|---|---|
| DEC-02 broken chains | CTO + security/audit owner | Yes — (a) accept and annotate | policy stays "no rewrite" |
| DEC-20 dependency T1 | CTO | Yes — apply the rehearsed lockfile-only change | 65 advisories (3 critical) stay |
| DEC-25 UUID repair vs audit hash | CTO + security/audit owner | Partly — keep the interim prohibition and authorise the read-only check; the final handling needs the counts | PA-43 stays "need not established" |
| DEC-01b realignment functions | CTO | Yes for the functions; **no** for any realignment | none may be performed |

## DEC-02 — already-broken audit chains
- **Evidence.** New breaks of the rollback type are closed for new writes (`c764fc5`; T-22/T-23 on clean snapshots; Option B writer verified). The state of existing real databases is **unknown**: no inventory exists (needs read-only access, D1 of the owner request). Full text: `DAII-DEC-01B-AND-DEC-02-AUDIT-CHAIN-DECISIONS-2026-10-13.md` §2.
- **Options.** (a) Accept and annotate: keep rows untouched; per database record the first broken `seq`, the cause class and the verifier output hash in a break register. (b) Authorised repair: only with a verified backup, independent review, separate written approval and evidence; no such procedure has been designed.
- **Risks.** (a) The product has no feature that marks a known break as annotated, so an annotated chain keeps reporting "broken" at the first break — restore verification for that database stays ambiguous until a separate work package adds annotation. (b) The only operation in the program that rewrites history; no designed procedure; highest risk.
- **Dependencies.** Inventory (read-only access); independent reviewer for (b).
- **Recommendation.** (a), now; (b) only after a repair has been designed, reviewed independently and approved for a named database.
- **Approval required (exact).** *"DEC-02: the standing policy for an already-broken audit chain is accept-and-annotate under a break register; no historical audit row is modified, re-hashed or re-ordered; any repair requires a separate written approval naming the database, with a verified backup and an independent review."* Signed by the CTO and the security/audit owner.

## DEC-20 — dependency update, tier T1 (and the plan to apply it)
- **Evidence.** `npm audit` re-run 2026-10-13: 65 advisories (3 critical, 44 high, 14 moderate, 4 low), identical to 2026-10-11; manifests unchanged since. **Rehearsal in a scratch copy** (repository untouched; `evidence-clean-snapshot-2026-10-13/dependency-t1-rehearsal/`): `package.json` unchanged; 22 lockfile entries change (6 packages) and 8 are added; advisories **65 → 64**, critical **3 → 1**, high **44 → 41**; build PASS, lint PASS (0 errors), unit PASS, db-guard 50/50 when the commit is pinned (49/50 unpinned — the archive artefact).
- **What would change.**

| Package | From → to | Scope | Advisory effect | Compatibility note |
|---|---|---|---|---|
| `proxy-addr` | 2.0.7 → 2.0.8 | runtime (via express) | **critical** removed | patch; the application never sets `trust proxy` (D-01); the host check (does the proxy rely on its semantics?) is still required |
| `joi` | 17.13.6 → 17.13.8 | runtime (config validation at start-up) | high removed | patch |
| `@nestjs/common` | 10.4.15 → 10.4.22 | runtime | **still reported after the rehearsal** (it is not among the packages the rehearsal cleared); the remaining fix is tier T2 | patch; **adds the `file-type` chain** below |
| `handlebars` | 4.7.9 → 4.7.10 | dev (via ts-jest) | **critical** removed | patch |
| `brace-expansion` (3 ranges) | 1.1.18→1.1.21, 2.1.4→2.1.7, 5.0.9→5.0.12 | transitive, dev-heavy | high removed | patch |
| `js-yaml` | 3.15.1→3.15.2, 4.3.1→4.3.2 | transitive | high → moderate | patch |
| added (8, all MIT, runtime scope) | `file-type` 20.4.1, `strtok3`, `token-types`, `@tokenizer/inflate`, `@tokenizer/token`, `fflate`, `@borewit/text-codec`, `uint8array-extras` | runtime | — | new runtime dependency surface from the `@nestjs/common` bump; licences checked in the lockfile (MIT) |
- **Remaining after T1.** One critical: `tar` (install-time only, via `bcrypt`'s `node-pre-gyp`; the fix is the `bcrypt` major — tier T2). The T2 majors (NestJS, bcrypt 6, react-router-dom 7, Jest 30) and the T3 acceptances stay unapproved.
- **Lockfile changes.** `package-lock.json` only; `package.json` untouched.
- **Rollback.** `git revert` of the single commit (or `git checkout <previous> -- package-lock.json` then `npm ci`); no data, schema or runtime-state effect; a deployed package built from the previous commit restores the old tree.
- **Test net required before the real commit is accepted.** Full CI on a clean snapshot (commit-pinned); the 91-spec isolation regression and the business suite on the dedicated cluster (the rehearsal did **not** run these); a clean-snapshot re-audit (runtime critical = 0 is the D-01 close condition); review of the lockfile diff by someone other than the person who applies it; the host proxy check.
- **Risks.** Low for patch bumps; the `file-type` addition changes the runtime dependency surface; runtime behaviour of upload handling (which uses Nest's file interceptors) should be exercised by the existing HTTP specs in the regression.
- **Dependencies.** None blocking except the approval; T2 needs the test net and an owner.
- **Recommendation.** Approve T1 exactly as rehearsed.
- **Approval required (exact).** *"DEC-20: approve a lockfile-only dependency change limited to the 22 version updates and 8 additions listed in `dependency-t1-rehearsal/rehearsal-result.json`, in one commit, followed by the test net above; `package.json`, T2 and T3 are not approved."* Signed by the CTO, who also names the owner of T2.

## DEC-25 — UUID repair versus the audit hash chain
- **Evidence.** Code trace (13 stages): the repair rewrites `audit_records.actorUserId` and `organizationId` — hash inputs — whenever a `users`/`org_units` primary key is rewritten; the pilot T-29 (disposable database, READ ONLY, in-memory simulation, repair never called) shows 4 of 7 rows would change a hash input and the chain would first break at seq 1. **No real database has been examined**; whether the repair ever ran is unknown. Full text: `DAII-PA43-WP-AUD-09-STATUS-2026-10-13.md`.
- **Options (the question's three handlings; the register documents none as chosen).** (1) exclude the two columns from the rewrite; (2) rewrite and re-anchor under a separately approved procedure; (3) forbid the repair on Companies whose audit rows reference non-compliant ids.
- **Risks.** Running the repair on an affected database permanently invalidates the chain's verification; any of (1)–(3) needs implementation and independent review.
- **Dependencies.** The read-only need check (role + database list, D1) → counts → final decision; DEC-02 for chains already affected.
- **Recommendation.** The evidence supports only the *interim* direction: keep the interim prohibition and authorise the read-only need check. It does **not** yet support choosing among (1)–(3).
- **Approval required (exact).** *"DEC-25: (a) the interim policy stands — no UUID repair on any path that rewrites hash-input fields of `audit_records`, no re-hash or normalisation of history; (b) the read-only need check of protocol `DAII-WP-AUD-09…` is authorised on the databases listed in an attached list, with the read-only role described in Annex A; (c) the final handling is decided after the counts."* Signed by the CTO and the security/audit owner, with the role and the database list attached.

## DEC-01b — functions for operator realignment of the audit sequence
- **Evidence.** Option B is directed and implemented (`4d4ed0d`); the writer refuses on lag and never realigns; T-28 12/12, T-26 3/3, regression 0 FAIL; the runbook's realignment template was rehearsed on disposable databases only. Function table, separation rule and the five preconditions: `DAII-DEC-01B-AND-DEC-02-AUDIT-CHAIN-DECISIONS-2026-10-13.md` §1.
- **Options.** The four functions are fixed by the owner's directive (executor, approver, independent reviewer, operations/escalation owner); who holds them is the open choice.
- **Risks.** Assigning a title can be mistaken for permission to act; the independent-reviewer function cannot be filled until an eligible reviewer exists; the runbook is an experimental scenario with virtual roles.
- **Dependencies.** Reviewer nomination (C10); WP-AUD-09/DEC-02 for any unexplained lag.
- **Recommendation.** Record the four functions and their separation now; assign holders when people exist; keep realignment prohibited until all five preconditions can be met.
- **Approval required (exact).** *"DEC-01b: the realignment functions `AUDIT_DB_OPERATOR`, `AUDIT_CHANGE_APPROVER`, `AUDIT_INDEPENDENT_REVIEWER`, `AUDIT_OPS_ESCALATION_OWNER` are held by <names>, three different people at least; this assignment grants no permission to realign any database; each realignment needs the five preconditions and a written approval naming the database."* Signed by the CTO.
