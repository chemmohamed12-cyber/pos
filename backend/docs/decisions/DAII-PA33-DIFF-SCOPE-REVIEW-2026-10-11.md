# DAII — PA-33 (F-AUD-003) diff scope review — Team 3, 2026-10-11

Read-only review by Team 3 of the audit-chain remediation against the CTO's authorization (directive delivered in session `cece860d`, 2026-10-11T04:46Z, item 2) as narrowed by the CTO's later directive (confirmed only if the actual diff conforms). **This is a scope-conformity review, not an acceptance, not an independent closure review and not clean-snapshot verification.** No product code or test was changed or run by Team 3.

## 1. What was reviewed (exact state)
| Item | State |
|---|---|
| Commit | `c764fc5` (2026-10-11 13:27), authored by the verification session `cece860d` (shared git identity "DAII Workspace"); product file `src/foundation/audit/audit.service.ts` (+27/−9 net); tests `t23-audit-seq-hash.biz.real-pg.spec.ts` (new, 119 lines) and an extension of `f-aud-rollback-reproducer.biz.real-pg.spec.ts` (+7); T-22/T-23 evidence. **Separation caveat:** the `biz-run.js` step registration for T-23 was committed in `5c5b791` (the remaining-N-02 commit, together with T-24), not in `c764fc5`, so the PA-33 regression step cannot be run through the runner from `c764fc5` alone |
| Earlier state | Before the commit the same change was an **uncommitted working-tree diff** (file times 07:47–07:50 local; sha256 of the working-tree `audit.service.ts` then `83932b2a…`; the committed blob differs in bytes, `697918d4…`, so the committed version was reviewed, not the earlier one). A copy of the earlier diff was kept outside the repository for provenance |
| Commit timing | The commit was made before the CTO's scope-conformity condition was applied; it is recorded as such, not as an approval |
| Isolation from other changes | `c764fc5` contains no `limit.service`, `process-engine.service` or `inventory.service` change; those are the separate commit `5c5b791` (remaining N-02) with spec T-24 |
| Protected items | `audit-hash.ts` (hash function) unchanged; no guard file, `company-audit-access.real-pg.spec.ts`, LA-1 file or migration touched |

## 2. Conformity to the authorized conditions
| Condition (CTO directive) | Finding |
|---|---|
| Use the actual database sequence value for the hash and the stored record | **Conforms.** `nextval(pg_get_serial_sequence('audit_records','seq'))` is drawn under the existing chain advisory lock, used in `computeAuditHash`, and inserted explicitly as `seq` |
| Preserve the existing hash format | **Conforms.** `computeAuditHash` and its input fields are unchanged; the golden-vector case (T-23 H) passes |
| Do not rewrite or normalize historical rows | **Conforms.** The only write is `INSERT`; no `UPDATE`, `DELETE`, migration or repair; T-23 P2 shows an already-broken chain is preserved and still reported, with new rows linking to its tail. Existing broken chains remain untouched (DEC-02 open) |
| Regression coverage for rollback followed by a subsequent append | **Present.** T-23 R1 (rollback then append), R2 (multi-write rollback), C1 (40 concurrent appends), C2 (mixed commit/rollback), H, P1 (healthy chain continues), P2 (broken chain preserved); T-22 control and rollback cases plus the explicit-seq characterisation (case X) |
| Reproduce the failure before changing the implementation | **Present** (working-tree runs): T-23 before the change 4 FAIL-DEFECT + 3 PASS; T-22 reproducer; clean-snapshot reproduction of T-22 on `b591d1f` |
| Independent review and clean-snapshot verification before closure | **Not satisfied yet.** The evidence for T-22/T-23 is working-tree class; the verification track's clean-snapshot pipeline for the newer HEAD was not published at the time of this review; a *partial* peer review exists (`89a0a2a`: code review complete, database verification incomplete) whose reviewer wrote `runInTransaction` |
**Extra scope found:** none in product code. The test-only additions (T-22 case X, T-23 spec, `biz-run` registration) support the required reproduction and regression and are in scope. The sequence-lag guard (`GREATEST(nextval, max(seq)+1)`) mentioned by the peer review is **not implemented** (documented proposal only) and is not part of this diff.

