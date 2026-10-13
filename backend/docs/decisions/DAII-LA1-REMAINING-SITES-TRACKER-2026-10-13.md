# DAII — LA-1 Layer 2: the remaining unwired sites, tracked one by one — 2026-10-13

**Status: PA-41 OPEN. Nothing here changes code.** Source: code read at `a614a22` (every `getDataSource` call outside the HTTP guard), `LA-1-LAYER2-SPECIFICATION-AND-IMPLEMENTATION-RECORD.md` and the pattern `runOperationalAdmitted(platformDataSource, connections, companyId, work)` (`foundation/company/company-lifecycle-admission.ts`). Wired and verified earlier: preliminary-hold expiry, approval expiry, installation-audit controller; Backup/DR is excluded by explicit policy.

**Reconciliation of the count.** Earlier documents say "seven sites"; the code shows **6 files and 10 call sites** that open a Company DataSource without admission (the "seven" mixed files and call sites). This tracker counts call sites so each has its own closure line.

Owners are functional titles (none assigned; DEC-19). Common closure criterion for every row: *the call is made through the admission (or, for an HTTP path, the Layer-1 status check), a non-READY Company performs no operational work and opens no DataSource, a per-site real-Postgres A/B spec proves it, the 91-spec isolation regression still passes, and the change is made by the file's owner after the foreign-file conflict is cleared.*

| # | File : line | What it does with the Company database | Class | Proposed wiring | Per-site spec to add | Owner (title) |
|---|---|---|---|---|---|---|
| 1 | `domains/accounting/application/closing-snapshot-recovery.scheduler.ts:54` | writes: `retryPending`, `detectOverdue` per Company | Operational (scheduler) | wrap the per-Company body in `runOperationalAdmitted`; `admitted:false` → log + skip | sweep with A suspended after the list was built: A untouched, B swept | `ACCOUNTING_MODULE_OWNER` |
| 2 | `foundation/company/company-membership-provisioning.service.ts:52` (grant) | writes Company role rows | Operational (service) | admission around `provisionUserRoleForMembership` | grant to a non-READY Company is refused with 409; platform membership state per decision Q-L1 | `AUTHORIZATION_OWNER` |
| 3 | same file `:125` (revoke) | writes: removes Company role rows | Operational | **design question Q-L1** (below) before wiring | revoke while not READY: defined outcome, no half state | `AUTHORIZATION_OWNER` |
| 4 | same file `:192` (role change) | writes: one Company-DB transaction | Operational | admission around the transaction | role change refused when not READY, no "no-role window" | `AUTHORIZATION_OWNER` |
| 5 | `foundation/company/membership-reconciliation.scheduler.ts:80` (role-set mirror) | reads Company roles to heal the platform mirror | Operational (read) | admission per operation; non-READY → leave the operation pending (not failed) | mirror unchanged while A not READY; healed after READY | `AUTHORIZATION_OWNER` |
| 6 | same file `:94` (grant replay) | writes Company roles + Company audit in a transaction | Operational | admission around the transaction | replay deferred while not READY, applied after | `AUTHORIZATION_OWNER` |
| 7 | same file `:111` (retry grant/revoke) | writes Company roles/audit | Operational | admission | same | `AUTHORIZATION_OWNER` |
| 8 | `foundation/events/company-event-dispatcher.scheduler.ts:56` | writes outbox status and runs handlers via `dispatchPending` | Operational (scheduler) | admission per Company; backlog accumulates while not READY and drains after | not-READY Company: no event dispatched; READY Company unaffected | `EVENT_ENGINE_OWNER` (Event Engine is gated: separate approval) |
| 9 | `foundation/plans/company-package.service.ts:131` (`syncCompanyRoles`) | writes Company roles for package modules | Operational (control-plane-initiated) | admission; non-READY → `rolesSynced:false` with a reason, sync re-attempted when READY (**design question Q-L2**) | package assigned to a suspended Company: entitlement recorded, no Company-DB write | `PLANS_PACKAGES_OWNER` |
| 10 | `foundation/plans/company-view-context.service.ts:36` (`resolve`) | returns the Company manager for the current user's request | HTTP request path (read) | **Layer-1 style status check**, not the lock-holding admission (the manager outlives the call) — **design question Q-L3** | member of a SUSPENDED Company calling a view route gets 409 / no manager | `PLANS_PACKAGES_OWNER` |

