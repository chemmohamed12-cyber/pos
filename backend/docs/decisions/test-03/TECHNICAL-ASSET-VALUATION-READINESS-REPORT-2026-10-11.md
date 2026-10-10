# TEST-03 — Software Forensics & Engineering Due Diligence
## Technical Asset Valuation Readiness Report — DAII

Date: 2026-10-11 · Assessed commit: `e9be53a` (HEAD) · Assessor: the DAII verification agent · Status vocabulary: **PASS · FAIL · RISK · UNVERIFIED · NOT ASSESSED · NOT YET IMPLEMENTED**. Evidence class per finding: **VERIFIED** (reproducible command/test/file), **INFERRED** (reasoned from verified facts), **UNVERIFIED** (not tested).
Rules kept: no product code changed; protected baseline and LA-1 untouched; no production/hosting access; no credentials in evidence; nothing deployed; no remediation implemented. This is an assessment of the software asset only — it is not a capacity test (TEST-01), not an adversarial business-integrity test (TEST-02), and **not a financial valuation**.
Reproducibility: every number below comes from a script under `backend/tools/assessment/` (read-only), a preserved log/JSON under `backend/docs/decisions/test-03/evidence/`, or a named test run (`backend/docs/decisions/evidence-2026-10-10-biz/`). Authorship is never inferred from code style.

---
## 1. Executive assessment
DAII is a **coherent, deliberately structured and well-documented modular monolith** (NestJS/TypeORM/PostgreSQL, database-per-Company) of ~81 k lines of production TypeScript in 681 files, 288 forward-only migrations in 13 tags, 75 controllers / 616 routes, 212 spec files and 50 ADRs. It builds and passes its unit suite from a clean checkout, and its migrations reproduce the schema its entities expect. Its isolation, reconciliation and concurrency behaviour is now backed by an unusually strong real-PostgreSQL harness.

It is **not yet a handover-ready asset**, for reasons that are about the asset, not about functionality:
1. **The governing documents are outside the repository** (`MASTER_ARCHITECTURE.md`, `MASTER_HANDOVER.md`, `LOCAL_DEVELOPMENT.md`, `planning/stage-2/`, `architecture/`, the governance doc linked by the README all live in the parent folder, which is not under version control). A team that receives the Git repository alone cannot follow its own README.
2. **There is no CI/automation, and the project's own lint gate currently fails** (138 errors; the 37 in production code are unused variables; the 64 architectural-boundary errors are all in test/spec support code — 63 in the harness files added by this verification program, 1 in an uncommitted LA-1 spec).
3. **The test suite did not catch the defects that matter most.** Four P0 concurrency/scope defects (audit-chain fork, treasury overdraft, payment over-application, unrestricted stock-movement endpoint) and a duplicate-effect idempotency gap survived 120 database-backed specs and were found only by purpose-written concurrent reproducers in this program. The same "join the caller's manager" idiom is still present in two more shared primitives, and a probe on the live customer-creation path shows 108 of 120 concurrent requests failing (N-01, §6, T-17) — this assessment found it, no existing test did.
4. **Provenance is thin:** one generic committer identity, history starting 2026-09-18, ~2,900 tracked files that are duplicate trees/backups, uncommitted work from other tracks in the working tree.
5. **Licensing posture is undefined:** `UNLICENSED`/private, no LICENSE file, three runtime dependencies with undeclared licenses (all MIT upstream, to be confirmed).
Strengths worth stating plainly: strict TypeScript, forward-only migrations with no `synchronize`, a documented decision trail, published inter-module contracts, bcrypt + hashed rotating refresh tokens, global validation, a repeatable guarded test environment, and reproducible clean builds.

