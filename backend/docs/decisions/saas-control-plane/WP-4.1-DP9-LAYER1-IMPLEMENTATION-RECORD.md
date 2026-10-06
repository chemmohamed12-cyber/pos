# WP-4.1 — DP-9 Layer 1 Enforcement — Implementation Record

**Authorization:** CTO Executive Order 2026-10-06 (after WP-1.1 / WP-1.2 sign-off). Scope: **Layer 1 only** — HTTP → `CompanyContextGuard` → `Company.status` admission, `selectCompany`, `refresh`. No Layer 2, no Backup policy change, no Plans / Approval Engine / Event Engine / Area 21 / shared-engine work.
**Start point:** Execution Baseline `EB-WP04-20261005-155534` (pin `ab186f9f…e001b`), not the live tree. All proofs ran on a **baseline + delta copy** (`_wp41`), never on the live tree.
**Result:** Implementation VERIFIED · Real-PG PASS · Isolation PASS · Regression PASS (no regression attributable to WP-4.1; see §4) · Production HOLD.

## 1. Implementation Contract Check (once, before editing)
| File needed | Baseline vs live | Foreign-session status | Decision |
|---|---|---|---|
| `company-context.guard.ts` (hash `bb38b4e2d042d25c`) | identical | HISTORICAL / verified lineage | edit |
| `authentication/auth.service.ts` (`a729b3efade142be`) | identical | HISTORICAL | edit |
| `company/company-status.ts` | identical | **MIXED** (foreign writes) | **not edited** — the READY rule lives in a new file instead |
| `company.service.ts`, `membership.service.ts`, `company-connection-manager.service.ts` | identical | FOREIGN / MIXED | **read-only use** (existing `findById`, `findByUserAndCompany`, `getDataSource`) — no foreign copy was adopted as a solution |
| `authentication.module.ts`, `company.module.ts` | identical | FOREIGN | **not edited** — `CompanyService` is already exported by `CompanyModule` and `AuthenticationModule` already imports it |

No conflict prevented safe execution; no STOP was needed.

## 2. Change set (baseline hash → WP-4.1 hash, first 16 hex)
| File | Baseline | WP-4.1 | Change |
|---|---|---|---|
| `src/foundation/company/company-operational-status.ts` | NEW | `24fdb09148a88cfe` | `isCompanyOperational(status)` (READY only), `COMPANY_NOT_READY_CODE`, `CompanyNotReadyException` (HTTP 409, fixed body, no internal detail) |
| `src/foundation/company/company-context.guard.ts` | `bb38b4e2d042d25c` | `1729c512a83ae3a0` | after the Membership check and **before** `getDataSource`, read `Company.status` from the Platform DB on every request; non-READY → 409 `COMPANY_NOT_READY`; missing Company row → same rejection as a missing Membership |
| `src/foundation/authentication/auth.service.ts` | `a729b3efade142be` | `c147519f64472279` | `selectCompany`: Membership first, then 409 for any non-READY Company (no token signed/persisted). `refresh`: Company claim dropped when the Company is not READY or missing; the refresh itself succeeds and the family is **not** revoked |
| specs (updated for the new constructor arguments / extended) | | | `company-context.guard.spec.ts`, `auth.service.spec.ts`, `area5-…verification.spec.ts`, `area6-…acceptance.spec.ts`, `permission-path-…acceptance.spec.ts`, `provisioning-lifecycle.characterization.spec.ts` |
| `company-lifecycle-layer1.real-pg.spec.ts` | NEW | `0d3897cb6a484e63` | the Real-PG + A/B proof (§3) |
| `company-suspension-access-path.characterization.spec.ts` | `b45aa4e9007194e0` | REMOVED | WP-0.5 F1 characterization; it asserted the *pre-enforcement* behavior and is superseded by the proof above (its findings remain recorded in the DP-9 record §3) |