## Design questions that must be answered before rows 2–10 are wired (not decided here)
- **Q-L1 — revoke and role change while a Company is not READY.** Today the platform membership is changed first and the Company-DB role rows are cleaned up after. If the cleanup is refused while not READY, access is already gone at Layer 1 (a non-READY Company admits nobody) and the role rows would be cleaned when the reconciliation scheduler retries after READY. Is that acceptable, or must a revoke always reach the Company DB? (DP-9 O-3 says every Company-DataSource operation obeys READY and gives no revoke exception.) Owner: `CTO` with `AUTHORIZATION_OWNER`.
- **Q-L2 — package assignment to a non-READY Company.** Entitlement lives in the platform DB, so assignment itself is a Control Plane operation and can continue; only the role sync is deferred. Is deferral with a later re-sync the intended behaviour? Owner: `PLANS_PACKAGES_OWNER`.
- **Q-L3 — the view-context path.** It serves HTTP requests of Company members and should follow Layer 1 (409 `COMPANY_NOT_READY`) rather than silently returning `null`. Owner: `CTO` with `PLANS_PACKAGES_OWNER`.

## What was verified for this tracker (and what was not)
Verified by reading the code at `a614a22`: the call sites, whether each reads or writes, and that none uses `runOperationalAdmitted`. Not run: any new test (nothing was changed). Each row's closure needs its own spec and the regression; the foreign-file rule applies (the files belong to other tracks and were classified FOREIGN / NEEDS RE-PROOF in the WP-0.4 manifest; they have since been committed in `1517d81`, which does not change their ownership classification).

Tracker status for all ten rows: `BLOCKED` — owner unassigned (DEC-19) and, for rows 3, 9, 10, an open design question.

## Appendix (2026-10-14): per-site behaviour, boundary and cases — documentation only, nothing wired
Today (all rows): the call opens the Company DataSource without admission, so a Company that is not READY (suspended, archived, restoring, migrating) can still be operated on by that path. Required (all rows): while the Company is READY the behaviour is unchanged (**allow case**); while it is not READY the site performs no operational work, opens no DataSource and leaves a defined, recoverable state (**deny case**); a Company in another state is never affected (**isolation case**: Company B sweeps/serves normally while A is suspended); the **lifecycle case** is the transition suspended→READY, after which deferred work is applied exactly once.
| # | Deny outcome required | Lifecycle case to test | Blocked by |
|---|---|---|---|
| 1 | skip A, log; B swept | A resumes → next sweep retries A | owner |
| 2 | 409 `COMPANY_NOT_READY`, no role row, no platform membership half-state | grant succeeds after READY | owner |
| 3 | per Q-L1 (defined outcome, no half state) | cleanup completed by reconciliation after READY | owner + Q-L1 |
| 4 | refused, role set unchanged (no "no-role window") | change succeeds after READY | owner + Q-L1 |
| 5 | mirror unchanged, operation stays pending | healed after READY | owner |
| 6 | replay deferred, not failed | applied once after READY | owner |
| 7 | retry deferred, not failed | applied once after READY | owner |
| 8 | no event dispatched, backlog accumulates | backlog drains after READY, no duplicate dispatch | owner + Event Engine approval |
| 9 | entitlement recorded, `rolesSynced:false` with reason, no Company-DB write | re-sync on READY | owner + Q-L2 |
| 10 | 409 `COMPANY_NOT_READY`, no manager returned | normal after READY | owner + Q-L3 |
Per-site regression = one real-Postgres A/B spec per row (positive, negative, isolation, lifecycle) plus the 92-spec isolation list. No guard is to be weakened; no site is to be wired before its owner and, where listed, its design answer exist (register C7/O6).
