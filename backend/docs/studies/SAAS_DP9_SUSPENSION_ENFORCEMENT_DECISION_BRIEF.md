# DP-9 Decision Brief — Suspension Enforcement

Part of: *DAII SaaS Control Plane & Tenant Lifecycle — Phase 0* (study commit `4bb71f8`).
**Status: DECISION BRIEF FOR CTO REVIEW. Not a decision. Not an authorization.**
No code, schema, migration, ADR, blueprint or existing decision (D1, Model B, ADR-073/074,
ADR-015/019, Area 21) is changed. **Nothing was run** — no HTTP call, no test, no database
query. Every VERIFIED mark below means "established by reading the cited source".
Governing rule: Evidence → Decision → Authorization → Code → Real-PG → Regression → Closure.

Classification: **VERIFIED** (source read) · **INFERRED** (follows from VERIFIED, not demonstrated)
· **NOT VERIFIED** · **PROPOSED** · **DECISION REQUIRED**.

## 0. Evidence-integrity caveat (read first)

The Multi-Company code this brief relies on is **not in committed history**: at the time of
reading, `backend/src/foundation/company/` and `backend/src/foundation/database-registry/` are
untracked, and `auth.service.ts`, `auth.controller.ts`, `jwt-auth.guard.ts`,
`refresh-token.entity.ts`, `limit.service.ts` carry uncommitted modifications from another
session. "VERIFIED" therefore means *the working tree as read on 2026-10-04*; it can move
under us. The files named in §1 are the exact evidence base.

## 1. VERIFIED evidence

| # | Fact | Source |
|---|---|---|
| E1 | `suspend()` / `reactivate()` / `decommission()` only call `transitionTo`, which only updates `companies.status`. No other side effect. | `company-activation.service.ts`, `company-registry.service.ts:42-51` |
| E2 | The only callers of `transitionTo` are `CompanyActivationService` and the last step of provisioning (→ READY). Nothing sets DEGRADED, MIGRATING or FAILED. | grep over non-spec `src` |
| E3 | `CompanyContextGuard` checks (a) a `companyId` claim exists, (b) a `Membership` exists for (user, company), (c) `connections.getDataSource(companyId)` succeeds. It does not read `Company.status`. | `company-context.guard.ts` |
| E4 | `getDataSource` reads the `DatabaseRegistry` row on **every call** (no status caching) and refuses unless `registry.status === 'ACTIVE'`; only the DataSource object is cached. A registry-status change therefore takes effect on the next request. | `company-connection-manager.service.ts:54-83` |
| E5 | `DatabaseRegistry.markStatus` is called only inside provisioning (`FAILED` on error, `ACTIVE` at the end, immediately before the Company is moved to READY). No caller sets it on suspend or decommission. `status` is a free `varchar(16)`; the entity says its allowed values "are NOT defined here". | `database-provisioning.service.ts:167-265`, `database-registry.entity.ts` |
| E6 | `Company.status` is read only by `listVisible` (hides PROVISIONING) and echoed by `GET /memberships/mine` (the Company-selector feed). Nothing in the access path reads it. | `company-registry.service.ts:37-39`, `memberships-mine.controller.ts` |
| E7 | `AuthService.selectCompany` checks Membership only. `refresh` re-checks Membership and drops `companyId` from the new token if the Membership is gone; it does not look at Company status. Access tokens carry `companyId` as a claim (transport only). | `auth.service.ts` (working tree) |
| E8 | Only **30 of 64** controllers apply `CompanyContextGuard` inside `@UseGuards(...)`. The other 34 run on the ambient (platform) DataSource with no Company context — platform surfaces (auth, admin, entitlement, limits, control plane) **and** the not-yet-retrofitted domain controllers (e.g. hr, attendance, payroll, commission, target, ap, ar, cash-bank, invoices, returns, sales). | grep of `UseGuards(...CompanyContextGuard` |
| E9 | Five recurring jobs sweep `listActiveCompanyIds()` (= registry rows with status `ACTIVE`): event dispatcher, closing-snapshot recovery, baseline backup, approval expiry, preliminary-hold expiry. The baseline-backup scheduler documents that it "never touches `CompanyStatus`". `membership-reconciliation.scheduler.ts` also uses the connection manager but does **not** call `listActiveCompanyIds()`; how it enumerates Companies was not established (NOT VERIFIED). | `grep listActiveCompanyIds()` over non-spec `src`; scheduler doc comments |
| E10 | `CompanyMembershipProvisioningService` obtains the Company DataSource through `getDataSource` at three call sites (grant / revoke / change role). | `company-membership-provisioning.service.ts:52,125,192` |
| E11 | `CompanyDatabaseNotActiveError` and `CompanyDatabaseNotProvisionedError` extend plain `Error`; no mapping to an HTTP exception exists in the codebase; a global `@Catch()` filter exists. | grep; `all-exceptions.filter.ts` |
| E12 | `company-context.guard.spec.ts` has a test whose mocked rejection text is `"…database is 'SUSPENDED', not 'ACTIVE'"` — a fixture, not behavior. | spec line 69 |
| E13 | The state machine forbids `READY → DECOMMISSIONED`; `reactivate` is allowed from PROVISIONING (documented in the P0 control-plane doc as a known hazard). Control-plane lifecycle actions were verified live for *state transitions only*. | `company-status.ts`; `P0-MULTI-COMPANY-CONTROL-PLANE-API.md` §§154-172, 237 |
| E14 | `/installation/companies/:id/memberships*` and the Company registry routes are guarded by `JwtAuthGuard + RolesGuard + @RequireRole('admin')` with an explicit company id — not by `CompanyContextGuard`. | controllers' own doc comments |

