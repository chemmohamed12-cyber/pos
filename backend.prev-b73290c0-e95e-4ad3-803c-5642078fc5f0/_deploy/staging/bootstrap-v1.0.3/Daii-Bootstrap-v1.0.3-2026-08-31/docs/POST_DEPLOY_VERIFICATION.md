# Daii — Post-Deploy Verification

What must pass, in order, before a deploy is signed off. Automated checks
first; then the business smoke list. Health-check-passing alone is **not**
sign-off (PART 1 §20, PART 2 §20).

---

## 1. Automated (the pipeline runs these; re-run to confirm)

| Check | How | Pass criteria |
|---|---|---|
| Release status | `GET /api/release/releases/:id` | `"succeeded"` |
| Migrations | `GET /api/release/releases/:id/migrations` | every row `success: true` |
| Deploy verify script | `bash tools/deploy/verify-deploy.sh https://daii.xnexustech.com` | exit 0 |
| App HTTP | `curl -s -o /dev/null -w '%{http_code}' https://daii.xnexustech.com` | `200` |
| Health (shallow) | `GET /api/health` | `success:true` |
| Health (schema + UUID + bundle) | `GET /api/health/deep` **and** `ReleaseHealthCheckService.check()` in the deploy log | `ok:true`; `function.gen_random_uuid()` / `uuid_generate_v4()` return **strict RFC4122**; `frontend.bundle` true |
| Frontend bundle | `bash tools/deploy/check-frontend-bundle.sh public` | exit 0 — `public/index.html`'s `assets/*` all present |
| Migration head | `npm run migration:show:prod` | no `[ ]` pending rows |
| Legacy UUID census | `verify-deploy.sh` §3b output | records the count; **0** after the Controlled Data Repair |

## 2. Business smoke (manual or scripted against staging)

Authenticate as an `admin` (and separately as `finance`, `sales`,
`warehouse` where relevant).

| # | Flow | Pass |
|---|---|---|
| 1 | Login | token issued, `/api/health/deep` ok |
| 2 | User management — list users, create a user, assign a role | 2xx; new user can log in |
| 3 | Create a product (with a unit) | 2xx; unit editable (Hotfix 1) |
| 4 | Create a customer | 2xx |
| 5 | Create a sales order (with lines, a price list applied) | 2xx; price resolved server-side |
| 6 | Sales order **with deposit** → submit → supervisor approve → manager approve | lands in `deposit_verification` |
| 7 | **Deposit approve** — `POST /deposits/:id/approve {treasuryAccountId}` | **2xx, NO `treasuryAccountId must be a UUID`**; `treasury_transactions` + `customer_ledger_entries` rows created |
| 8 | **Treasury cash-in** — `POST /treasury/cash-in {accountId, amount}` | **2xx, NO `accountId must be a UUID`**; posted `treasury_transactions` row; balance moves |
| 9 | Sales order **without deposit** (`skipDeposit`) → manager approve | auto-advances to `released`, never stuck in `deposit_verification` (Hotfix 6) |
| 10 | Fulfillment → pick → pack | 2xx |
| 11 | Shipment → assign carrier/vehicle → deliver | 2xx |
| 12 | Delivery outcome + collection remittance to a treasury account | 2xx, no UUID error |
| 13 | Print any document (deep-link `/print/...` in a new tab) | renders the SPA, not a JSON 404 (Hotfix 4) |
| 14 | Customer return → disposition → credit | 2xx |
| 15 | New record UUID check | any id created above matches strict RFC4122 (generation fix `1755852500000`) |

## 3. The v1.0.3 gate (PART 2 §25, §30)

**v1.0.3 is NOT "SOFTWARE RELEASE = VERIFIED" until rows 7 and 8 above
pass on the real staging DB after the Controlled Data Repair**, with the
result captured in logs / `data_repair_runs` / this checklist — not merely
"no error visible in the UI".

Regression tests that must stay green in CI:
`treasury.controller.spec.ts`, `deposits.controller.spec.ts`,
`uuid-repair.core.spec.ts`, `data-repair.service.spec.ts`,
`migration-glob.spec.ts`, `deploy-preflight.service.spec.ts`,
`release-health-check.service.spec.ts`, `package-validator.service.spec.ts`.

## 4. Evidence to file with the release

`FINAL_V1.0.3_DEPLOYMENT_REPORT.md` template — Release ID, base/target
version, artifact SHA256, Node/npm versions, migration result, backup ID +
manifest, health result, smoke result (rows 1–15), UUID repair result,
rollback-test result, final status.
