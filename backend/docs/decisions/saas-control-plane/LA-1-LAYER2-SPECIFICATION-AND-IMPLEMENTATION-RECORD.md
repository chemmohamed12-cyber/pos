# LA-1 — Lifecycle Admission Boundary (Layer 2) — Specification and Implementation Record

**Authorization:** CTO Executive Order 2026-10-06 — implement LA-1 after WP-4.1, as an independent package, for non-HTTP operational paths, specifying: caller, operational classification, exception policy, status check, DataSource-acquisition race, scheduled work after suspension, Backup separation. No Layer-1 change, no Backup-policy change, no foreign work touched.
**Start point:** Execution Baseline `EB-WP04-20261005-155534` + the verified WP-4.1 delta (`WP-4.1-DP9-LAYER1-IMPLEMENTATION-RECORD.md`, proof-copy manifest `f3b3efb2…daa2e`). Proofs ran on a baseline + WP-4.1 + LA-1 copy, not on the live tree.
**Status:** **PARTIAL — mechanism and 3 editable sites VERIFIED; 7 sites BLOCKED by foreign-file conflicts (§4).** LA-1 is **not closed**: a path that opens a Company DataSource without admission still exists. Production HOLD.

*Specification choices below are implementation-level answers to the six items the CTO required; each is derived from DP-9 O-1…O-5, D-7 and the LA-1 package, and is listed for CTO confirmation, not as a new architecture decision.*

## 1. Specification (the six items)
| # | Item | Specification |
|---|---|---|
| 1 | **Callers** | Layer 2 applies to every non-HTTP-guard path that obtains a Company DataSource: schedulers/workers, services, and platform-admin routes that read a Company database. HTTP Company routes stay on Layer 1 (`CompanyContextGuard`, WP-4.1). |
| 2 | **Operational classification** | *Operational* = any read or write of data held in a Company database (business data or Company-DB-resident control data) performed through a Company DataSource. *Control Plane* = Platform-DB work (registry, `companies`, memberships table, installation, plan catalog); it is not gated by this boundary. Per DP-9 O-3 an operation that needs a Company DataSource obeys READY even when a platform admin triggers it. |
| 3 | **Exceptions** | None inside the admission function. The only exception is Backup/DR (item 6), expressed as a separate policy, not a flag. |
| 4 | **Atomicity / race** | The only way to obtain a Company DataSource under Layer 2 is `runOperationalAdmitted` (`company-lifecycle-admission.ts`). In one Platform-DB transaction it runs `SELECT status FROM companies WHERE id=$1 FOR SHARE` (no cache — O-5), refuses if not READY, otherwise acquires the DataSource and runs the work, holding the row lock until the work ends. `suspend()`/`decommission()` is an UPDATE of the same row, so it waits for in-flight admitted work; no admitted work starts after the flip commits and the flip becomes visible only after in-flight admitted work has finished. **Known residual:** a Layer-1 HTTP request reads status at the guard and its handler then runs without holding the lock; that window is bounded by one request and is not closed by LA-1 (closing it means holding the lock for the whole request — a separate decision). |
| 5 | **Scheduled work** | Each job re-checks admission per Company at execution time (O-1, N-09): a Company that was READY when the sweep list was built but is SUSPENDED/DECOMMISSIONED when its turn comes is skipped and logged; other Companies in the sweep are unaffected. |
| 6 | **Backup separation** | Backup/DR is not routed through admission and has no bypass flag. `CompanyBaselineBackupScheduler` does not acquire a Company DataSource through the connection manager (it calls `BackupManagerService`), uses the registry-based `listActiveCompanyIds`, and is unchanged. The existing behavior (backup continues while the Company is not READY, DP-9 O-1) is therefore preserved by not touching it; what Backup may do for a `DECOMMISSIONED` Company is a retention/CD-1 question and is **not decided here**. |

