# DAII — Carried items: F-INV-001, D-04, dependency updates, capacity targets, staging host — status, missing inputs and next steps — 2026-10-13

For each item: current state · what is missing · what was executed here · test result · risk-register effect · inputs for the next stage. Statuses use `IMPLEMENTED / VERIFIED / INDEPENDENTLY ACCEPTED / BLOCKED / DEFERRED`; nothing is raised without evidence. No product code, manifest or lockfile was changed for these items.

## 1. F-INV-001 — `POST /api/inventory/movements` accepted non-receipt movement types
| | |
|---|---|
| State | **IMPLEMENTED** (`fc9282d`: non-receipt types answer `410 Gone` with a stable code and write nothing; unknown targets answer 404 before any write) · **VERIFIED locally**: T-09 36 PASS (E1–E14 incl. E3–E8 → 410 no trace), negative-stock pairs 0, closure-http-verification kept (report: `test-program/REMEDIATION-REPORT-2-F-INV-001-2026-10-10.md`) · **not independently accepted** · **release: BLOCKED** |
| Missing | The compatibility fact: whether any caller (a person or an integration with an API key) still posts non-receipt types. It can only be measured on real Company databases with a named, authorised read-only operator (DEC-10 / D-9) and, if they exist, request logs |
| Executed here | Re-ran the operator tool's offline test: `tools/ops/f-inv-001-usage-collect.test.js` 3/3 PASS (statements are SELECT/SHOW only, inside a read-only transaction, refusal when the session is not read-only). The tool was **not** run against any database (no authorisation) |
| Acceptance test for the release decision | frozen T-09 criteria (`test-program/F-INV-001-FINAL-CONTRACT-AND-T09-CRITERIA-2026-10-10.md` §4) must stay green; plus the operator's returned Q1–Q4 for every in-scope database, both periods, reviewed; release only if no live consumer exists or each is migrated, the request-log check shows no unknown caller, and the CTO approves in writing |
| Risk effect | Unchanged: the stock-integrity defect is closed locally; the release risk is "an unknown consumer breaks on 410". Rollback: removing the rejection restores the old behaviour, no data effect |
| Next inputs | DEC-10: operator name, window, list of databases; then `f-inv-001-usage-summarize.js` output → compatibility assessment → CTO decision |

## 2. D-04 — Integrations become Company-scoped
| | |
|---|---|
| State | Decision **D-04 = COMPANY-SCOPED** (CTO, 2026-10-11). Evidence record and implementation plan exist (`test-03/INTEGRATIONS-TENANCY-DECISION-RECORD-…`, `test-03/D-04-INTEGRATIONS-COMPANY-SCOPE-IMPLEMENTATION-PLAN-…`). **Implementation: not started and not authorised** (the plan is "awaiting review of the [REVIEW] items before implementation"). Status: **BLOCKED on authorisation and review**, not on engineering |
| Remaining scope (from the plan) | M1 additive `integration_connector_directory` table (core tag); M2 insert-only back-fill from existing connector rows, unresolved connectors reported, not guessed; M3 remove the ambient entity registration; `IntegrationAuthGuard` resolving the Company from the directory; `IntegrationsService` taking the Company manager and passing it to every domain call (two additive optional parameters); admin controller on `JwtAuthGuard` + `CompanyContextGuard` + a Company-level permission node; event fan-out with `{ scope: 'company' }`. No table moves, no data relocation |
| Verification conditions | 15 acceptance cases I-01…I-15 in the plan (note: its risk section says "eleven" — the table is the authority) on the two-Company harness; T-18 control-plane structure check PASS; a spec that runs with the control plane lacking Company tables; existing connectors migrated without credential loss; rollback documented |
| Owner | **not named** — the integrations module owner with the Area 21 / Authorization tracks (permission node and manifest change touch the authorization model); CTO authorises |
| Missing | Authorisation to implement; review of the plan's [REVIEW] items; the read-only pre-flight count of connector rows in each real installation's ambient/control-plane database (UNVERIFIED, needs the same class of operator as F-INV-001) |
| Executed here | Nothing beyond reading and confirming the plan against the current tree (the four integration tables are still created by the `sales` tag; the module still uses the ambient DataSource) |
| Risk effect | PA-20 / Area 21 §2.1 stays open: a connector credential has no Company boundary today; in a multi-Company installation the module cannot work as written |
| Next inputs | CTO authorisation + [REVIEW] answers; owner; operator pre-flight |