## 2. Architecture and module-boundary map
Evidence: `evidence/arch-graph.json`, `evidence/cross-domain-imports.json` (scripts `arch-graph.js`, `cross-domain-imports.js`); `npm run validate:structure` → "no violations found".
- **Shape:** 23 business domains (`src/domains/*`, each domain/application/infrastructure/interface) on 38 platform capabilities (`src/foundation/*`, plus its test-support folder). Largest modules: accounting 15.8 k LOC, release engine 7.4 k, procurement 4.5 k, module-registry 4.2 k, company 3.9 k, inventory-warehouse 3.8 k.
- **Published contracts:** 11 contract files in `foundation/module-registry/contracts` (sales, inventory, finance/treasury, AP/AR/GRNI events, tax, logistics, WIP) used with injection tokens.
- **Domain-to-domain coupling:** 79 direct cross-domain imports in production code: 57 are NestJS module wiring (expected), **19 are concrete service-to-service imports that bypass contracts** (e.g. `payroll → hr/attendance/commission`, `returns → shipment/delivery`, `sales-orders → crm/commerce`, `customer-finance → treasury`, `procurement → inventory-warehouse`, `manufacturing → inventory-warehouse`). The project's own ESLint boundary rule cannot see them (its header discloses that relative same-level imports are not matched).
- **Layering inversions:** `foundation/database-registry` imports 21 domain entity files (the Company entity registry) and `foundation/integrations` imports four domain services — the platform depends on business modules for registration.
- **Cycles:** module level — one large strongly-connected component containing essentially every module (through the `database` / `foundation/company` hubs); file level — only 2 cycles, the largest of 4 files. So coupling is concentrated, not tangled at file level.
- **Controllers vs Company context:** 72 of 75 controllers reference `JwtAuthGuard`; the exceptions are by design (health, partner order intake with `IntegrationAuthGuard`, public terminology). Four JWT controllers use neither `CompanyContextGuard` nor a platform guard (`company-invitations-public`, `integrations` — the documented Area 21 open item —, `media`, `navigation`): INFERRED, to be reviewed by hand.

## 3. Verified findings, severity-ranked
Severity = engineering/business impact if left as is. "Reproduce" = the command or test that re-verifies it.

