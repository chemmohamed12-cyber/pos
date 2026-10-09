# Post-Deployment Incident Review — DAII release 1.1.4 (2026-10-09)

**Scope:** the chain HTTP 503 after the 1.1.4 deployment → site restored → "An unexpected error occurred" when creating a Company.
**Method:** every statement below is tagged **[CODE]** (proved from the repository), **[TEST]** (proved by a test / real-Postgres run I executed), **[REPORTED]** (taken from the team's own account or screenshots, not independently seen), or **[HYPOTHESIS]** (plausible, needs the host's logs). Nothing was executed against the hosting server or its database — I have no access to them; all verification ran on the isolated test instance.
**Branch:** `release-company-fanout` (local, not pushed). Fix commit: `25868c7`.

---
## 1. Incident timeline
| # | Event | Source |
|---|---|---|
| 1 | Release 1.1.4 uploaded and deployed on the hosting server | [REPORTED] |
| 2 | During deployment a message about "JS files" appeared — **its exact text was not captured** | [REPORTED] |
| 3 | `https://daii.xnexustech.com` answered **HTTP 503 Service Unavailable** (Passenger-style page) | [REPORTED] — screenshot |
| 4 | Diagnosis on the host (Node.js / CloudLinux / Passenger, backend logs) until the site was available again — **what restored it is not recorded** | [REPORTED] |
| 5 | The platform admin UI loads; the company registry shows "no companies yet"; **Create Company → "An unexpected error occurred."** | [REPORTED] — screenshots |
| 6 | Backend log: `QueryFailedError … violates foreign key constraint "companies_installationId_fkey"` in `CompanyRegistryController.create` | [REPORTED] |
| 7 | On `xnexdrgr_daii_staging`: table `public.installation` exists, **0 rows** | [REPORTED] — that this is the DB the live app uses is **not established** |

**Evidence I do not have and need:** the Passenger/stderr log around the swap; the release record and its `release.deploy.*` audit events from the host's Release Center; the exact "JS files" message; the host's environment-variable list; the effective `DB_NAME`/`ENTITLEMENT_MODE` of the running process.

---
## 2. Root cause analysis
### P1 — Company creation fails — **ROOT CAUSE CONFIRMED**
- **[CODE]** `POST /installation/companies` always creates the Company with `installationId = 'installation'` (`INSTALLATION_SINGLETON_ID`), a foreign key to the platform `installation` row.
- **[CODE]** The **only** writer of that row was `EntitlementService.applyManifest` (a *signed licence*). No migration, boot step or deploy step created it.
- **[CODE]** With `ENTITLEMENT_MODE=unlicensed-full` (the default) and no row, `EntitlementService.reload()` ran the whole application on the in-memory `implicitStandard` edition — so everything *appeared* to work — while the database had nothing for the foreign key to point at.
- **[CODE]** The controller's own doc comment says it relied on "the real DB-level FK" for the error; the unhandled `QueryFailedError` is what reached the UI as "An unexpected error occurred".
- **[TEST]** Reproduced on real Postgres: a migrated platform with no row → `companies_installationId_fkey` on the first Company insert.
- **Why it was never seen before:** the development databases had the row inserted **by hand** (recorded in the 2026-10-05 dev-reset notes: "Fresh `installation` row is NOT created by migrations/boot … must be inserted before any Company can be created"). A manual step that lived only in a memory note became a latent production defect.
- *Not established:* whether the live platform database is "fresh" or simply never had a licence applied — the effect is identical.

### P2 — HTTP 503 after the swap — **NOT CONFIRMED; ranked hypotheses**
| Rank | Hypothesis | Evidence | How to confirm |
|---|---|---|---|
| H1 | The new release **exited at boot because the host environment lacked a variable it requires in production** | **[CODE]** `DATABASE_CREDENTIAL_ENCRYPTION_KEY` does not exist in v1.1.2 and is **required in production** in 1.1.4 (config-schema diff `347c060` → `3f41d6b`: 44 → 48 keys, this the only newly required one). **[TEST]** against the real 1.1.x schema: a host with everything v1.1.2 required fails with exactly `"DATABASE_CREDENTIAL_ENCRYPTION_KEY" is required`. The app's own message calls this "a DEPLOYMENT/ENVIRONMENT problem" and Passenger shows a failed boot as 503. | Passenger/stderr log: `Daii startup aborted: required runtime environment configuration is missing or invalid` + the detail line. Was the variable added during the recovery? |
| H2 | Slow first boot under shared-host limits; Passenger answers 503 until the process is up | **[TEST]** a local boot takes ~9 s on a workstation; a limited CloudLinux account can be far slower. The engine had no way to know. | timestamps: restart trigger vs first successful request |
| H3 | Passenger application root / startup-file mismatch with the slot layout | The slot-swap design (`<deployRoot>/<activeDirname>`) is documented; nothing shows a mismatch | cPanel "Setup Node.js App" root + startup file vs `RELEASE_DEPLOY_ROOT`/`RELEASE_ACTIVE_DIRNAME` |
| H4 | A genuinely broken artifact | **[TEST]** the same 1.1.4 package deployed on `daii_dev` through the engine and its application booted and passed 8/8 smoke checks — this makes H4 unlikely, not impossible | the Passenger log |