## 3. Dependency updates
| | |
|---|---|
| State | Inventory current: `npm audit` re-run read-only on 2026-10-13 returns **65 advisories (3 critical, 44 high, 14 moderate, 4 low)** — identical to 2026-10-11; `package.json` / `package-lock.json` hashes (`73bb2625…`, `9732d004…`) are unchanged since that audit, so `test-03/DEPENDENCY-AUDIT-D01-2026-10-11.md` still describes the manifests. 15 runtime-reachable packages, 50 dev-only. Frontend: 3 advisories |
| Approved changes | **None.** DEC-20 (per-package scope) is open; D-01 approved the audit only and forbids upgrades without a separate scoped change. Therefore **no update was applied** |
| Executed here | Tier T1 sized with `npm audit fix --dry-run` (nothing written; manifests verified unchanged afterwards): **22 version changes and 9 additions, 0 removals**, among them `proxy-addr` 2.0.7→2.0.8 (the critical one, runtime), `joi` 17.13.6→17.13.8, `@nestjs/common` 10.4.15→10.4.22, `js-yaml` 3.15.1→3.15.2 / 4.3.1→4.3.2, `handlebars` 4.7.9→4.7.10 (dev), several `brace-expansion` patch bumps; the 9 additions are a new `file-type` dependency chain and `fsevents`. These are patch-level inside the declared ranges |
| Risk of T1 | low for the patch bumps; one to review: the `@nestjs/common` bump appears to bring in the new `file-type` chain (extra runtime dependency surface; its licences and the origin of the chain are to be checked before approval) |
| Test net required if approved | clean-snapshot full CI + the 91-spec isolation regression + business suite T-00…T-29; re-audit from a clean snapshot (critical = 0 at runtime is the D-01 close condition for T1) |
| Tiers T2 (Nest 10→current, bcrypt 5→6, react-router-dom 6→7, Jest 29→30) and T3 | unchanged from D-01: planned project with owner and regression; T3 acceptances need a named owner |
| Missing | DEC-20 approval of the T1 list (this dry-run list is the proposed scope), an owner for T2, host confirmation that the reverse proxy does not rely on `trust proxy` (host access) |
| Risk effect | PA (dependency) rows stay open; no change |

## 4. Capacity targets
| | |
|---|---|
| State | **BLOCKED / DEFERRED.** T-16 figures are accepted as a **local baseline only** (decision D-03): ~31–39 req/s from 5 virtual users upward, p95 345 ms at 5 users to 5.8 s at a 60-user peak, on one 2-core machine hosting app, load generator and database. No target is approved, so nothing is classified PASS or FAIL |
| What is needed | The numeric targets must come from the business: the proposal (Profiles S/M: 50 and 200 concurrent users, write rates, p50/p95/p99, error and resource limits) is the agent's assumption set in `test-program/CAPACITY-DECISION-BRIEF-FOR-CTO-2026-10-11.md` §B–C — **proposed, not approved**; no number in it may be used as a requirement until signed |
| Measurement method | prepared and reproducible: `tools/testing/capacity-loadgen.js` with `capacity-profile.json`, topology table, integrity oracle SQL (`test-program/STAGING-CAPACITY-PROFILE-2026-10-11.md`); a run is valid only if the load generator stays below 60 % CPU |
| Environment that represents target use | a staging-like host (production process model, `NODE_ENV=production`, real pool settings) plus a **separate** load-generator machine; neither exists in the records |
| Owner | the CTO (DEC-11) for targets and the load-test authoriser (`CAPACITY_AUTHORISED_BY`) |
| Executed here | none (no unsupported number was invented; no load was run) |

## 5. Staging host
| | |
|---|---|
| State | **BLOCKED on external provisioning and approval.** No staging-like host, load-generator machine or named authoriser is recorded. The project's hosting gate still waits for an approved staging host (project note of 2026-10-06; unchanged) |
| Requirements | (1) a host that mirrors production topology and process model; (2) a separate load-generator machine; (3) a named person authorising load against it; (4) the release under test (version + migration state); (5) data profile; (6) the recorded topology table of the capacity profile; (7) for deployments: the release package, the approved host list and the owner who may run the engine (see the 1.1.x release notes in `_release-output/`) |
| Ownership | environment and authoriser: CTO (DEC-11); operator of the host: not named |
| External approvals blocking completion | host provisioning; authoriser name; capacity targets (item 4); no production or protected hosting is authorised for any test |
| Executed here | none |
| Next inputs | host details and authoriser name → run the prepared profile → re-report T-16 against the signed targets |

## 6. Summary
| Item | IMPLEMENTED | VERIFIED | INDEPENDENTLY ACCEPTED | BLOCKED / DEFERRED |
|---|---|---|---|---|
| F-INV-001 (410 contract) | yes (`fc9282d`) | locally (T-09 36 PASS) | no | release BLOCKED (DEC-10 usage measurement + CTO approval) |
| D-04 | no | — | — | BLOCKED (authorisation, review items, owner) |
| Dependency updates | no (none approved) | audit re-run only | — | BLOCKED on DEC-20 |
| Capacity targets | no | local baseline only | — | DEFERRED (targets unsigned) |
| Staging host | no | — | — | BLOCKED (external) |