| ID | Axis | Finding | Class | Severity | Reproduce |
|---|---|---|---|---|---|
| H-01 | Handover | Master architecture/handover/dev-setup/governance documents and `planning/` live outside the Git repository (`daii.xnexustech.com/`, not a repo); `backend/README.md` links (`../LOCAL_DEVELOPMENT.md`, `../docs/…`, `../planning/…`) are dangling in a clean checkout | VERIFIED | **High** | `git ls-files` + `ls ..` from `release-new` |
| Q-01 | Tests | Four P0 defects + one idempotency gap + HTTP 500-vs-404 survived 120 database-backed specs; found only by concurrent plain-manager reproducers (F-AUD-002, F-TRS-001, F-PAY-001, F-INV-001, T-06x) | VERIFIED | **High** | reproducers in `foundation/testing/f-*-reproducer*`, T-05/T-08/T-09 history in `REMEDIATION-REPORT-*` |
| N-01 | Code/Concurrency | `NumberingService.getNextNumber` and `ProcessEngineService.transition` rely on `SELECT … FOR UPDATE` but join the caller's manager without opening a transaction; with the plain manager that controllers pass, the lock is released at once. Verified at primitive level (duplicate numbers; 8/8 identical concurrent transitions accepted) and on the live `createCustomer` path (**12 of 120 concurrent creates succeeded, 108 returned unique-violation errors**). 55 of 119 call sites have no transaction opener nearby (INFERRED reach) | VERIFIED (mechanism + 1 path) / INFERRED (reach) | **High** | T-17 (`f-plain-probes.biz.real-pg.spec.ts`), `callsite-transaction-scan.js` |
| Q-02 | Code | Same "join the caller's manager without checking for an active transaction" idiom remains in 11 places (guarded idiom in 10); the three that mattered for money (audit chain, treasury, payment application) were fixed in this program; the numbering/process-engine primitives are N-01 | VERIFIED (count) | **Medium–High** | `code-metrics.js` → `plainManagerJoinIdiom` |
| C-01 | CI | No CI/automation configuration of any kind in the repository (no `.github`, `.gitlab-ci`, Jenkins, etc.); `npm run lint` exits non-zero (138 errors) | VERIFIED | **Medium–High** | `ls -a`; `npm run lint` |
| A-01 | Architecture | 19 concrete cross-domain service imports bypass the published contracts and are invisible to the lint rule | VERIFIED | **Medium** | `cross-domain-imports.js` |
| D-03 | Data | Integration tables are created only by the `sales` Company migration tag but `IntegrationsService` uses the ambient (control-plane) DataSource, whose database has no such tables (T-18: 4 CREATE TABLE statements pending) — corroborates the open Area 21 item "integrations ×4" | VERIFIED | **Medium** | `T-18` (`test03-schema-drift.biz.real-pg.spec.ts`) |
| P-02 | Provenance | ~2,900 of 5,087 tracked files are duplicate/backup trees (`backend.prev-*` 1,529; `backend/_deploy` 790 incl. staging copy of the code; frontend backup 103; plus built release zips in history) | VERIFIED | **Medium** | `git ls-files | cut -d/ -f1-2 | sort | uniq -c` |
| P-01 | Provenance | 180 commits by a single generic identity ("DAII Workspace"), 2026-09-18 → 2026-10-10; no earlier history; per-person or AI/human attribution is impossible | VERIFIED | **Medium** (for diligence) | `git log --format=%an | sort | uniq -c` |
| P-03 | Provenance | The working tree carries uncommitted changes of other tracks (7 modified tracked files, 3 untracked LA-1 files); HEAD does not equal what runs locally | VERIFIED | **Medium** | `git status` |
| L-01 | IP | Project is `UNLICENSED`/private with no LICENSE file; ownership/licensing terms are not stated in the repository | VERIFIED | **Medium** (commercial) | `license-scan.js` |
| S-04 | Security | Dependency vulnerability status **not assessed** (no network audit was performed); 22 deprecated packages in the lockfile (old `glob`, `uuid`, `fstream`, `inflight`, `are-we-there-yet`, ESLint 9.39.5) | UNVERIFIED / VERIFIED (deprecations) | **Medium** | `npm audit` (needs authorised network); lockfile scan |
| D-02 | Data | 737 index/constraint-name differences between entity metadata and hand-written migrations (naming only) — `migration:generate` would emit noise; 2 default-value differences (`accounting_closing_audit_runs.exceptions`, `sales_orders.repSequenceNumber`) | VERIFIED | Low–Medium | `T-18` |
| D-04 | Data | 36 platform tables (users, companies, plans, releases, backups, …) are created inside every Company database by the shared `core` migration set | VERIFIED (existence) / INFERRED (unused) | Low–Medium | `T-18` `tablesWithoutEntity` |
| D-05 | Data | 14 migration timestamps shared by two migrations (10 across tags); 9 migrations have an empty `down()`; 3 contain destructive statements in `up()` | VERIFIED | Low | `migration-scan.js` |
| C-02 | Code | Large services: `inventory.service` 1,755 LOC, `release-execution.service` 1,669, `shipment.service` 1,455, `sales-orders.service` 1,267, `treasury.service` 1,056; 25 files > 500 LOC | VERIFIED | Low–Medium | `code-metrics.js` |
| C-03 | Code | Type-safety escapes: 14 `any`, 3 `as any`, 36 `as never`, 39 `as unknown as`, 259 non-null assertions, 275 raw `.query(` calls, 41 advisory-lock sites; strict TS on, 0 `@ts-ignore`, 5 `eslint-disable`, 4 TODO | VERIFIED | Low–Medium | `code-metrics.js` |
| Q-03 | Tests | 42 service/controller classes (e.g. `release-execution.service` 1,669 LOC, `integrations.service`, `treasury.controller`, `auth.controller`, `payroll.controller`) are not referenced by any spec by name; 11 more only by mock-based specs. Name-based, so INFERRED (release engine is exercised by tools outside `src/`) | INFERRED | Medium | `test-reference-map.js` |
| Q-04 | Tests | 74 of 212 specs build services with inert `{} as never` collaborators; the HTTP-level capacity fixture exposed one (treasury READ endpoints failed until a real scope resolver was supplied) | VERIFIED | Low–Medium | `test-reference-map.js`; T-16 run history |
| S-03 | Security | No `helmet`, no CORS middleware, no CSP/HSTS in the app (documented as proxy/same-origin design: AUDIT-SEC-15/26); the host proxy configuration is unverified | VERIFIED (code) / UNVERIFIED (host) | Low–Medium | `src/main.ts`, `core-config-keys.ts` |
| S-05 | Security | Migration CLI data source falls back to a development password if `DB_PASSWORD` is unset (`src/database/data-source.ts:26`); the runtime schema forbids it in production | VERIFIED | Low | read file |
| B-03 | Build | `tsc --noEmit -p tsconfig.json` reports an error inside the tracked staging copy (`_deploy/…/RepairNonCompliantUuids.ts`, missing `../uuid-repair.core`) because `tsconfig.json` includes `_deploy`; `tsconfig.build.json` excludes it so the build is unaffected | VERIFIED | Low | `npx tsc --noEmit -p tsconfig.json` |
| L-02 | IP | Runtime licenses: MIT 274, ISC 60, BSD 16, Apache-2.0 6, BlueOak 4, 0BSD 1…; no GPL/AGPL-only runtime package; `jszip` is "MIT OR GPL-3.0" (MIT selectable); `buffers`, `busboy`, `streamsearch` declare no license field (MIT upstream — to be confirmed); frontend dev-only `lightningcss` MPL-2.0 (not shipped) | VERIFIED (declarations) | Low (legal opinion needed) | `license-scan.js` |