## 2. What is established vs. what still needs proof (F1, re-stated)

| Claim | Level |
|---|---|
| No `Company.status` check exists on any request path that goes through `CompanyContextGuard`. | **VERIFIED** (code path) |
| A SUSPENDED Company's member can still pass the guard and operate. | **INFERRED** — not demonstrated |
| Actual behavior over HTTP and against a database. | **NOT VERIFIED** |
| `decommission()` has the same absence of effect on access. | **VERIFIED at code-path level only** (same `transitionTo`); its *intended* semantics (retention, database disposal, irreversibility) are **NOT analysed** and are a separate decision (§7) |
| The registry `ACTIVE` gate also stops a PROVISIONING company from being used (it flips to ACTIVE just before READY). | **VERIFIED** (E5) — an existing protection that any option must keep |

## 3. Read-only / test-only proof design (not executed; needs authorization)

Goal: convert the INFERRED/NOT VERIFIED rows into evidence **without touching the dev database's
existing data**.

- **Where:** the existing `setUpTwoCompanyHarness` (`foundation/testing/two-company-real-pg-harness.ts`)
  creates two **disposable** Postgres databases (names carry a test-unique prefix), runs the real
  migration/role-seeding/registry/connection-manager sequence, and is already the program's standard
  isolation fixture. It reads `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD` (defaults: localhost:5433, `daii`).
- **Why authorization is needed:** it issues `CREATE DATABASE` on the shared dev Postgres server
  (the `CREATEDB` privilege) and drops the databases afterwards. It does **not** read or write the
  existing Company data, but it is an action on shared infrastructure.
- **Form:** prefer a throw-away script in the session scratchpad (not committed, no repo file) that
  imports the harness and the real services; a committed spec is a separate, explicit choice.