Design points: Membership is checked **before** status (a non-member never learns a Company's state); status is **never cached** (DP-9 O-5); `Company.status` is the only lifecycle authority — a non-ACTIVE registry stays a separate infrastructure refusal (DP-9 D-7, V-09a); the 409 body is the fixed object `{statusCode:409, error:'Conflict', code:'COMPANY_NOT_READY', message:'This Company is currently unavailable.'}`.

WP-4.1 proof copy: baseline `src` + the delta above + `dist` built from it. Manifest (`src` + `dist`, 3724 files) sha256 `f3b3efb211a256ccc14bee89b6cefd9a4645191d914847dee98e8cadee5daa2e`; live delta files are byte-identical to the copy. The immutable baseline was re-verified at the end (PIN HASH = FRESH HASH, 3752 files, 0 mismatches).

## 3. Verification
| Gate | Result |
|---|---|
| Static | `tsc --noEmit` on `src`: 0 errors; `tsc -p tsconfig.build.json` of the proof copy: 0 errors (2680 dist files); `eslint` on the 3 changed production files: clean |
| Unit / integration (mock-based) | `company-context.guard.spec`, `auth.service.spec`, `area5` verification, `area6` acceptance, `permission-path` acceptance: **5 suites / 51 tests PASS** (new cases: each of the 6 non-READY statuses for guard and `selectCompany`; refresh drops the claim for each non-READY status and a missing Company without revoking the family; membership-first; no cache; missing Company row) |
| **Real PostgreSQL** (isolated instance `127.0.0.1:5544`, disposable `daii_test_wp41_layer1_*` databases, real services, only the refresh-token repository is in-memory) | `company-lifecycle-layer1.real-pg.spec`: **10/10 PASS**; `provisioning-lifecycle` (WP-0.5d): 4/4 PASS. READY → allowed; SUSPENDED and DECOMMISSIONED → 409 for an already-issued JWT (blocked on the very next request), `selectCompany` rejected with no token persisted, `refresh` returns no Company claim and the resulting token cannot reach any Company route; PROVISIONING / DEGRADED / MIGRATING / FAILED → 409; reactivation restores access for the same token; registry non-ACTIVE while READY → infrastructure refusal, `Company.status` untouched |
| **Isolation (A/B)** | `getDataSource` is spied: for a non-READY Company it is **never called**; while A is SUSPENDED, B reaches only B's database (`current_database()` = B's) and `getDataSource` is called with B only; B's user learns nothing about A; the 409 body contains no status, Company id, database name or registry state |
| Residue | disposable databases dropped; `daii_test_wp41%` residue = 0 |

## 4. Regression
Full suite on the proof copy, isolated instance: **148 suites / 965 tests**; first pass 128 suites passed, 19 failed — **all environmental** (they need the seeded ambient database / `.env` / `tools/` that the bare copy lacked, or reference `daii_dev`). Re-run on a disposable seeded ambient database (`daii_test_wp41_ambient`, same recipe as `ISOLATED_TEST_ENVIRONMENT.md`) with `tools/` and the runtime configuration supplied: **20 of 22 suites pass; 1 skipped by design (`t0-clean-company-baseline`); 1 fails: `work-order-phase3-e2e` Items 6 and 12** (2 tests expecting "31 pre-existing rejected events" that exist only in the long-lived dev data). **The same two tests fail identically on the unmodified baseline copy**, so they are pre-existing, data-dependent and unrelated to WP-4.1. Nothing in the real Nest DI graph broke (the AppModule-booting ambient suites pass with `CompanyService` injected into the guard and `AuthService`). **Regression: no regression attributable to WP-4.1.**

## 5. What WP-4.1 does NOT do (open, for the next packages)
- **Layer 2 is untouched.** These paths still open a Company DataSource without Layer-1 admission: `company-membership-provisioning.service` (3 sites), `installation-audit.controller`, `plans/company-package.service`, `plans/company-view-context.service`, and the five schedulers listed in the DP-9 record §2.1. They are the input to LA-1.
- **Platform Admin / Support (O-3):** any route that obtains a Company DataSource through `CompanyContextGuard` is now READY-gated regardless of role; routes that open a Company DataSource without it are Layer-2 scope. V-07 is covered by construction, not by a dedicated test.
- **Front-end:** the Company Selector / error handling for `409 COMPANY_NOT_READY` (DP-9 O-2) is a front-end item; this record changes no front-end file.
- **Backup/DR** policy: unchanged.
- **Commit state:** while this work was in progress another session committed the whole working tree as `1517d81` ("integrity remediation wave …", 631 files), which swept in the WP-4.1 files. HEAD therefore moved from `4bb71f8`. The pinned baseline is unaffected (verified). This lane made no commit.

## 6. Status
```text
WP-4.1
Implementation: VERIFIED
Real-PG: PASS
Isolation: PASS
Regression: PASS (no regression attributable; 2 pre-existing data-dependent failures identical on baseline)
Documentation: UPDATED
Production: HOLD
```
Next in the CTO chain: **LA-1 Layer 2** (independent package).