Strengths (VERIFIED): strict TypeScript; no `synchronize`; consistent forward-only migrations (288, no name/timestamp mismatch); 616 routes with 378 explicit permission decorators; bcrypt and hashed, family-rotated refresh tokens; global `ValidationPipe` (whitelist, forbidNonWhitelisted); throttler 300/min global; secrets scan of tracked files (private-key/token patterns) found nothing; Company schema reproduces entity metadata with **0 missing tables/columns/types** across 144 entities.

## 4. Technical-debt register (remediation priorities)
| # | Item | Impact | Effort | Priority |
|---|---|---|---|---|
| 1 | Bring the governing documents into the repository (or publish a docs repo) and fix README links; add a "start here" index | Handover blocker | S | **P0** |
| 2 | Add CI: install, build, lint, unit mode, guard tests, and a nightly real-PG regression on the dedicated cluster; make `npm run lint` pass (allow-list test-support boundary imports, fix 37 unused vars) | Prevents regressions the suite cannot see today | M | **P0** |
| 3 | Treat the transaction idiom as a platform rule: a single helper `runInTransaction(manager, dataSource, fn)` (join only an active transaction) used by every primitive; adopt the T-17 results (§6) | Removes the class of defect behind 4 P0s | M | **P0/P1** |
| 4 | Add concurrency + HTTP-level specs (plain manager, parallel callers) for every primitive with advisory locks (41 sites) | Closes the escape path Q-01 | M | P1 |
| 5 | Replace the 19 concrete cross-domain imports with contracts; replace the ESLint rule by a resolved-path-aware one (e.g. `eslint-plugin-boundaries`) | Coupling visibility | M | P1 |
| 6 | Decide the Integrations module's tenancy: Company-scoped (move to Company routing) or Platform-scoped (move its migrations to `core`) — resolves D-03 | Data-model integrity | M | P1 |
| 7 | Repository hygiene: remove tracked duplicate trees/backups/zips from the working branch (keep history), exclude `_deploy` from `tsconfig.json`, commit or park the uncommitted tracks | Provenance, diff noise | S | P1 |
| 8 | Authorised dependency audit (`npm audit` + license review of the three undeclared packages) and plan to replace unmaintained transitive packages (exceljs → fstream/glob) | Security/IP | S–M | P1 |
| 9 | Split the 5 largest services along their existing seams; reduce `as never`/`as unknown as` | Maintainability | L | P2 |
| 10 | Normalise index/constraint names (one migration) so `migration:generate` is clean; unify migration timestamp ties | Tooling hygiene | S | P2 |
| 11 | Decide LICENSE/ownership notice and the distribution model | Commercial | S (+legal) | P2 |

## 5. Security, dependency and licensing findings
Threat-model sketch (trust boundaries): (1) Internet → reverse proxy → Node (TLS/headers/CORS delegated to the proxy — UNVERIFIED at host); (2) authenticated user → controller (JWT → PermissionGuard/`RequirePermission` → Company context → warehouse scope) — VERIFIED by isolation specs and the T-09/T-16 HTTP runs; (3) partner → order-intake endpoint (`IntegrationAuthGuard`, no Company binding on the connector entity — documented open item); (4) Node → per-Company PostgreSQL (credentials encrypted by `DatabaseCredentialCipherService`); (5) release/deploy pipeline (high-privilege service; two production incidents on record in project memory — not re-assessed here).
Company isolation: VERIFIED for the domains with isolation specs (results §8) and by the two-Company HTTP benchmark; the isolation failure found in this program (F-INV-001) was a scope bypass, now closed locally (410 change not released).
Not assessed: external penetration test, secrets in the host environment, proxy hardening, backup encryption.