- **Cases (all against the real, unmodified services):**
  1. READY Company A, member M → `CompanyContextGuard` passes (baseline).
  2. `CompanyActivationService.suspend(A)` → re-run the guard for M → record pass/fail.
  3. Same state → `AuthService.selectCompany(M, A)` and a `refresh` of an A-scoped token → record.
  4. Same state → `listActiveCompanyIds()` contains A? (background-job exposure).
  5. Same state → `CompanyMembershipProvisioningService` revoke/grant for A → record (platform-operator path).
  6. Separately: `suspend → decommission` → repeat 2–5 and record **independently** (never assume Suspend's result applies).
  7. Company B (READY) is unaffected throughout; all of A's calls use A's DataSource only.
- **Expected outcome if F1 is real:** cases 2–3 succeed after suspension. A passing proof of *non*-enforcement is
  the evidence the CTO needs; it is read-only with respect to production data.
- **Not included:** any HTTP-level test against the running dev server on existing Companies.

## 4. Options (as defined in the study) — comparison

Common to all options: the registry `ACTIVE` check (E4/E5) **stays**; no option may replace it.

| Dimension | **A** — guard also checks `Company.status` | **B** — suspend also marks `DatabaseRegistry` non-ACTIVE | **C** — both |
|---|---|---|---|
| Mechanism | `CompanyContextGuard` reads Company status per request; `selectCompany`/`refresh` also check | `suspend()` writes registry status; reactivate must restore it | A + B |
| Takes effect | Next request (E3, per-request) | Next request (E4) | Next request |
| Request path coverage | The 30 Company-scoped controllers (E8) | Same 30 (via `getDataSource`) | Same 30 |
| The 34 ambient controllers | **Not covered** — no Company context exists there | **Not covered** | **Not covered** |
| Background jobs (E9) | **Unaffected** (jobs keep running for a suspended Company) | **Stop** — the 5 `listActiveCompanyIds()` sweeps skip it (event dispatch, closing-snapshot recovery, baseline backup, approval expiry, hold expiry); membership reconciliation: NOT VERIFIED | Stop |
| Platform-operator membership management (E10) | Unaffected | **Breaks by code reading** — grant/revoke needs `getDataSource` of a non-ACTIVE registry | Breaks |
| Company audit / backup access during suspension | Unaffected | Blocked | Blocked |
| Error the client sees | A clear, explicit refusal (new `ForbiddenException`-class error) | Plain `Error` → likely generic 500 via the global filter (E11) — NOT VERIFIED at runtime | Mixed |
| Couples commercial state to DB health? | No | **Yes** — registry `status` is an unvalidated free string meaning "database is reachable/healthy" | Yes |
| Shared files that change | `company-context.guard.ts`, `auth.service.ts` (both uncommitted, owned by the Multi-Company session) | `company-activation.service.ts` (+ reactivation restore, + reconciliation of the free-form status) | all |
| Area 21 impact | Changes a guard that 30 closed/retrofitted controllers depend on → closed-controller re-proof; additive and fail-closed | No guard change, but silently alters every scheduler's sweep set — an Event/Config/Approval-adjacent behavior change | both |
| Reversibility | Remove the check | Must restore registry status exactly; a missed restore leaves the Company dead | both |

INFERRED design intent: E12 suggests the original authors expected a "SUSPENDED" database state to surface
through the registry (Option B's shape). It is a test fixture, not a decision, and nothing writes it.

## 5. Policy sub-decisions (DECISION REQUIRED, independent of A/B/C)

1. **Which Company statuses allow access?** (PROPOSED: allow-list `READY` only — fail-closed.) Nothing in code sets
   DEGRADED/MIGRATING/FAILED today (E2), so the question is moot now but must be answered before any setter exists.
2. **Full Block vs Read-only during SUSPENDED.**
   - Mechanism for read-only is available in principle (the guard sees `request.method`), but there is no existing
     read/write *mode* concept (PermissionGuard's read-only/editable is per-role, not per-company-state).
   - NOT VERIFIED: that every `GET` route is side-effect free (exports, report generation, snapshot reads).
   - PROPOSED: **Full Block** of Company-scoped business routes for v1; Read-only as a later, separately authorized
     enhancement after a GET-purity audit.
3. **Select Company.** PROPOSED: `selectCompany` refuses a non-READY Company with an explicit message (mirrors the
   existing "fail a revoked Company context fast" rule). `GET /memberships/mine` keeps listing it with its `status`
   (already exposed) so the selector can show "Suspended".
4. **Existing tokens / refresh.** With A the per-request check makes already-issued access tokens ineffective on the
   next Company-scoped request regardless of the access-token TTL (`JWT_ACCESS_TTL_SECONDS`, value not read here).
   PROPOSED: `refresh` drops `companyId` when the Company is no longer READY, exactly as it already does for a revoked
   Membership.
5. **Background jobs during suspension.** DECISION REQUIRED per job class: backups (PROPOSED: keep running) and
   membership reconciliation (enumeration not established — confirm first), event dispatch / expiry sweeps (policy question: should a suspended tenant's workflows
   advance?). Option A leaves all running; B stops all — the choice should be explicit, not a side effect.
6. **The 34 ambient controllers.** No option reaches them. Whether a suspended Company is "suspended" while ambient
   routes exist is an Area 21 question, not solvable inside DP-9.

## 6. Risks

- **Isolation:** none introduced by A (additive, fail-closed). B/C change which Companies background jobs touch.
- **Security:** A must not trust the JWT `companyId` for the status lookup (it must use the already-validated
  company id from the guard). Today's guard already treats the claim as transport only.
- **Operational:** B can strand a suspended Company (cannot revoke members, cannot back up) — the opposite of what
  suspension needs.
- **Regression:** touching a shared guard obliges re-proof of the retrofitted controllers that use it.
- **Evidence:** the underlying files are uncommitted and under concurrent edit (§0).

## 7. Suspend vs. Decommission (kept separate)

This brief decides nothing about Decommission. Facts: reachable only from DEGRADED/SUSPENDED/MIGRATING/FAILED;
`transitionTo` only; no database disposal, retention, export, credential revocation or membership cleanup exists.
PROPOSED: treat it as **DP-9b**, a separate decision. Minimum coupling to DP-9: whichever status allow-list is chosen
(§5.1) already excludes DECOMMISSIONED from access.

## 8. Backward compatibility

- Existing Companies are READY; an allow-list of READY changes nothing for them.
- A Company mid-provisioning stays blocked (also today, via registry status).
- No data or schema change in A. B changes the meaning of an existing free-form column.
- On-prem: unaffected — the Company model and Control Plane are SaaS-side concepts here; no external connectivity added.

## 9. Recommendation (PROPOSED — reviewable, not an authorization)

**Option A**, with: allow-list `READY`; Full Block of Company-scoped business routes; refusal in `selectCompany`;
`companyId` dropped on `refresh`; background jobs and platform-operator routes unchanged unless separately ruled.
Reasons: effective on the next request; explicit client error; no coupling of commercial state to database health;
keeps backup/audit/membership-revocation available while suspended; leaves the free-form registry status untouched.
It is not complete (E8: 34 ambient controllers) and must be described as such.

Rejected for v1: **B** (breaks platform-operator membership management and halts backups by code reading; opaque
error) and **C** (inherits B's side effects).

## 10. Explicit CTO rulings required

1. Is the F1 premise to be confirmed by the §3 proof before any code decision? (Recommended: yes.)
2. Authorize the §3 proof (disposable databases on the dev Postgres server; scratchpad script; no repo file)?
3. Select A / B / C / other.
4. Access policy: Full Block vs Read-only (and the GET-purity audit if Read-only).
5. Allow-list vs deny-list of Company statuses.
6. Background-job policy per job class.
7. Whether Decommission is split into DP-9b.
8. The change boundary next to Area 21: may `CompanyContextGuard` and `AuthService` be edited for this, given they carry
   uncommitted work from another session and 30 controllers depend on the guard?

## 11. Stop conditions

- Any edit to `CompanyContextGuard`, `AuthService`, `DatabaseRegistry*`, `CompanyActivationService` before an explicit
  per-file authorization.
- Any test run against existing Company data or production without a separate authorization.
- Treating the §3 result for Suspend as covering Decommission.
- Choosing B or C without an explicit ruling on background jobs and platform-operator membership management.
- Treating DP-9 as complete while the 34 ambient controllers are outside any Company boundary.

## 12. Files read (read-only)

`foundation/company/{company-activation.service,company-registry.service,company-status,company-context.guard,
company-context.guard.spec,memberships-mine.controller,company-membership-provisioning.service}.ts` ·
`foundation/database-registry/{company-connection-manager.service,database-registry.entity}.ts` ·
`foundation/database-provisioning/database-provisioning.service.ts` ·
`foundation/authentication/{auth.service,jwt-auth.guard}.ts` ·
`foundation/events/company-event-dispatcher.scheduler.ts` · `foundation/release/company-baseline-backup.scheduler.ts` ·
`domains/accounting/application/closing-snapshot-recovery.scheduler.ts` (grep line only) · `domains/sales-orders/application/preliminary-hold-expiry.scheduler.ts` (grep line only) · `foundation/approval-engine/approval-expiry.scheduler.ts` (grep line only) ·
`foundation/error-contract/all-exceptions.filter.ts` · `foundation/testing/two-company-real-pg-harness.ts` ·
`backend/docs/decisions/P0-MULTI-COMPANY-CONTROL-PLANE-API.md`.
