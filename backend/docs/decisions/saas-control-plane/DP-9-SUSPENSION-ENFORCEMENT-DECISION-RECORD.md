# DP-9 — Suspension Enforcement — Decision Record

**Record type:** Decision Record only. No code, migration, guard change, ADR number or schema is
created or changed by this document. **Date recorded:** 2026-10-05.
**Source of the decision:** CTO directive "DAII SaaS Control Plane — Long-Range Execution Plan &
Controlled Delivery Protocol", §2 (2026-10-05).

## 0. Classification (per CTO directive §7 — states are never merged)

| State | Value |
|---|---|
| VERIFIED (current behavior) | **Yes** — code path + real-PG runtime (7/7), see §3 |
| DECIDED | **Yes** — decisions D-1…D-7 below |
| AUTHORIZED (implementation) | **NO** — "Implementation Status: NOT AUTHORIZED" (WP-0.3 closed; WP-0.4 NOT MET; Lifecycle Admission package not yet defined) |
| IMPLEMENTED | No |
| REAL-PG / ISOLATION / REGRESSION VERIFIED (of the *fix*) | No — nothing exists to verify |
| DOCUMENTED | This record |
| PRODUCTION | HOLD |

The characterization spec (`src/foundation/company/company-suspension-access-path.characterization.spec.ts`)
is a **diagnostic evidence artifact only** (untracked, test-only). It is not a mandate to change
any guard or production path.

## 1. Decisions (CTO-approved, as issued)

| # | Decision |
|---|---|
| D-1 | `SUSPENDED` = full operational block. **No read-only mode in V1.** |
| D-2 | `DECOMMISSIONED` = full block. |
| D-3 | Enforcement = **Option A**: check `Company.status` inside `CompanyContextGuard`. |
| D-4 | `selectCompany` rejects any Company that is not `READY`. |
| D-5 | An already-issued JWT is blocked **immediately**, via a status check on every request. |
| D-6 | `refresh` does not return the Company claim when the Company is not `READY`. |
| D-7 | Option B is **not** adopted; `DatabaseRegistry` does not become a lifecycle authority. |

## 2. WP-0.3 — consequence items O-1…O-5: CTO rulings (2026-10-05) — DECIDED

| ID | Ruling (as issued) |
|---|---|
| O-1 Background jobs | Backup, Disaster Recovery and platform-level housekeeping **continue** while a Company is not READY. Any scheduled job that performs operational work or modifies Company data **stops** when the Company is not READY. Subscription/entitlement expiry sweeps may continue as **Control Plane** operations but must not bypass the operational block. Every job carries an explicit `companyId` and **re-checks status before executing**. One Company's job failure must not affect another Company. |
| O-2 HTTP error contract | **HTTP 409 Conflict**, stable code **`COMPANY_NOT_READY`**. No operation runs on the Company database; no internal infrastructure state and no other Company's data in the response. Front-end: stop the current operation, remove the invalid Company from the local operational context, return to the Company Selector, show a clear Arabic "Company currently unavailable" message, **no automatic retry** that could repeat a financial/operational action. The per-request check is the final authority, not UI state or JWT validity. |
| O-3 Platform Admin / Support | Platform-level administration routes stay available under their own permissions. **No implicit override** of the Company block for Platform Admin or Support: any operation that requires a Company DataSource obeys the READY condition. **No Support read-only bypass in V1.** Any future exception needs its own ADR/decision defining permissions, audit and scope. |
| O-4 READY-only semantics | The V1 operational condition is `Company.status === READY`. Every other status (`PROVISIONING`, `DEGRADED`, `SUSPENDED`, `MIGRATING`, `FAILED`, `DECOMMISSIONED`) disallows operational work, whether or not it is currently reachable. |
| O-5 Status caching | **No cache** of lifecycle status on the operational authorization path. Every request reads the current status from the Platform DB (one extra read per request accepted in V1). A stale status must never bypass Suspension/Decommission. Any later optimisation needs an independent architectural decision that preserves immediate revocation. |

**WP-0.3: CLOSED (all five items DECIDED). Implementation: NOT AUTHORIZED.**

### 2.1 Derived classification of existing schedulers under O-1 (PROPOSED — needs CTO confirmation of the boundary)

| Scheduler (VERIFIED by code read) | What it does | Class under O-1 | Result when Company not READY |
|---|---|---|---|
| `company-baseline-backup.scheduler` | Company baseline backup | Backup/DR | **continues** |
| `closing-snapshot-recovery.scheduler` | recovers interrupted closing snapshots in Company data | operational (modifies Company data) | stops |
| `preliminary-hold-expiry.scheduler` | expires sales-order holds | operational | stops |
| `approval-expiry.scheduler` | expires approval requests in Company DB | operational | stops |
| `membership-reconciliation.scheduler` | repairs Company role provisioning for memberships | operational (writes Company DB) | stops *(boundary to confirm)* |
| `company-event-dispatcher.scheduler` (foreign, unratified) | runs event handlers on Company data | operational | stops |

