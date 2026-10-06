# LA-1 — Lifecycle Admission Boundary — Work Package definition

**Status:** **PACKAGE DECIDED / SPECIFICATION REQUIRED. Implementation: NOT AUTHORIZED (HOLD).** Created by the CTO ruling of 2026-10-05; resolves the D-3 × O-1 × O-3 tension without turning `CompanyContextGuard` into something larger than its function. This document defines scope and inputs only — it is **not** the specification and decides nothing about design.

## 1. Purpose (CTO)
Guarantee that **any path that wants to perform Company operational work cannot reach a Company DataSource or execute the operation without respecting the Company lifecycle policy.**

## 2. Architectural direction already decided (DP-9 record §2.2)
Layer 1 — `CompanyContextGuard` enforces `Company.status === READY` on Company-scoped HTTP operations. Layer 2 — any service/scheduler/infrastructure path that opens a Company DataSource passes a **Company lifecycle admission** appropriate to that path. Backup/DR is excluded **only** by its own explicit, independent policy. A "shared READY assertion" as an implementation is **not** authorized; it was an architectural direction only.

## 3. The specification must settle exactly six things (CTO)
| # | Item | The spec must answer |
|---|---|---|
| 1 | **Callers** | Which actors invoke admission: HTTP, services, schedulers, workers, infrastructure |
| 2 | **Operational classification** | What counts as Company operational work versus Control Plane / maintenance work |
| 3 | **Exceptions** | Backup and similar — each an **explicit policy**, never an implicit bypass |
| 4 | **Atomicity / race** | What happens between the status check and DataSource acquisition; how a TOCTOU gap is prevented so the READY check is not a cosmetic read |
| 5 | **Scheduled work** | A job scheduled while READY whose Company is `SUSPENDED` at execution time must refuse operational execution |
| 6 | **Backup separation** | Backup has its own proven access policy — not `if backup then bypass` |

## 4. Inputs gathered so far (evidence, not design)
- **Paths that open a Company DataSource outside the HTTP guard (VERIFIED by code read):** `company-membership-provisioning.service` (3 sites; reached by platform-admin membership routes), `installation-audit.controller`, `plans/company-package.service`, `plans/company-view-context.service` (foreign, unratified), `closing-snapshot-recovery.scheduler`, `preliminary-hold-expiry.scheduler`, `approval-expiry.scheduler`, `membership-reconciliation.scheduler`, `company-baseline-backup.scheduler`, and `events/company-event-dispatcher.scheduler` (foreign, unratified).
- **Provisional scheduler classification under O-1** (to be confirmed by the specification): baseline backup = Backup/DR (continues); closing-snapshot recovery, hold expiry, approval expiry, membership reconciliation, event dispatcher = operational (stop when not READY). Boundary question flagged earlier: closing-snapshot recovery modifies Company accounting data and is classed operational here.
- **Race-relevant fact (VERIFIED):** `CompanyContextGuard` reads Membership, then `getDataSource` (which checks registry status per call and returns a cached pooled DataSource); lifecycle status is a separate row read. Nothing joins status check and acquisition in one atomic step.
- **O-5 constraint:** no cache of lifecycle status on the authorization path.
- **R14 constraint:** no route may gain Company context while checking `core.*`/`system.*` nodes without reviewing the Company `admin` grants.
- **CD-1 interaction:** READY with a `FAILED` registry is never operationally READY (CD-1 policy); admission must treat the registry state accordingly.

## 5. Dependencies and gates
WP-0.4 (stable source) must be met first — LA-1 touches shared engines (guard, connection manager, schedulers). Area 21 remains an independent gate. Foreign work (Plans, Approval Engine, Event Engine) stays NEEDS RE-PROOF and is not a baseline.

## 6. Stop conditions
No code, migration or guard change; no shared READY assertion implementation; no implicit Backup bypass; no per-job status cache; no change to `CompanyContextGuard`'s scope beyond Layer 1.