## 2. Path classification and wiring
| Path | Class | File status (WP-0.4 manifest) | Result |
|---|---|---|---|
| `preliminary-hold-expiry.scheduler` | Operational (expires holds in Company DB) | HISTORICAL / verified | **WIRED** |
| `approval-engine/approval-expiry.scheduler` | Operational | HISTORICAL / verified | **WIRED** |
| `audit/installation-audit.controller` | Operational (platform admin reads a Company DB; O-3: no override) → 409 `COMPANY_NOT_READY` | HISTORICAL / verified | **WIRED** |
| `company-baseline-backup.scheduler` | Backup/DR | HISTORICAL | unchanged by policy (item 6) |
| `accounting/closing-snapshot-recovery.scheduler` | Operational (modifies Company accounting data) | **FOREIGN / NEEDS RE-PROOF** | **BLOCKED** |
| `company/company-membership-provisioning.service` (3 sites) | Operational (writes Company DB role/grant rows) | **FOREIGN / NEEDS RE-PROOF** | **BLOCKED** |
| `company/membership-reconciliation.scheduler` | Operational | **FOREIGN / NEEDS RE-PROOF** | **BLOCKED** |
| `events/company-event-dispatcher.scheduler` | Operational | **FOREIGN / NEEDS RE-PROOF** (Event Engine) | **BLOCKED** |
| `plans/company-package.service` | Operational (reads Company DB) | **FOREIGN / NEEDS RE-PROOF** (Plans) | **BLOCKED** |
| `plans/company-view-context.service` | Operational | **FOREIGN / NEEDS RE-PROOF** (Plans) | **BLOCKED** |

Module files were not edited (`CompanyModule`, `DatabaseRegistryModule` are foreign): the admission is a plain function whose only extra dependency is the global Platform `DataSource`, injected into the edited classes.

## 3. Change set (baseline hash → LA-1 hash, first 16 hex)
| File | Baseline | LA-1 |
|---|---|---|
| `foundation/company/company-lifecycle-admission.ts` (NEW) | NEW | `c94e1947cc52d667` |
| `domains/sales-orders/application/preliminary-hold-expiry.scheduler.ts` | `cf83fcf71b1ce2c3` | `9afa861837b03df7` |
| `foundation/approval-engine/approval-expiry.scheduler.ts` | `7e63ce7f1809fe19` | `0ad538fbf337cf58` |
| `foundation/audit/installation-audit.controller.ts` | `55bcc65f384e4978` | `f7129ad1f8894b02` |
| specs: `preliminary-hold-expiry.scheduler.spec.ts`, `approval-expiry.scheduler.spec.ts`, `company-audit-access.real-pg.spec.ts` (updated) and `company-lifecycle-admission.real-pg.spec.ts` (NEW, `71b87af9d7e7e72f`) | | |