## 6. Test effectiveness and coverage gaps
- Isolation run (operational result): 75 harness/real-Postgres isolation specs executed and passed (16 + 59), 1 skipped (opt-in T0 baseline), 0 failed — `ISOLATION-RUN-60-FINAL-REPORT-2026-10-11.md`.
- 212 specs: 120 database-backed (harness/real PG), 34 mock-heavy, 74 using inert stubs (overlapping sets). Reference map: 166 of 219 service/controller classes are referenced by a database-backed spec, 11 only by mock specs, 42 by none (by name).
- What the suite does well: Company isolation, reconciliation, approvals, release-registry logic. What it misses (VERIFIED by escape): concurrency with a plain `EntityManager`, HTTP-level behaviour, replay/idempotency under parallel requests, 404-vs-500 contracts, and cross-module financial invariants (R1–R10 existed only as a program-built oracle).
- Program-built additions now in place: guarded dedicated cluster; business-test harness T-00…T-18; reconciliation oracle R1–R10; capacity benchmark T-16; namespace path that runs the historical isolation specs under the guard.
- **T-17 plain-manager probes** (same idiom, two more shared primitives and one production path), evidence `evidence-2026-10-10-biz/T-17/T-17-20261010T214646Z-4d1886/`, spec `foundation/testing/f-plain-probes.biz.real-pg.spec.ts`:

| Probe | Plain manager (as controllers pass it) | Inside `manager.transaction` |
|---|---|---|
| `NumberingService.getNextNumber`, 10 rounds × 20 concurrent calls | **FAIL-DEFECT**: duplicate numbers in 10/10 rounds; the counter ended at 30 after 200 calls (expected 200) | PASS: no duplicate, counter 200 |
| `ProcessEngineService.transition`, 15 rounds × 8 identical concurrent `go` requests (legal maximum 2) | **FAIL-DEFECT**: 8 of 8 succeeded in 14/15 rounds (5 in the first), history rows duplicated | PASS: exactly 2 per round |
| **Production path** `CustomersService.createCustomer(dto, user, req.companyContext.dataSource.manager)` (exact controller call shape), 8 rounds × 15 concurrent | **FAIL-DEFECT**: **12 of 120 succeeded; 108 failed with a unique-violation (SQLSTATE 23505, surfaced to a client as HTTP 500)** — codes are drawn from a counter whose lock is not held | PASS: 120/120 |

Static reach (INFERRED, `evidence/callsite-transaction-scan.json`): 55 of 119 production call sites of `getNextNumber`/`transition` have no transaction opener in the preceding 80 lines (29 of 43 numbering calls, 26 of 72 process-engine calls) — e.g. customers, price lists, sales orders, shipments, returns, purchase orders, supplier ledger, payroll, fulfillment, warehouse transactions. Whether each is reached with a plain manager must be confirmed per path; the probes prove the mechanism and one live path. **New finding N-01 (VERIFIED, High):** concurrent creation endpoints can fail or duplicate state transitions today; T-01…T-16 did not exercise these paths. Remediation is proposed, not implemented (roadmap R3).

## 7. Clean-build and migration reproducibility (executed)
`git archive HEAD backend` into a fresh folder inside the project root → `npm ci --offline` (907 packages from the local npm cache, 50 s, 22 deprecation warnings, no network used) → `npm run build` (nest build, 58 s, 977 JS files, 0 errors) → `npm run test:unit` (59/59 suites, 430 tests, 195 s) — logs `evidence/clean-build-*.log`. No `.env` was needed. Migrations: a fresh Company database migrated with `core` + all 12 domain tags (T-18) and the dozens of harness runs of this program all started from empty databases. The clean folder was removed after the logs were preserved.
Not assessed (reason): starting the built app against a fresh database and `migration:run:prod`/rollback (needs an approved boot path under the guard), Docker compose, backup/restore drill, frontend build (`frontend/` has its own lockfile, 73 packages).