Boundary question for the CTO: is `closing-snapshot-recovery` "operational" (this table's reading) or housekeeping? It modifies Company accounting data, so it is classed operational here.

### 2.2 RECONCILIATION OF D-3 × O-1 × O-3 — CTO RULING (2026-10-05): two-layer boundary — DECIDED

The tension recorded earlier (D-3 puts the check in `CompanyContextGuard`; O-1/O-3 speak of every operation that opens a Company DataSource) is resolved by the CTO as follows. The earlier proposal of a single "shared READY assertion" is **rejected as an implementation proposal**; it survives only as an architectural direction.

| Layer | Enforcement point | Rule |
|---|---|---|
| **Layer 1 — Authorization / Request Context** | `CompanyContextGuard` (D-3, unchanged) | `Company.status === READY` for Company-scoped **HTTP** operations |
| **Layer 2 — Company DataSource Safety** | a **Company lifecycle admission check** appropriate to each non-HTTP path (service, scheduler, infrastructure) — *not* the HTTP guard | any path that wants to open a Company DataSource must pass admission and find `READY` before it does |
| **Backup/DR exception** | an **explicit Backup policy** (O-1: backup continues) | exempt from the READY operational block *only because* that exemption is its own explicit, independent decision |

```text
HTTP Request        → CompanyContextGuard            → READY → Company DataSource
Scheduler / Service → Company lifecycle admission    → READY → Company DataSource
Backup Job          → Explicit Backup Policy         →         Company DataSource
```

| Item | State |
|---|---|
| D-3 | **DECIDED** (HTTP enforcement point) |
| O-1 / O-3 | **DECIDED** |
| Two-layer boundary | **DECIDED — architectural direction** |
| "Shared READY assertion" as an implementation | **NOT AUTHORIZED** |
| WP-4.1 scope | expands to include a **Lifecycle Admission Boundary**; its implementation needs a **separate package** |

**The separate Lifecycle Admission package is now named LA-1 (`LA-1-LIFECYCLE-ADMISSION-BOUNDARY-PACKAGE.md`; PACKAGE DECIDED / SPECIFICATION REQUIRED / implementation HOLD) and must define (CTO list):** (1) who calls the admission check; (2) which operations count as *operational*; (3) the exceptions; (4) how a race between the status check and DataSource acquisition is prevented; (5) how schedulers treat a Company that became `SUSPENDED` after the job was scheduled; (6) how Backup is separated from operational access.

*Paths verified by code read that today open a Company DataSource outside the guard (inputs to that package, not a decision):* `company-membership-provisioning.service` (3 sites), `installation-audit.controller`, `plans/company-package.service`, `plans/company-view-context.service`, and the five schedulers listed in §2.1.

## 3. Evidence (VERIFIED)

- **Code path:** `CompanyActivationService.suspend()` writes only `companies.status`
  (`company-activation.service.ts`). The access path checks Membership (`CompanyContextGuard`,
  `AuthService.selectCompany`, `AuthService.refresh`) and the registry status (`getDataSource`
  refuses non-`ACTIVE`). `Company.status` is read only by `listVisible` and `memberships/mine`.
- **Runtime (real Postgres, disposable two-company databases, 7/7 PASS, 2026-10-05):** after
  `suspend()` the status is `SUSPENDED` and the registry stays `ACTIVE`; an already-issued token
  still reaches the Company database; `selectCompany` still issues a token; `refresh` keeps the
  Company claim. After `suspend() → decommission()` the status is `DECOMMISSIONED`, the registry
  stays `ACTIVE`, and access continues. Suspending Company A does not affect B. A registry status
  of `FAILED` refuses the connection (the only block that works today).
- **Tested source hashes (first 16 hex of sha256):** `company-context.guard.ts` `bb38b4e2d042d25c`;
  `auth.service.ts` `a729b3efade142be`; `jwt-auth.guard.ts` `d47f1d6a7168d295`;
  `company-activation.service.ts` `6e2d3223872bdc97`; `company-registry.service.ts`
  `8cb10ccff890ec61`; `company-connection-manager.service.ts` `6ca4212303f1c84f` (this file
  contains edits by another workstream — the proof tests only the pre-existing registry-status
  check); harness `6af6841dc480eed3`; spec `b45aa4e9007194e0`. Valid for those states only.
- **Reachability facts:** only four `transitionTo` call sites exist (suspend, reactivate,
  decommission, provisioning→READY), so `DEGRADED`/`MIGRATING`/`FAILED` are unreachable today and
  `DECOMMISSIONED` is reachable only from `SUSPENDED`.
- **Blast radius (VERIFIED by count):** 36 controllers use `CompanyContextGuard`. Any change to the
  guard affects all of them, including every controller Area 21 already closed.

## 4. Implementation implications (PROPOSED — informational, NOT an authorization)

When a Work Package for DP-9 is later authorized it will touch **shared engines**:
`CompanyContextGuard`, `AuthService.selectCompany`, `AuthService.refresh` (and a Company-status
read per request). Therefore it must be sequenced under the Area 21 gate: stable source state,
no concurrent foreign edits to those files, and re-proof of the controllers that depend on the
guard. The existing mechanism for a revoked Membership (`refresh` drops `companyId`) is the
in-repo precedent for D-6.

Known adjacent behaviors **not changed by DP-9** and tracked separately (see Blueprint, candidate
decision CD-1): `PROVISIONING → READY` is allowed through `reactivate`; a Company whose
provisioning failed stays `PROVISIONING` and is hidden from the Company list; decommissioning has
no data-retention or database-teardown logic.

## 5. Status line

**DP-9: DECIDED — DOCUMENTED — IMPLEMENTATION NOT AUTHORIZED.** Production: HOLD.