## 3. `repo.save` versus `create` — why persistence remains correct
| Aspect | Before | After | Assessment |
|---|---|---|---|
| Insert | `repo.create(...)` then `repo.save(record)` (TypeORM INSERT; the supplied `seq` is **ignored**: T-22 case X requested 9000, stored 5) | one raw `INSERT` listing all 13 entity columns (`seq`, `timestamp`, `actorUserId`, `organizationId`, `action`, `resource`, `resourceId`, `result`, `correlationId`, `before`, `after`, `prevHash`, `hash`) with `seq` explicit | The column list equals the entity's 13 columns; nothing omitted |
| Value conversion | TypeORM drivers: `Date` for `timestamptz`, JSON text for `jsonb` | `Date` passed to the same `pg` driver; `before`/`after` passed as `JSON.stringify` with `::jsonb` casts; `null` stays `null` | Same driver path and same serialization; hash input still comes from `input.before ?? null`, as before |
| Generated values | Only `seq` is generated on the entity (`@PrimaryGeneratedColumn`); no `@CreateDateColumn`, version, default-expression or computed columns | `seq` now supplied explicitly from the same sequence | Nothing else generated, so nothing is lost |
| Hooks and side effects | `grep` of non-test sources finds **no** `@BeforeInsert`, `@AfterInsert`, `@AfterLoad`, `@BeforeUpdate`, `EntitySubscriberInterface`, `@EventSubscriber` or `subscribers:` configuration, and no column transformers | A raw insert bypasses TypeORM listeners and subscribers, but none exist | **Nothing is bypassed today.** If a listener, subscriber or transformer is ever added to `AuditRecord`, this raw insert will silently skip it (maintainability point) |
| Transaction and connection | `repo.save` on the manager `m` | `m.query` on the same manager `m` (the writer's transaction opened by `runInTransaction`) | Same connection and transaction; the advisory lock, the `nextval` draw and the insert are in one transaction |
| Return value | The saved entity (with the stored `seq`) | An in-memory entity built with `create(...)` carrying the same 13 values, **not** a re-read row | Equivalent field-for-field. Of 356 `audit.record(` call sites in non-test code none captures, returns or chains on the result (searched assignments, `return`, arrow returns, `.then`); five spec files call it without using the result. The signature (`Promise<AuditRecord>`) is unchanged |
| Ordering guarantee | `prevHash` read under the lock, `seq` predicted | `prevHash` read under the lock, `nextval` drawn after it under the same lock | Sequence order equals chain-link order |
| Gaps | A rolled-back insert burned a value the hash did not know about | A rolled-back transaction still burns a value, but the hash is now computed from the drawn value | Gaps are legitimate; `verifyChainOn` hashes the stored `seq` and follows `prevHash`, not contiguity |
| New failure mode | none | `audit.record` throws if `pg_get_serial_sequence` returns null | Loud and intentional; affects every audited operation if a database lacked the serial |

## 4. Residual points for the independent reviewer (not defects found by Team 3)
1. **Sequence-lag after import/restore** (peer review residual 2): if a database ever receives rows with explicit `seq` above the sequence's last value, `nextval` could return a value at or below an existing `seq`. No such writer exists in code; a guard is a CTO decision.
2. The raw `INSERT` must be kept in step with the entity if a column is added.
3. Two extra statements per audited write.
4. Historical broken chains are not repaired by this change (by design; DEC-02).
5. Evidence class: working-tree only until the clean-snapshot pipeline of the commit is published.

## 5. Disposition
- **Compliance with the prior authorization:** the committed diff conforms to the stated scope; no portion needs to be isolated or separately approved.
- **Status:** implemented and committed; **not accepted**. Closure still requires a clean-snapshot verification of the fix commit and an independent review by a reviewer who did not author the patch or the relevant transaction rule.
- **Provenance disclosure:** the Team 3 session did not author this change and did not commit it. (It did create commits `a798d9d` and `60b9bdf` at the user's instruction; see the planning documents.)