## 8. Implemented vs not-yet-implemented capability matrix
| Domain | Code state | Controllers / routes | Services | Entities | Specs | DB-backed isolation specs (last recorded run) |
|---|---|---|---|---|---|---|
| accounting | implemented | 10 / 119 | 34 | 31 | 28 | 16/17 PASS, 1 NOT RUN |
| attendance | implemented | 1 / 21 | 1 | 8 | 3 | PASS (1) |
| commerce | implemented | 3 / 27 | 3 | 5 | 3 | PASS (3) |
| commission | implemented | 1 / 10 | 1 | 5 | 2 | PASS (1) |
| crm | implemented | 1 / 13 | 1 | 2 | 1 | PASS (1) |
| customer-finance | implemented | 3 / 18 | 3 | 4 | 4 | PASS (4) |
| delivery | implemented | 1 / 7 | 1 | 2 | 1 | PASS (1) |
| deposit-control | implemented | 1 / 5 | 1 | 1 | 1 | PASS (1) |
| fulfillment | implemented | 1 / 16 | 1 | 4 | 1 | PASS (1) |
| hr | implemented | 1 / 16 | 1 | 3 | 2 | PASS (1) |
| inventory-valuation | implemented | 1 / 1 | 2 | 2 | 1 | PASS (1) |
| inventory-warehouse | implemented | 2 / 32 | 2 | 6 | 4 | PASS (3) |
| manufacturing | implemented | 4 / 30 | 4 | 6 | 5 | PASS (3) |
| payroll | implemented | 1 / 16 | 1 | 8 | 3 | PASS (1) |
| procurement | implemented | 8 / 49 | 11 | 19 | 13 | PASS (11) |
| reports | implemented | 1 / 12 | 2 | 0 | 1 | PASS (1) |
| returns | implemented | 3 / 23 | 5 | 7 | 4 | PASS (4) |
| sales | implemented | 1 / 2 | 1 | 1 | 1 | PASS (1) |
| sales-orders | implemented | 1 / 9 | 1 | 2 | 2 | PASS (1) |
| shipment | implemented | 1 / 24 | 1 | 5 | 1 | PASS (1) |
| targets | implemented | 1 / 4 | 1 | 1 | 1 | PASS (1) |
| tracking | NOT YET IMPLEMENTED | 0 / 0 | 0 | 0 | 0 | no DB-backed spec |
| treasury | implemented | 1 / 11 | 1 | 3 | 2 | PASS (2) |

"Code state" is judged only from the presence of controller + service code (`tools/assessment/capability-matrix.js`); "DB-backed isolation specs" are the real-PostgreSQL specs under each domain and the last recorded run (`run-logs/regression-1…3.log`, `ISOLATION-RUN-60-FINAL-REPORT-2026-10-11.md`). This matrix shows **what exists and what was exercised**, not functional completeness against a specification (no specification is in the repository — see H-01).

Notes: `tracking` contains only a `README.md` → **NOT YET IMPLEMENTED** (no PASS is awarded). `inventory-valuation` exposes a single route and is exercised mostly through inventory and accounting. The one NOT RUN accounting spec is the opt-in T0 baseline.