**The "JS files" message (step 2):** if it came from the **Release Center's candidate verification** (`dist_syntax`, `dependencies_resolve`, `frontend_bundle`) it happened **before** the swap, with ACTIVE untouched, and cannot by itself cause a 503. If it was a **browser** message about the frontend bundle it would be a different problem (stale/cached `assets/*.js`). The exact text decides.

**An honest limit of my own verification of 1.1.4:** my simulation booted the upgraded build with `NODE_ENV=development`, so the production-only configuration checks (H1) **never ran**, and no Passenger/CloudLinux layer was involved. My "smoke 8/8" was true and insufficient. This is corrected by the checks below and by checklist item 6.

### Relationship between P1 and P2
Independent defects (P1 exists with or without the 503; H1 would have caused the 503 with or without P1), **the same class**: *first-deployment initialisation and host environment are not verified by the engine*, and the engine's post-swap verification was database-only (F-3).

---
## 3. Code review findings
| ID | Finding | Evidence | Status |
|---|---|---|---|
| F-1 | Platform `installation` row never initialised outside a signed licence | [CODE] [TEST] | **fixed** |
| F-2 | Company creation relied on the raw FK; the operator saw a generic 500 | [CODE] [TEST] | **fixed** |
| F-3 | Engine post-swap verification is DB-only: `RELEASE_HEALTH_ENDPOINTS` is **never read**, `RELEASE_SMOKE_GET_ENDPOINTS` defaults to `[]` — a release whose application cannot boot can be recorded `succeeded` | [CODE] (grep: no other use) | **fixed** |
| F-4 | `RELEASE_HEALTH_BASE_URL` defaults to `http://localhost:${PORT}`; under Passenger there is no fixed `PORT`, so that default cannot work | [CODE] | mitigated: new explicit public `RELEASE_READINESS_URL`; the old default is left as is |
| F-5 | No check that the new release can start with the host's environment before the swap | [CODE] | **fixed** |
| F-6 | My simulation ran in development mode (above) | — | corrected in the checklist |
| F-7 | After an automatic rollback the engine verifies the restored tree with DB checks only, not over HTTP | [CODE] | **open** |
| F-8 | The deploy outcome had only `succeeded`/`failed`: "files deployed" vs "application started" vs "initialised" were indistinguishable | [CODE] | **fixed** (classified outcome + evidence record) |
| F-9 | Every TypeORM connection attempts `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`, which fails and rolls back (the repo's own migration already defines `uuid_generate_v4()`) — benign noise, but it adds dead catalog tuples on every connection | [TEST] | noted |

## 4. Corrective changes (commit `25868c7`)
| Change | Files | Why / risk |
|---|---|---|
| **InstallationBootstrapService** — in `unlicensed-full`, ensure the **unsigned** `DAII_STANDARD` row the entitlement design already recognises (`INSERT … ON CONFLICT DO NOTHING`, audited once, never overwrites); in `enforced` **never creates anything**. Runs before `EntitlementService.reload()`. | `entitlement/installation-bootstrap.service.ts`, `entitlement.service.ts`, `entitlement.module.ts` | Fixes F-1. The row is not a licence (no manifest/signature/kid, `verificationState='unlicensed'`) and grants nothing the implicit edition did not; a later `applyManifest` replaces it. FK, signature verification and entitlement semantics unchanged (tested). Risk: low — a startup `INSERT … ON CONFLICT`. |
| **Company-creation gate** — 409 `INSTALLATION_NOT_INITIALIZED` with an actionable message, before anything is created | `company/company-registry.controller.ts`, `EntitlementService.isInstallationInitialized()` | Fixes F-2. |
| **Pre-swap environment check** — the candidate's own config schema is evaluated (child process) against the host environment; `ENVIRONMENT_INVALID` names the variables; ACTIVE untouched, no migration run | `release/release-execution.service.ts` | Fixes F-5. An invalid schema evaluation fails closed; a candidate without a schema file is reported `skipped`. |
| **Post-swap HTTP readiness + functional readiness** — `RELEASE_READINESS_URL` (public URL) + `RELEASE_HEALTH_ENDPOINTS`, `RELEASE_READINESS_TIMEOUT_SECONDS`; failure ⇒ automatic rollback; then "installation present" | `release-execution.service.ts`, `configuration.schema.ts`, `app-config.service.ts`, `.env.example` | Fixes F-3. **Without `RELEASE_READINESS_URL` the engine cannot know and records `DEPLOYED_UNVERIFIED`** — it never claims verified. |
| **Classified outcome + evidence record** `release.deploy.evidence` (layers: deployment / application startup / functional readiness) | same | Fixes F-8. |

## 5. Deployment-engine improvements — state
Done: pre-swap environment validation; HTTP readiness with rollback; functional readiness; classified outcomes and per-layer evidence. **Open:** F-7 (verify the restored app over HTTP after a rollback); surface `DEPLOYED_UNVERIFIED` visibly in the Release Center UI; an environment *diff* report between releases at upload time; a documented first-deployment initialisation step.
**Bootstrap note:** the engine that performs a deployment is the one *already installed*. The new checks therefore protect the deployment **after** the one that installs them; the installation bootstrap (inside the application) takes effect the first time a build that contains it boots.

## 6. Verification evidence (isolated test instance only)
- `installation-bootstrap.real-pg.spec` **8/8**: reproduces the incident; implicit row created unsigned and audited once; idempotent; 8 concurrent starts → one row, one audit; never overwrites a licensed-looking row; `enforced` invents nothing and the FK still refuses; entitlement semantics unchanged.
- `release-execution-readiness.spec` **9/9**: verified; HTTP 503 ⇒ `APPLICATION_STARTUP_FAILED` + rollback; connection refused; slow boot tolerated; missing installation ⇒ `INITIALIZATION_FAILED` + rollback; `enforced` warning vs regression; URL unset ⇒ `DEPLOYED_UNVERIFIED`; pre-swap failure ⇒ `DEPLOYMENT_FAILED`.
- `release-execution-environment-check.spec` **8/8** incl. **the incident with the real 1.1.x schema**; `company-registry.controller.installation-gate.spec` **2/2**.
- **Mutation checks 6/6 killed** (insert without `ON CONFLICT`; `enforced` creates a row; gate removed; engine ignores a non-answering app; engine ignores a missing installation; engine ignores an invalid environment).
- **End-to-end on a fresh database:** platform migrated with every tag → **0** installation rows before the application starts → after the **first boot exactly 1** (`implicit-…`, `DAII_STANDARD`, unlicensed, unsigned, manifest `{}`) with **1** audit record → after a **second boot (restart) still 1 and 1**.
- Release/entitlement/configuration regression: 29 suites, 243 tests. Full backend regression: see addendum at the end.

## 7. Future release checklist (mandatory before approving any release)
1. `npm run build` clean; release package built by `tools/build/build-release.sh` from **one commit**; `VERIFY: PASSED`; record commit + SHA-256.
2. **Config-schema diff against the previously deployed release**: list every new/tightened key; confirm each exists in the host environment **before** deploying (the engine now also checks, but humans own the host).
3. Every migration passes the expand/contract guard on the **pending delta**, applied to a restored **copy** of the target database on the isolated instance.
4. A restored copy of the target DB upgraded; schema compared; app booted **with `NODE_ENV=production` and a production-like environment** (secrets present, strong), not development.
5. `RELEASE_READINESS_URL` set on the host to the public URL; `RELEASE_HEALTH_ENDPOINTS` correct; timeout sized for the host.
6. Post-deploy: `DEPLOYMENT_VERIFIED` (not `DEPLOYED_UNVERIFIED`) in the evidence record; the platform has its installation row; **create a Company in a staging/acceptance environment**.
7. Never patch the database by hand to get past a failure; never disable a constraint; never fabricate a licence or manifest.
8. Keep `DATABASE_CREDENTIAL_ENCRYPTION_KEY` **stable**: it encrypts the stored Company database credentials; changing it later makes them undecryptable.

## 8. Recommended steps for the live host (not performed by me)
1. Gather the evidence in §1 (Passenger/stderr log first).
2. Do **not** insert the installation row by hand: deploy the corrected build (it initialises itself at first boot) — or apply a signed manifest through `POST /api/admin/entitlement/apply` if the site is meant to be licensed.
3. Before that deployment set `RELEASE_READINESS_URL` (public URL) in the host environment.
4. Confirm `DATABASE_CREDENTIAL_ENCRYPTION_KEY` is set and will not change; confirm the effective `ENTITLEMENT_MODE` from the application's boot log line ("running the implicit DAII_STANDARD edition (ENTITLEMENT_MODE=unlicensed-full)"), not from a terminal `printenv`.

---
## Addendum — full backend regression on the fix commit `25868c7`
Isolated instance, serial, signing-key environment loaded: **176 suites passed / 0 failed / 1 skipped of 177; 1248 tests passed / 0 failed / 1 skipped of 1249** (exit code 0, 20 minutes). The single skipped suite is `t0-clean-company-baseline`, opt-in by design. (The previous run's three closing-snapshot failures were the missing signing key in a `.env`-less worktree — present this time.) Protected-baseline specs (approval engine, treasury, procurement, sales-orders, accounting isolation, authorization, release) all passed; no regression.