## 4. Foreign-file conflicts (REPORT FILE + CONFLICT; nothing edited)
For each blocked file the change is the same shape and is left to the owner/ratification lane: obtain the Company DataSource through `runOperationalAdmitted(platformDataSource, connections, companyId, work)` and treat `admitted:false` as "skip". Files: `closing-snapshot-recovery.scheduler.ts`, `company-membership-provisioning.service.ts` (3 sites), `membership-reconciliation.scheduler.ts`, `company-event-dispatcher.scheduler.ts`, `plans/company-package.service.ts`, `plans/company-view-context.service.ts`. Conflict: each is classified FOREIGN / NEEDS RE-PROOF in the pinned WP-0.4 ownership manifest and the CTO order forbids modifying Plans / Event Engine / foreign work. They are not needed to verify the mechanism and do not block the three wired sites. **Until they are wired, DP-9 O-1 is not fully enforced for them** (a suspended Company's membership operations, closing-snapshot recovery, event dispatch and Plans reads can still reach its database).

## 5. Verification (proof copy: baseline + WP-4.1 + LA-1; manifest `src`+`dist`, 3729 files, sha256 `cc1c6f11a88d6ece58cfc332d271a938b3828d8564fc7cd6a7d981325af2d66f`; live delta files byte-identical to the copy)
| Gate | Result |
|---|---|
| Static | `tsc --noEmit` on `src`: 0 errors; `tsc -p tsconfig.build.json` of the proof copy: 0 errors (2683 dist files) |
| Unit | `preliminary-hold-expiry.scheduler.spec`, `approval-expiry.scheduler.spec`: PASS, each with a new case (a non-READY Company is skipped, its DataSource never requested, the other Company still runs) |
| **Real PostgreSQL** (isolated instance 5544, disposable `daii_test_la1_*` databases) | `company-lifecycle-admission.real-pg.spec`: **13/13 PASS** — READY admitted (own database only); SUSPENDED / DECOMMISSIONED / PROVISIONING / DEGRADED / MIGRATING / FAILED / unknown id refused with the work not run and `getDataSource` never called; **race (V-08):** a `suspend()` issued during in-flight admitted work waits for it and commits only after it ends, nothing runs after the flip; work that throws releases the lock; **scheduled work (V-05):** the real `PreliminaryHoldExpiryScheduler` (Company suspended after the sweep list was built) and `ApprovalExpiryScheduler` (decommissioned Company) skip it and still sweep the other Company against its own database only; **Backup separation (V-06):** the registry-based sweep set Backup uses still contains a SUSPENDED Company (unchanged). `company-audit-access.real-pg.spec` (incl. the new platform-admin 409 case, no access event written): PASS |
| **Isolation (A/B)** | while A is not READY, B is admitted and reaches only B's database (`current_database()`), `getDataSource` is called with B only; verified for the helper and for both schedulers |
| Targeted total | 4 suites / 27 tests PASS |
| Regression | 149 suites (148 baseline + the new spec). Main phase 130 suites / 875 tests: 129 pass; the one failure (`release-migrations-endpoint`, `database "daii_dev" does not exist`) is environmental — it **passes 2/2** when run with the isolated ambient database configured. Ambient phase (disposable seeded `daii_test_la1_ambient`, serial) 19 suites / 111 tests: 17 pass, 1 skipped by design (`t0-clean-company-baseline`), 1 fails: `work-order-phase3-e2e` Items 6 and 12 — **the same two tests fail identically on the unmodified baseline** (they expect "31 pre-existing rejected events" present only in long-lived dev data). **No regression attributable to LA-1.** |
| Residue | disposable databases dropped; `daii_test_la1%` residue = 0; the immutable baseline re-verified (PIN HASH = FRESH HASH, 3752 files, 0 mismatches) |

## 6. Status
```text
LA-1 (Layer 2)
Mechanism: VERIFIED (Real-PG PASS, Isolation PASS, Regression PASS — no regression attributable)
Sites wired: 3 of 10 (preliminary-hold-expiry, approval-expiry, installation-audit)
Sites BLOCKED by foreign-file conflict: 7 (closing-snapshot-recovery, membership-provisioning x3, membership-reconciliation, event-dispatcher, plans x2)
Backup/DR: unchanged by policy
LA-1: NOT CLOSED — PARTIAL (foreign-file conflicts, §4)
Production: HOLD
```
**Not started:** DP-4 → DP-5 → DP-6 → DP-7. Per the Executive Order each package starts only after the previous one closes with proof; LA-1 cannot close while 7 paths remain un-admitted. HEAD of the live repository moved twice during this work (other sessions' commits `1517d81`, `5011691`); the pinned baseline is unaffected.

## 7. Decision requested from the CTO
Choose one for the 7 blocked files: (a) authorize an owner-coordinated wiring of those files (same one-call change, then re-proof), or (b) ratify them as re-proofed foreign work first, or (c) accept LA-1 as closed for the mechanism with the 7 paths recorded as an open risk against DP-9 O-1. Also confirm the §1 specification choices (lock-held admission, platform-admin audit read treated as operational per O-3, Backup unchanged and `DECOMMISSIONED`-backup left to CD-1).