**Platform capabilities — verification state (this program's evidence)**

| Capability | Implemented | Verified by | Status |
|---|---|---|---|
| Audit hash chain | yes | T-03/T-13 concurrency, reconciliation, 12+ runs | **PASS** (after the fix in this program) |
| Treasury balances / withdrawals | yes | T-05, T-14, T-16 oracle | **PASS** (after fix) |
| Payment recording / application / idempotency | yes | T-06/06y/08, T-16 probe | **PASS** (after fix) |
| Stock movement endpoint scope | yes | T-09 (410/404 contract) | **PASS locally; compatibility of the 410 change UNVERIFIED** |
| Company isolation | yes | 75 isolation specs, T-01…T-16 | **PASS** for specified scenarios |
| Document numbering | yes | T-17 | **FAIL under concurrency with a plain manager** (N-01) |
| Process engine (state transitions) | yes | T-17 | **FAIL under concurrency with a plain manager** (N-01) |
| Event outbox dispatch | yes | T-15/T-16, code review | **PASS functional; high-volume UNVERIFIED** |
| Authorization / permissions / scope | yes | T-09 HTTP, isolation specs | **PASS** for specified scenarios |
| Release engine (deploy, rollback, backups) | yes | unit + registry specs; production incidents on record | **NOT ASSESSED here** (largest un-referenced service, 1,669 LOC); registry spec BLOCKED by configuration |
| Integrations (partner order intake, connectors) | yes | none by name | **RISK** — tenancy mismatch D-03, no spec reference |
| Frontend (React/Vite, 181 files) | yes | built bundle consumed; not assessed | **NOT ASSESSED** |
| Tracking domain | no (README only) | — | **NOT YET IMPLEMENTED** |

## 9. Independent-team handover assessment
Positive: 112 decision documents and 50 ADRs inside the repository (`backend/docs/decisions`), an engineering-governance document, generators and a structure validator, ready-made guarded test environment and runbooks created by this program (cluster setup, runner, evidence tools, operator guides). Negative: H-01 (master documents outside the repo), P-01/P-03 (history and uncommitted work), C-01 (no CI), and no recorded dry-run by a person who did not build the system. **Handover readiness: RISK.** A practical handover test (a new engineer follows only the repository, from clone to green unit suite and a running local instance) is **NOT ASSESSED** — it needs a person; the mechanical part (clone→install→build→unit) passed (§7).

## 10. Remediation roadmap
| Step | Scope | Depends on | Acceptance criteria |
|---|---|---|---|
| R1 | Docs into the repository + README fix | none | A clean clone contains every document the README/handover files link to; link checker passes |
| R2 | CI pipeline + lint green | R1 optional | CI runs install/build/lint/unit/guard on every change; `npm run lint` exit 0 |
| R3 | Transaction helper + apply to primitives flagged in §6 + concurrency specs | CTO authorisation (product code) | T-17 probes PASS for every primitive; no new FAIL in T-01…T-16 |
| R4 | Integrations tenancy decision and migration move | CTO decision | T-18 control-plane structural check PASS |
| R5 | Contracts for the 19 service imports + resolved-path lint | R2 | `arch-graph.js` reports 0 concrete cross-domain imports |
| R6 | Repository hygiene + provenance (commit/park other tracks) | owners of other tracks | HEAD equals the tested tree; duplicate trees removed from the working branch |
| R7 | Authorised dependency audit + license confirmation | network/legal | `npm audit` high/critical = 0 or accepted with owner; license sign-off |
| R8 | LICENSE/ownership decision | business | LICENSE file or explicit proprietary notice in the repository |

## 11. Residual uncertainties and evidence limitations
- Static analysis is name/path based (reference map, guard scan, import graph); it can miss dynamic wiring. Counts are evidence for triage, not verdicts.
- No vulnerability scan, no host/proxy review, no penetration test, no secrets review of the host, no boot/restore drill.
- Authorship (human vs tool) cannot and was not inferred; history before 2026-09-18 is not in the repository.
- Machine-specific: all timings come from a 2-core development laptop.
- Items marked INFERRED should be re-verified before being used for commercial claims.

## 12. Final readiness assessment
| Dimension | Status | Why (evidence) |
|---|---|---|
| Architecture and platform cohesion | **RISK** | Clear modular structure and contracts (PASS), but 19 contract-bypassing imports, platform→domain registration inversions, and the Integrations tenancy mismatch (D-03) |
| Maintainability and technical debt | **RISK** | Strict TS, small files mostly (571/681 ≤ 200 LOC), but 5 services > 1,000 LOC, 259 non-null assertions, 275 raw queries; manageable and itemised in §4 |
| Security posture | **RISK / UNVERIFIED** | Sound application-level controls verified; dependency vulnerabilities and host hardening UNVERIFIED; no CI gate |
| Test and verification maturity | **RISK** (improved) | Strong real-PG isolation and now concurrency/HTTP evidence; escapes (Q-01) show the pre-existing suite alone is insufficient; lint/CI gate missing |
| Reproducibility | **PASS** (build, unit, schema) / **NOT ASSESSED** (boot, restore) | Clean archive → install → build → 430 unit tests green; schema reproduces entities |
| Handover readiness | **FAIL → RISK after R1** | Governing documents outside the repository; no independent dry-run |
| Intellectual-property and dependency risks | **RISK** (needs legal input) | UNLICENSED, no LICENSE file, 3 undeclared dependency licenses, MPL dev-only |
| **Overall technical-asset readiness** | **NOT READY for external technical/commercial evaluation; READY for continued internal development** | Close R1, R2 and R3 (and decide R4, R8) first; the platform itself is sound enough to justify that investment |

No single score is assigned. Critical consequences: without R1 a reviewer cannot follow the project's own documentation; without R2/R3 the defect classes found here can reappear unnoticed; without R7/R8 distribution and due-diligence questions about third-party code and ownership remain open.

## 13. Limitations and gaps that prevent a fully reliable conclusion — and the steps that close them
| # | Limit | Effect on the conclusion | Closing step | Needs |
|---|---|---|---|---|
| 1 | No dependency-vulnerability audit and no host/proxy review | Security posture stays UNVERIFIED | `npm audit` (+ lockfile review) and a proxy/header check on a staging host | Network/host authorisation |
| 2 | No independent handover dry-run | Handover readiness is judged from documents and a mechanical clean build only | A new engineer follows only the repository (after R1) from clone to a running local instance and a green suite | A person; R1 first |
| 3 | App boot from `dist`, `migration:run:prod`, rollback and backup/restore not exercised | Reproducibility is proven for build, unit suite and schema, not for operation | Boot the built app against a disposable database under the guard; run migrate/rollback; one restore drill | Approved boot path under the guard |
| 4 | 18 provisioning/pool/fan-out/restore/registry specs, `company-audit-access` and the opt-in T0 baseline not run; `release-migration-registry` blocked by a 5544-pinned helper | Release-engine and provisioning behaviour is not covered by this program's runs | Test-only adaptations listed in `ISOLATION-RUN-60-FINAL-REPORT-2026-10-11.md` §3 | None beyond a scoped test change; other track's commit |
| 5 | Static scans are path/name based (reference map, guard scan, import graph, call-site scan) | Counts are triage evidence; reach of N-01 (55 sites) is INFERRED | Per-path concurrent probes for the sites flagged by `callsite-transaction-scan.js`, starting with sales orders, shipments, returns, purchase orders | Authorisation only if fixes follow |
| 6 | Frontend (181 files, 73 packages) and API contract documentation not assessed | Asset assessment covers the backend only | Repeat axes 1, 3, 4, 8, 9 for `frontend/` | Time |
| 7 | History before 2026-09-18 and authorship are not in the repository | Provenance and IP chain-of-title cannot be established from Git | Obtain the earlier history/backups and a contributor/assignment record | Owner records, legal |
| 8 | Licenses: three undeclared fields, no project license | IP risk is unquantified | Confirm upstream licenses; add LICENSE/ownership notice | Legal opinion |
| 9 | Local-only performance and tenancy evidence | No statement about hosting behaviour | Staging profile (`STAGING-CAPACITY-PROFILE-2026-10-11.md`) | Authorised host |
| 10 | The uncommitted working tree (other tracks) is not part of HEAD | What was assessed is HEAD plus the local test run, not the deployed build | Commit or park the other tracks, then re-run the clean-build step | Track owners |

## Appendix — evidence index (all under `backend/`)
- Reports: `docs/decisions/test-03/ARCHITECTURE-GRAPH-2026-10-11.md`, `ISOLATION-RUN-60-FINAL-REPORT-2026-10-11.md`, this report.
- Static evidence (`docs/decisions/test-03/evidence/`): `arch-graph.json`, `cross-domain-imports.json`, `code-metrics.json`, `eslint.json`, `controller-guard-scan.json`, `test-reference-map.json`, `migration-scan.json`, `license-scan.json`, `callsite-transaction-scan.json`, `capability-matrix.md`.
- Operational evidence (separate from static analysis): `evidence/clean-build-*.log` (clean checkout → install → build → unit), `evidence/t17-run.log`, `evidence/t18-run.log`, plus the preserved runs `docs/decisions/evidence-2026-10-10-biz/T-17/…` (plain-manager probes) and `T-18/…` (schema drift), `run-logs/regression-1…3.log` (isolation specs).
- Scripts (read-only, re-runnable): `tools/assessment/*.js`; probes: `src/foundation/testing/f-plain-probes.biz.real-pg.spec.ts`, `test03-schema-drift.biz.real-pg.spec.ts`.
- Separation: sections 2–5 and 3's static rows are **static analysis** (INFERRED unless a reproduction is cited); sections 6–7 and the T-17/T-18/isolation rows are **operational test results** (VERIFIED).
