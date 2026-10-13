# DAII — D-04 integrations, capacity targets and staging host: readiness, approvals and evidence needed — 2026-10-13

**Status: documentation only.** Nothing was implemented, no migration was written, no load was run. This document records how far each item can be taken without the required authorization, and what exactly is missing. Companion: `DAII-CARRIED-ITEMS-STATUS-2026-10-13.md`.

## 1. D-04 — Integrations become Company-scoped
**Decision on record:** COMPANY-SCOPED (CTO, 2026-10-11). **Implementation: not authorised.** Plan: `test-03/D-04-INTEGRATIONS-COMPANY-SCOPE-IMPLEMENTATION-PLAN-2026-10-11.md`.

**Plan re-checked against `a614a22` (read-only).** Still true: the four integration tables are created by the `sales` Company tag (`migrations/sales/1755846200000-CreateIntegrationTables.ts`); `integrations.module.ts` registers the four entities on the ambient DataSource (`TypeOrmModule.forFeature`, line 35); `IntegrationsService` uses the ambient `this.dataSource` (17 uses) and the intake guard uses it for connector and credential lookups; no `CompanyContextGuard` appears in the integrations controllers. So the plan's premise holds and its migration steps (M1 additive directory table, M2 insert-only back-fill, M3 remove the ambient registration) are unchanged.

**Open items the plan marks [REVIEW] — to be answered by the module owner and the CTO before any code:**
1. **Routing source.** Directory table in the control plane (planned) versus encoding the Company in the connector id (the plan rejects it: forgeable, no revocation). Confirm the directory.
2. **Back-fill marking.** Whether directory rows created by the M2 back-fill carry a `source` column so rollback deletes only its own rows.
3. **Unrouted connector behaviour (case I-12).** A connector whose directory row is missing: generic 401 at intake and "unrouted" in the admin view — confirm.
4. **Pre-flight fact (read-only, needs an operator).** Whether any real installation holds connector rows in its ambient/control-plane database. Counts only, per installation: `SELECT count(*) FROM integration_connectors; … integration_credentials; … integration_product_mappings; … integration_sync_logs;` (run in `BEGIN READ ONLY`; any non-zero count must be reviewed before M3). Not run: no operator or role (owner request D2).
5. **Authorization model change.** A Company-level permission node for integrations in the module manifest touches the authorization model — review with the Authorization and Area 21 owners.

**Verification conditions (from the plan):** 15 acceptance cases I-01…I-15 on the two-Company harness (the plan's prose says "eleven"; the table is the authority), T-18 control-plane structure check PASS, a spec that runs with the control plane lacking Company tables, existing connectors migrated without credential loss, rollback documented, partner-facing contract (headers/payload) unchanged.

**Owner:** `INTEGRATIONS_MODULE_OWNER` (unassigned), with `AUTHORIZATION_OWNER`. **Resume condition:** CTO authorisation + the [REVIEW] answers + an owner. **Meanwhile:** nothing in the product depends on this; the isolation risk (PA-20) stays recorded.

## 2. Capacity targets
**What is missing:** signed numeric targets. The only numbers on record are the agent's proposal (Profiles S and M: 50 and 200 concurrent users, write rates, p50/p95/p99, error and resource limits) in `test-program/CAPACITY-DECISION-BRIEF-FOR-CTO-2026-10-11.md`; they are assumptions, not requirements, and T-16 stays "not classified". No new number is introduced here.

| To approve | By | Evidence available for the decision |
|---|---|---|
| Workload assumptions (Companies per installation, users, write rate, mix, data volume) | `CAPACITY_APPROVER` (business owner with the CTO) | the brief's assumption table; business input is what is missing |
| Acceptance targets (latency, throughput, error rate, resource limits, hot-resource rate, recovery) | same | local baseline only: ~31–39 req/s plateau, p95 345 ms at 5 users to 5.8 s at a 60-user peak, one 2-core machine, app + load generator + database together |
| Measurement method | already prepared: `tools/testing/capacity-loadgen.js`, `capacity-profile.json`, integrity oracle SQL, topology table (`test-program/STAGING-CAPACITY-PROFILE-2026-10-11.md`); valid only if the load generator stays under 60 % CPU | — |
| Representative environment | see §3 | — |
**Resume condition:** signed targets + an authorised environment; then T-16 is re-reported PASS/FAIL per target.

## 3. Staging host
| Requirement | State | Owner (title) |
|---|---|---|
| A staging-like host with the production process model (`NODE_ENV=production`, real pool settings), and a PostgreSQL host with recorded configuration | not provided | `ENVIRONMENT_OWNER` |
| A **separate** load-generator machine | not provided | `ENVIRONMENT_OWNER` |
| A named person authorising load against it (`CAPACITY_AUTHORISED_BY`) | not named | `LOAD_TEST_AUTHORISER` (CTO to name) |
| The release under test (version + migration state) and the data profile | defined per run; the 1.1.x release packages exist in `_release-output/` (untracked) | release owner |
| Deployment rights on the host, and the approved host list for the release engine | not recorded; the project's hosting gate still waits for an approved staging host (project note 2026-10-06, unchanged) | `ENVIRONMENT_OWNER` |
**External approvals that block completion:** host provisioning, load authoriser, capacity targets (§2). No production or protected hosting is authorised for any test. **Resume condition:** all three present; then run the prepared profile and the isolation/restore drills that need a host (WP-REL-01).

## 4. Work that continues without these inputs
Documentation and contracts (Phase 0); the dependency rehearsal and the owner request; the LA-1 tracker; evidence reconciliation. These items do not block each other: D-04 needs authorisation and an owner; capacity and staging need the same environment owner but different approvals.
