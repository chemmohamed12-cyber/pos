# DAII — consolidated request to `ENVIRONMENT_OWNER` — 2026-10-14

This is the single request for this role (generated from `DAII-FINAL-DECISION-AND-OWNER-REGISTER-2026-10-14.md`). The role is a title; the CTO assigns the person. Nothing below is approved or assumed; please answer by item ID. Official status is unchanged: N-02, PA-33, PA-43 OPEN · independent review PENDING · release NOT APPROVED.

| ID | Subject | Decision / resource / answer needed (exact) | Co-approver or counterpart | Evidence | Blocks | Status |
|---|---|---|---|---|---|---|
| E1 | Read-only role and explicit database list (resource D1) | Create the read-only role (CONNECT + SELECT on users, org_units, audit_records, data_repair_runs; read-only default; no write/DDL/superuser; expiring) and supply the list of databases (name, server, kind, no production data). | DBA | DAII-PA43-WP-AUD-09-STATUS-2026-10-13.md §4.2 | PA-43, DEC-02 inventory | PENDING |
| E2 | Staging host and load generator (resource D3) | Provide the staging-like host and a separate load-generator machine; record the topology. | LOAD_TEST_AUTHORISER | DAII-D04-AND-ENVIRONMENT-READINESS-2026-10-13.md | PA-24/26 | PENDING |
| E3 | T1 host proxy compatibility check | Perform H1–H5 of the protocol read-only and record PASS/FAIL/NOT DETERMINABLE with the exact source identity. | SECURITY_AND_DEPENDENCY_OWNER | DAII-T1-HOST-PROXY-CHECK-PROTOCOL-2026-10-14.md | T1 final acceptance | PENDING |

Other roles that need to act with you on an item are named in the "Co-approver or counterpart" column; counterpart items from other roles are not repeated here.
