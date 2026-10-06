# CD-1 — Architecture / Control Plane Risk Docket entry

**Status:** **DECIDED — policy (CTO 2026-10-05)**; was raised to the Architecture / Control Plane Risk Docket. Not an immediate-fix list and not mixed with DP-9.
**Sequence followed:** characterization (done) → unified lifecycle policy decision (done, below) → repair/recovery/retention packages (not defined, not authorized). **No code changes.**
Characterization is complete (WP-0.5d, REAL-PG VERIFIED on the isolated instance, anchor `ba5a16be…044f1`); see `WP-0.5-CHARACTERIZATION-RESULTS.md` §5 and `evidence/wp05d.recorded.json`.

> **CTO RULING 2026-10-05 — CD-1 = DECIDED — Lifecycle State Integrity (policy). Implementation / repair: NOT AUTHORIZED.** The table below remains the **VERIFIED CURRENT BEHAVIOR** (WP-0.5d); the policy below says what the behavior *must* be. Policy is separated from repair.
> 1. **Provisioning failure:** `Company.status = PROVISIONING` with `Registry.status = FAILED` is **not READY** and may not become READY by `reactivate`.
> 2. **Reactivation:** `reactivate` is a transition for a Company that *was operationally valid and then stopped*; it is **not** a recovery mechanism for failed provisioning. A failed-provisioning Company needs a separate **Recovery / Re-provisioning workflow** (not yet defined — a future package).
> 3. **READY invariant:** `Company.status = READY` with `Registry.status = FAILED` is **never an acceptable operational state** (it may exist transiently during failure handling but is not operationally READY).
> 4. **Decommission:** lifecycle state is separated from **Retention / Destruction policy**. `DECOMMISSIONED` = no operation. Database, credential and membership retention and any destruction schedule belong to a separate **Lifecycle Retention Policy** that is **not yet decided** (immediate deletion vs retention period). The characterized behavior (database/credentials/memberships remain) is current behavior, **not** a decision that it is the final behavior.
> Not authorized: any change to `company-status.ts`, `company-registry.service.ts`, `company-activation.service.ts`, `database-provisioning.service.ts` or the registry controller. Open follow-ups (no ruling yet): the Recovery/Re-provisioning workflow package; the Lifecycle Retention Policy.

| # | Topic | Actual behavior (executed) | Existing decision it rests on | Risk | Exposure today |
|---|---|---|---|---|---|
| CD-1.1 | **Provisioning failure state** | Company row stays `PROVISIONING`, registry `FAILED`; the Company is **hidden from `GET /installation/companies`** (`listVisible` excludes `PROVISIONING`) but found by id; service-level retry (`provision()` again) completes it; the HTTP create route always creates a *new* Company row, so there is no retry through the API or UI | Area 2: "a company is never visible before READY"; Area 4: retry-safe provisioning | An operator cannot see or recover a failed Company from the Control Plane; orphan rows and orphan databases accumulate; a SaaS provisioning flow (P3) would inherit this | any provisioning failure |
| CD-1.2 | **Reactivation bypass** | `reactivate()` accepts `PROVISIONING → READY`; the failed Company becomes `READY` **and is listed as visible** while its registry stays `FAILED`; access is still refused by the registry check (`CompanyDatabaseNotActiveError`) | Area 2/19 state table (explicit decision 2026-09-22) | A READY, listed Company with no usable database; the only barrier is the registry check that DP-9 rejected as a lifecycle authority; confusing for the Control Plane UI and for DP-5 state mapping | one `POST /:id/reactivate` call |
| CD-1.3 | **Decommission retention / teardown** | After suspend → decommission: physical database remains; registry row `ACTIVE`; encrypted credential retained; memberships retained; database still reachable through the connection manager | Area 2/19 ("a READY Company must pass through an intermediate state first"); DP-9 D-2 (full block, status-level) | No data-retention or deletion policy; DP-9 enforcement must not be read as data lifecycle; commercial/legal retention and deletion requirements undefined; credentials of decommissioned Companies persist | every decommissioned Company |

## Interactions with other decisions
- **DP-9 (decided):** D-2 blocks access at the status level; CD-1.3 shows nothing else happens on decommission. CD-1.2 interacts with O-4 (any non-READY status blocks) — a Company wrongly set READY by the bypass would pass the status gate and be stopped only by the registry check.
- **DP-5 (open):** subscription states map to Company status; CD-1.1/1.2 define which transitions are trustworthy.
- **Provisioning (P3):** a plan-driven create flow needs a defined failure state and recovery path.

## Questions for the unified lifecycle decision (not decided here)
1. Failure state: should a failed provisioning move the Company to `FAILED` (state exists, currently unreachable) and be visible to platform admins with a recovery action?
2. Should `PROVISIONING → READY` through `reactivate` remain legal, or only through the provisioning pipeline's own transition?
3. Decommission: retention period, data export, credential revocation, physical database teardown, and who may authorize deletion.

**Not changed:** `company-status.ts`, `company-registry.service.ts`, `company-activation.service.ts`, `database-provisioning.service.ts`, the registry controller. No production code is touched by this entry.
