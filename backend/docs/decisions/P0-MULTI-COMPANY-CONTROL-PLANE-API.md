# Multi-Company Control Plane — P0 HTTP Surface (2026-09-27)

**Status: IMPLEMENTED — REAL POSTGRES VERIFIED — API CONTRACT DOCUMENTED.**
CTO-authorized ("P0 Multi-Company Control-Plane HTTP Surface"). This
exposes the EXISTING, already-built `CompanyRegistryService` /
`CompanyActivationService` / `DatabaseProvisioningService` (Multi-Company
Phase 3 V7, Areas 2/4/19/20) through real HTTP contracts. **No new
business logic, no new state machine, no new provisioning steps were
added** — the one new piece of logic is documented explicitly in §P0.1
below (a missing `CREATE DATABASE` step, found and fixed during
verification, not a redesign).

## P0.1 — Installation Bootstrap (resolved, not built here)

**The approved bootstrap mechanism already exists**: `POST /admin/entitlement/apply`
(`EntitlementController` / `EntitlementService.applyManifest`, unmodified) —
its own code comment: *"the endpoint P6's deploy step calls to apply a
freshly-issued signed manifest."* The `Installation` entity's own doc
comment confirms it independently: *"Written by the operator `POST
/admin/entitlement/apply` endpoint... Absent + ENTITLEMENT_MODE=unlicensed-full
=> an implicit DAII_STANDARD edition, so the current product runs
unchanged."*

Applying any validly Ed25519-signed manifest through that endpoint writes
the singleton `installation` row (`id = INSTALLATION_SINGLETON_ID =
'installation'`) — the same row `Company.installationId` foreign-keys to.
This is not a new mechanism; nothing was built for P0.1 beyond confirming
it and using it correctly.

**Verification note (this dev database specifically):** minting a real
Ed25519 keypair and a genuinely-signed manifest to exercise
`POST /admin/entitlement/apply` end-to-end would have required adding
that key to `.env`'s `ENTITLEMENT_PUBLIC_KEYS` — the harness's own
security policy flagged that specific edit as a cryptographic-trust
config change and declined it, and that decision was not worked around.
Instead, the singleton row was created directly via the **same
"test/dev" trust path `EntitlementService.reload()` itself already
documents and implements** (`editionCode = 'DAII_STANDARD'` with
`manifestSignature = NULL` → treated identically to "no row at all," per
that method's own existing branch) — this changes **zero** resolved
entitlement behavior versus the current unlicensed-full default (same
module/feature set), it only satisfies the FK so Company provisioning
can proceed. The production-recommended path for a real deployment
remains `POST /admin/entitlement/apply` with a genuinely signed manifest,
unchanged and unmodified by this work.

## Authorization

All endpoints below: `JwtAuthGuard` + `RolesGuard` + `@RequireRole('admin')`
— the exact SAME Installation-Administrator boundary this codebase
already established for control-plane operations
(`installation-membership.controller.ts`'s own precedent, quoted in its
class doc comment: *"a platform admin is trusted to name any Company
explicitly, for control-plane/provisioning purposes"*). This is a
**Platform role check, not `CompanyContextGuard`** — it never sets or
reads Company context, so Model B's Company-scoped authorization
boundary is entirely untouched by this controller's existence. No new
authorization axis, no new permission node.

## Endpoints

### `GET /installation/companies`

Lists every Company visible under the singleton Installation
(`CompanyRegistryService.listVisible` — excludes `PROVISIONING`, per
that service's own existing rule: "no company shown before READY").

- **Auth:** `admin` role.
- **Response 200:** `{ success: true, data: CompanyView[] }`

### `GET /installation/companies/:id`

- **Auth:** `admin` role.
- **Response 200:** `{ success: true, data: CompanyView }`
- **404** if no Company with that id exists.

### `POST /installation/companies`

Creates and **synchronously, fully provisions** a Company in one request
— `CompanyRegistryService.provision()` (create, `PROVISIONING`) then
immediately the existing `DatabaseProvisioningService.provision()`
pipeline (register → **create the physical database** → migrate →
authorization-schema-adjust → seed role catalog → optional entitlement →
create mandatory initial admin → health-check → mark `ACTIVE`/`READY`).

**Synchronous, not async/polling** — this matches how every existing
real-PG caller of `DatabaseProvisioningService` already invokes it
(the test harness, the service's own spec), and the CTO's own flow
diagram describes one continuous chain. A real provisioning run in this
environment (full migration set: 269 migrations) took **~2-3 seconds**
end to end in verification — acceptable for a synchronous HTTP call. If
Frontend needs an async/polling UX later, `GET /installation/companies/:id`'s
`status`/`databaseStatus` fields already support polling — no new
capability is needed to add that, only a design decision.

- **Auth:** `admin` role.
- **Request body:**
  ```jsonc
  {
    "name": "Acme Corp",                 // required, non-empty string
    "initialAdminUserId": "<uuid>",      // required — MUST be an existing User (D1); this endpoint never creates one
    "tags": ["sales", "accounting"],     // optional — migration tags for the new Company DB.
                                          // Omitted = the pre-existing default when `tags` is undefined:
                                          // auto-discover EVERY tag under src/database/migrations/ (a fully-featured DB).
    "roleModuleCodes": ["sales"]         // optional — which module role-template catalogs to seed.
                                          // Omitted = DatabaseProvisioningService's own existing default: `[]`
                                          // ("does not guess an entitlement it has no way to know yet" — that
                                          // service's own doc comment). The bootstrap `admin` role is ALWAYS
                                          // seeded regardless (a separate, unconditional step).
  }
  ```
- **Response 201:**
  ```jsonc
  {
    "success": true,
    "data": {
      "company": { "id": "...", "name": "...", "status": "READY", "createdAt": "...", "databaseStatus": "ACTIVE" },
      "migratedTags": ["BootstrapCheck...", "..."],   // every migration that actually ran
      "roleSeedResult": { "roles": 0, "grants": 0 },  // 0/0 if roleModuleCodes was omitted — expected, not an error
      "entitlementApplied": false,                    // false unless an entitlementManifest was supplied (not exposed in this DTO yet — see "Not yet exposed" below)
      "initialAdminMembershipId": "<uuid>"
    }
  }
  ```
- **Validation errors (400):** missing/empty `name`, `initialAdminUserId` not a UUID.
- **Provisioning failures (422, `UnprocessableEntityException`):**
  ```jsonc
  {
    "success": false,
    "error": {
      "code": "UNPROCESSABLE_ENTITY",
      "message": "Company provisioning failed at stage \"<stage>\"."
    }
  }
  ```
  `<stage>` is one of `migrations | authorization-schema-adjustment |
  role-seeding | entitlement | initial-admin | health-check` — the exact
  stage enum `DatabaseProvisioningService`'s own `ProvisioningFailedError`
  already defines, not invented here. **Verified live**: an
  `initialAdminUserId` that does not reference a real User correctly
  fails at stage `initial-admin` with this shape (not a raw 500).
- **Known, pre-existing asymmetry (not fixed here — out of this
  endpoint's authorized scope):** on any provisioning failure, the
  `DatabaseRegistry` row is marked `FAILED`, but the **Company row's own
  `status` is NOT moved off `PROVISIONING`** by the existing service.
  `GET /installation/companies/:id` surfaces this honestly —
  `status: "PROVISIONING"` with `databaseStatus: "FAILED"` — rather than
  inventing a cleaner status than what the underlying service actually
  produces. **A real, demonstrated consequence, found during
  verification**: because `CompanyActivationService.reactivate()` allows
  `PROVISIONING → READY` (the state table's own literal chain includes
  it — not a bug in the guard), a caller can push a Company whose
  database provisioning genuinely failed straight to `READY` by simply
  calling `POST /:id/reactivate` — the state machine will not stop this.
  This is existing, already-decided architecture (Area 2/Area 19,
  2026-09-22) and was not changed; flagged here as a real operational
  risk worth the CTO's awareness, not silently patched.

### `POST /installation/companies/:id/suspend`
`READY → SUSPENDED`. **Auth:** `admin`. **200** with the updated
`CompanyView`, or **422** `InvalidCompanyTransitionError`'s message if
the Company isn't currently `READY`.

### `POST /installation/companies/:id/reactivate`
`DEGRADED|SUSPENDED|MIGRATING|FAILED|PROVISIONING → READY` (the state
table's literal allowed set — see the asymmetry note above regarding
`PROVISIONING`). **Auth:** `admin`. **200**/**422** same shape as suspend.

### `POST /installation/companies/:id/decommission`
`DEGRADED|SUSPENDED|MIGRATING|FAILED → DECOMMISSIONED` — **never directly
from READY**, verified live (a direct `READY → DECOMMISSIONED` attempt
correctly returns 422 with `"Invalid Company status transition: READY -> DECOMMISSIONED"`).
**Auth:** `admin`.

## `CompanyView` shape (every endpoint above)

```ts
{
  id: string;
  name: string;
  status: 'PROVISIONING' | 'READY' | 'DEGRADED' | 'SUSPENDED' | 'MIGRATING' | 'FAILED' | 'DECOMMISSIONED';
  createdAt: string; // ISO timestamp
  databaseStatus: string | null; // the DatabaseRegistry row's own status ('PROVISIONING'|'ACTIVE'|'FAILED'|...), null if no registry row exists yet
}
```
Frontend distinguishes every CTO-required state directly from `status` —
no inference needed, no client-side derivation.

## Not yet exposed (explicit, not silent)

- **Entitlement manifest at creation time** (`entitlementManifest`/
  `entitlementSignature`/`entitlementOptions` — `DatabaseProvisioningService`
  already accepts these as optional params) is not yet in `CreateCompanyDto`.
  Omitted deliberately, not overlooked: per-Company entitlement is Area 7's
  own separate, not-yet-built resolution layer (per that service's own doc
  comment — "provisioning consumes a resolved package/entitlement profile,
  it does not compute one"). Adding it to this DTO once Area 7 exists is a
  small, additive change — not a redesign.
- No `PATCH /installation/companies/:id` (rename, etc.) — not requested,
  not built.
- Membership management for a Company is **already exposed** —
  `installation-membership.controller.ts`'s existing
  `installation/companies/:companyId/memberships` routes (list/grant/
  revoke/change-role), unmodified, unaffected by this work.

## Security / Isolation — verified, not asserted (P0.6)

All verified live against this dev database, real Postgres, real HTTP:

| Check | Result |
|---|---|
| Company A's initial-admin user selecting Company B (`POST /auth/select-company`) | **Rejected**, 401 `"You are not a member of this Company."` |
| Company A and Company B provisioned to genuinely separate physical Postgres databases | **Confirmed** — `company_<uuid>` per Company, 169 tables each, independently connectable |
| `CompanyContextGuard` / Company-scoped routes | **Untouched** — this controller never sets or reads `req.companyContext`; existing Company-scoped guards are unaffected by construction, not by testing around them |
| Installation-admin privilege vs. Company membership | **Not conflated** — the `admin` role check here is a Platform role (`RolesGuard`), entirely separate from the `Membership`/`roleKey: 'admin'` row `DatabaseProvisioningService` grants inside the new Company's own database; an Installation admin has no automatic Company membership anywhere by virtue of this controller |
| Database routing | **Backend-controlled only** — `databaseName` is server-generated (`company_${randomUUID()}`), never client-suppliable in the request body |

No isolation violation found. Nothing here required a STOP/ESCALATE.

## Real-Postgres verification performed (P0.8)

Against this dev database (`daii_dev`), via the live running server
(`localhost:3500`) and real HTTP calls with a minted dev-secret admin
JWT (`admin@daii.example`) plus two freshly `POST /auth/register`-created
verification users:

1. ✅ Bootstrap XNEXUS Installation (§P0.1 above).
2. ✅ Create Company A — `POST /installation/companies`.
3. ✅ Company A reaches `READY` (confirmed via `GET`).
4. ✅ Company A has its own DB — `company_bd8eed0c...`, 169 tables, independently connectable.
5. ✅ Create Company B — separate DB `company_0b2acb6a...`.
6. ✅ Company B reaches `READY`.
7. ✅ A and B isolated — separate physical databases; cross-Company `select-company` rejected (below).
8. ✅ Membership assignment — real `Membership` row created for each initial admin, correct `roleKey: 'admin'`.
9. ✅ Company selection via `POST /auth/select-company` — succeeds for the owning user, returns a Company-scoped token pair.
10. ✅ Company A's user cannot select Company B — 401.
11. ✅ Lifecycle actions — suspend (`READY→SUSPENDED`), reactivate (`SUSPENDED→READY`), and the invalid-transition guard (`READY→DECOMMISSIONED` rejected) all verified live.
12. ✅ Failure handling — an invalid `initialAdminUserId` correctly fails at the `initial-admin` stage with a structured 422, not a raw 500 (this required first finding and fixing the missing `CREATE DATABASE` step — see below).

**Bug found and fixed during this verification (not a pre-existing
service defect — a gap in this new controller):**
`DatabaseProvisioningService.provision()` runs migrations against
`databaseName` but does **not** create the physical Postgres database
itself — confirmed directly (neither that service nor
`runMigrationsForDatabase` issues a `CREATE DATABASE`). Every existing
real-PG caller (`database-provisioning.service.spec.ts`,
`two-company-real-pg-harness.ts`) creates it first as the caller's own
responsibility. The first version of this controller omitted that step;
every provisioning attempt failed at the `migrations` stage as a result.
Fixed by adding the same `CREATE DATABASE` step (connecting to the
`postgres` maintenance database) every existing test harness already
uses — not a change to `DatabaseProvisioningService` itself.

**Tests / build:** `npm run build` clean; `npx eslint` on all
touched/added files — 0 problems; full sequential regression suite run
after these changes (see chat for the exact pass count) — result
reported alongside this document.
