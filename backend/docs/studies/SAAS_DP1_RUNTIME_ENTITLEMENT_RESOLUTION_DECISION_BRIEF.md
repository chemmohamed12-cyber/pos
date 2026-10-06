# DP-1 Architecture Decision Brief — Runtime Entitlement Resolution

Part of: *DAII SaaS Control Plane & Tenant Lifecycle — Phase 0* (study commit `4bb71f8`).
**Status: ARCHITECTURE DECISION BRIEF FOR CTO REVIEW. Not a decision. Not an authorization.**
Option C is a *provisional candidate only* — it is not approved by this brief.
No code, schema, migration, ADR, blueprint or existing decision (D1, Model B, ADR-073/074,
ADR-015/019, Area 21) is changed. **Nothing was run.** On-prem licensing (ADR-015) stays open.
Governing rule: Evidence → Decision → Authorization → Code → Real-PG → Regression → Closure.

Classification: **VERIFIED** (source read) · **INFERRED** · **NOT VERIFIED** · **PROPOSED** · **DECISION REQUIRED**.

**Evidence-integrity caveat:** the Multi-Company files this brief reads are uncommitted
(`foundation/company/`, `foundation/database-registry/` untracked; several auth files modified by
another session). "VERIFIED" = working tree as read on 2026-10-04.

## 1. VERIFIED evidence

### 1.1 The resolver and everything that calls it

| # | Consumer | Calls | Has request / Company context? | Source |
|---|---|---|---|---|
| C1 | `RequireModuleGuard` | `isModuleEntitled(code)` (sync, `boolean`) | Guard sees the request. On Company-scoped controllers that apply it (30 controllers apply `CompanyContextGuard`; the subset also applying `RequireModuleGuard` was not separately counted) it runs *after* `CompanyContextGuard` (order: Jwt → CompanyContext → RequireModule → Permission). On **16** ambient controllers the order is Jwt → RequireModule only — no Company context. | `require-module.decorator.ts`; `UseGuards` grep |
| C2 | `RequireFeatureGuard` | `isFeatureEntitled(code)` | same | `require-feature.decorator.ts` |
| C3 | `JournalEntryService`, `GlAccountService` | `isFeatureEntitled('accounting.financial_dimensions')` etc., inside service logic | **No request.** They receive an optional `manager`. | `journal-entry.service.ts:702`, `gl-account.service.ts:107` |
| C4 | `ActiveEditionProvider` → Configuration Engine | `activeEditionCode()` | No — feeds the EDITION config layer (installation-wide; Area 21 Gate D open) | `active-edition.provider.ts` |
| C5 | `ModuleRoleTemplateSeeder` | `isModuleEntitled` at boot | No (boot, installation-level) | `module-role-template.seeder.ts` |
| C6 | `ModuleLifecycleService` | `entitlement.resolve()` before/after a deploy | No (Release Engine, installation-level) | `module-lifecycle.service.ts` |
| C7 | `NavigationService` (`GET /me/navigation`) | `entitlement.resolve()` directly; endpoint guarded by `JwtAuthGuard` only | Raw JWT `companyId` claim exists but is **unvalidated** there; no `CompanyContextGuard` | `navigation.service.ts`, `navigation.controller.ts` |
| C8 | `EntitlementController` (`GET /me/entitlements`, `/admin/entitlement`) | `resolve()` | same as C7 | `entitlement.controller.ts` |

The resolver interface is three synchronous methods (`isModuleEntitled`, `isFeatureEntitled`,
`activeEditionCode`) behind the `ENTITLEMENT_RESOLVER` token. `EntitlementService` is a singleton with an
in-process cache loaded from the one `installation` row through its own injected DataSource.

### 1.2 What the installation-level path does that the Company path does not

| Control | Installation (`EntitlementService.applyManifest`) | Company (`applyEntitlementManifestToCompany`) |
|---|---|---|
| Ed25519 signature + fingerprint verify | yes | yes |
| `license_version` replay/downgrade rejection | **yes** (rejects strictly older) | **no** (VERIFIED absent) |
| F-MOD-2 dependency closure check | yes | yes |
| Security alarms (`security.entitlement.*`) | yes | no |
| Audit record + `entitlement.changed` event | yes | no (deliberately — Area 14 taxonomy, per its own comment) |
| Clock-rollback `lastTrustedAt` | set on reload | `lastTrustedAtMs: null` at verify; row written with `lastTrustedAt = now` |
| Reader at runtime | `reload()` → cache → guards | **none** (write-only) |

### 1.3 The manifest and keys

- `EntitlementManifest` fields: `installation_id`, `customer_name`, `edition_code/version`, `module_codes`,
  `feature_codes`, `limits`, `config_overrides?`, `issued_at`, `term_start/term_end?`, `grace_days?`, `license_id`,
  `license_version`, `kid`, `installation_fingerprint`. **There is no `company_id` field** and the Company apply path
  checks none. → **F6 (new): a validly-signed manifest is not bound to a Company.** Any manifest valid for the host
  can be written into any Company's database by whoever can call the apply path. VERIFIED (type + code).
- `fromManifest` (private) derives modules (+ dependency closure at resolution time), features, limits, and status
  (`expired` when `term_end + grace_days` has passed). `expired` makes every non-core module un-entitled.
- Runtime holds **public keys only** (`ENTITLEMENT_PUBLIC_KEYS`). Ed25519 primitives exist in-repo
  (`foundation/crypto/ed25519.ts`) but there is **no manifest-issuing tool in the repository**; the referenced
  `tools/release/print-installation-fingerprint.js` is absent. Who holds the issuing private key today is **NOT VERIFIED**.
- Ratified precedent for key custody: ADR-051 §9 (Closing Snapshot) — operator-provisioned Ed25519 key, env-var custody,
  never in the database, the application never generates it, fails closed when absent.
- `computeInstallationFingerprint()` is host-bound; every Company on a host shares it (by design, per
  `company-entitlement-provisioning.ts`).
- Absent manifest: `ENTITLEMENT_MODE=unlicensed-full` → implicit DAII_STANDARD (all modules); `enforced` → Core-only.
- `CompanyConnectionManagerService.companyIdOf(dataSource)` maps a pooled Company DataSource to its Company id
  (identity lookup) — an existing way to recover the Company from a `manager` in service-level code.
- The Control Plane `create` endpoint never passes an entitlement manifest; `roleModuleCodes` defaults to `[]`.
  Hence **no UI-created Company has a Company-level manifest** (code level; DB state NOT VERIFIED).

## 2. NOT VERIFIED

- Whether `manager.connection` in service-level checks (C3) reliably maps through `companyIdOf` in every call path.
- Whether any currently provisioned Company DB contains an `installation` row.
- Who holds the issuing private key; whether an issuing tool exists outside this repo.
- Whether Nest's guard pipeline for the 16 ambient controllers will ever receive Company context before Area 21 retrofits them.
- Whether `entitlement.changed` (an ambient-bus event) can serve per-Company cache invalidation given ADR-075 (Event Engine
  Company context) is under CTO review.
- The access-token lifetime value (`JWT_ACCESS_TTL_SECONDS`).

## 3. This is a Runtime Resolution Architecture decision

The study's A/B/C conflated two independent axes. They must be decided separately; every option needs the **runtime
axis**, because F2 (no per-Company reader) exists under all of them.

**Axis I — Issuance (who produces the entitlement artifact)**
- I-1 External operator tool, operator-held private key (as today; outside the app runtime).
- I-2 The Control Plane signs (private key inside/behind the SaaS runtime).
- I-3 No signed artifact for SaaS tenants (rows in the Platform DB are authoritative).

**Axis R — Runtime resolution (what the guards read)**
- R-1 The Company's own signature-verified manifest (Company DB `installation` row).
- R-2 Plan/Subscription rows read directly from the Platform DB.
- R-3 R-1 verified once and cached, with explicit invalidation.

Mapping to the study: **A = I-2 + R-1**; **B = I-3 + R-2**; **C = Plan catalog as authoring source + R-1/R-3, issuance
unspecified** (it deliberately left I open).

### 3.1 Required properties of any runtime resolver (PROPOSED invariants)

1. **Company id source.** Only the id already validated by `CompanyContextGuard` (`request.companyContext.companyId`) or
   recovered from a Company `manager` via `companyIdOf`. Never the raw JWT claim, a header, or a request parameter
   (C7/C8 currently see only the unvalidated claim).
2. **No leakage by construction.** No process-global "current company"; cache keyed by validated `companyId`; a lookup
   with no Company id never silently resolves to another Company's entitlement.
3. **Fail-closed on context loss.** On a Company-scoped route, a missing/invalid Company manifest never widens access
   by falling back to installation-wide entitlement (see S2/S3 for the explicit exceptions).
4. **Signature + fingerprint preserved** on every path that admits a manifest, and **replay protection no weaker than the
   installation path** (§1.2 gap) plus a Company binding (F6).
5. **Sync/async.** `RequireModuleGuard.isModuleEntitled` is synchronous and context-free today; resolving per Company needs
   either an async guard (Nest guards may be async — the guard class changes, not just an addition beside it) or a
   per-request snapshot object. Either way this is a change to a shared guard and to the resolver contract (C1–C3).
6. **On-prem independence.** An install that applies a manifest through `POST /admin/entitlement/apply` must keep working
   with no Control Plane present.

### 3.2 Resolution-point matrix (what "per-Company" means for each consumer)

| Consumer | Needs per-Company? | Difficulty | Note |
|---|---|---|---|
| C1/C2 guards on Company-scoped controllers (those under `CompanyContextGuard`) | Yes | Moderate — Company context is available | Edits `RequireModuleGuard`/`RequireFeatureGuard` |
| C1/C2 on ambient controllers (16) | Not resolvable | Blocked | No Company context until Area 21 retrofit; interim policy = S3 |
| C3 service-level feature checks | Yes (correctness) | High — interface has no context argument | Needs a Company argument or `companyIdOf(manager)` |
| C7/C8 navigation and `me/entitlements` | Yes (UI must match enforcement) | Moderate — endpoints lack `CompanyContextGuard` | Needs validated Company context added |
| C4 config EDITION layer | Out of scope | — | Config is installation-wide (Area 21 Gate D); manifest `config_overrides` must not be applied per Company in v1 |
| C5/C6 boot seeding, release lifecycle | No | — | Installation-level by nature |

## 4. Options

| Dimension | **A** (I-2 + R-1) | **B** (I-3 + R-2) | **C** (catalog authoring + R-1/R-3) |
|---|---|---|---|
| Runtime reader | Company manifest | Platform DB rows | Company manifest, verified + cached |
| Signature / fingerprint | Preserved | **Bypassed** for SaaS tenants | Preserved |
| Anti-tamper | Highest | Lowest (trust = Platform DB access) | High |
| Replay protection | Needs the §1.2 / F6 fixes | Different mechanism needed | Needs the §1.2 / F6 fixes |
| Private key | **Enters the Control Plane runtime** (departs from "runtime cannot sign" and the ADR-051 §9 pattern) | none | Open — not decided by choosing C |
| On-prem parity | Same artifact | **Diverges** — second mechanism to maintain | Same artifact |
| Reuses existing code | `verifyManifest`, Company apply, `editions*` | little | most (writer exists; reader/binding missing) |
| Resolver change size | per-Company reader + guards | per-Company reader + guards + new source | per-Company reader + guards + cache/invalidation |
| Subscription expiry | `term_end/grace_days` in the manifest, free | must be re-implemented | `term_end/grace_days` in the manifest, free |
| Main risks | Key custody; blast radius of a Control Plane compromise (can mint entitlements) | Two entitlement systems; weakest trust; on-prem fork | Cache correctness across Companies; invalidation under ADR-075 uncertainty |

**What none of the options removes:** the guard/resolver change (§3.1.5), the lack of Company binding (F6), the weaker
Company apply path (§1.2), the ambient controllers (S3).

## 5. Sub-decisions requiring CTO ruling

| ID | Decision | Notes |
|---|---|---|
| S1 | Resolution scope: guards only, or guards + feature guards + service-level (C3) + navigation (C7/C8) | UI/enforcement mismatch if navigation is left installation-wide |
| S2 | Policy when a Company has no valid manifest | fail-closed (Core-only) vs inherit installation entitlement. Interacts with `ENTITLEMENT_MODE`. Existing Companies have none (§1.3) |
| S3 | Interim policy for the 16 ambient controllers | stay installation-wide until retrofitted? explicitly accepted gap? |
| S4 | Issuance and key custody (Axis I) | I-1 operator-held (matches ADR-051 §9) / I-2 Control Plane signs / separate signer service |
| S5 | Company binding of the artifact (F6) | add `company_id` to the manifest (schema_version change to a signed, security-critical format) vs bind externally; either needs an explicit ruling |
| S6 | Replay/rollback on the Company path | adopt `license_version` monotonicity + alarms equal to the installation path? |
| S7 | Cache and invalidation | per-process cache keyed by `companyId`; invalidation trigger (cannot assume the ambient bus is Company-correct — ADR-075) |
| S8 | Per-Company `config_overrides` / EDITION config layer | PROPOSED: excluded from v1 (Gate D) |
| S9 | Fingerprint semantics for multiple Companies on one SaaS host | currently one host fingerprint shared by all Companies; confirm acceptable |
| S10 | Migration of existing Companies (no manifest) | backfill plan vs S2 inherit policy |

## 6. Security and data-isolation risks

- **Cross-company leakage** through a shared cache or a default-to-installation fallback (S2/S3).
- **Manifest replay across Companies** (F6) and **downgrade replay within a Company** (§1.2).
- **Claim trust:** using the raw JWT `companyId` for entitlement on `/me/*` endpoints would let a stale or revoked
  Membership influence what is shown/enforced.
- **Key blast radius** under I-2: compromise of the Control Plane = ability to mint any entitlement for any tenant.
- **Un-entitled-but-reachable** surfaces: ambient controllers (S3) and service-level checks (C3) if only guards are fixed.
- **Availability:** a bad/expired Company manifest takes the whole Company to Core-only (status `expired` → no modules).

## 7. Backward compatibility

- Existing UI-created Companies have no Company manifest → any fail-closed policy is a breaking change for them (S2/S10).
- `unlicensed-full` development mode relies on the implicit standard edition; preserving it for dev is a requirement.
- On-prem installs: unaffected if the installation-level apply path and singleton remain the fallback for non-Company use.
- The signed-manifest schema is shared with licensing (`schema_version: 1`); changing it (S5) affects every issuer.

## 8. Recommendation (PROPOSED — reviewable, not an authorization)

1. **Decide the runtime axis first (R-1/R-3), then issuance.** Verify-then-cache the Company's own signed manifest
   (R-3), keyed by the validated `companyId`, fail-closed on Company-scoped routes. This is the only family that keeps
   signature/fingerprint, keeps on-prem parity, and gives subscription expiry for free (`term_end`/`grace_days`).
2. **Issuance for v1: I-1** — operator-held key outside the application runtime (the ADR-051 §9 custody pattern); the
   Control Plane's plan catalog produces an *unsigned* entitlement draft that the operator signs. Defer I-2 until a
   separate key-custody ruling (HSM/offline signer/threat model). Operationally heavier, deliberately safer.
3. **Reject B for v1**: bypasses the signature, forks from on-prem, creates two mechanisms.
4. **Treat F6 and §1.2 as prerequisites** of any Company-scoped reader (binding + replay parity), not follow-ups.
5. **Scope v1** to guards on Company-scoped controllers plus navigation/`me/entitlements`, with C3 and the ambient
   controllers as explicitly-listed residual gaps (S1/S3) — not silently covered.

## 9. Explicit CTO rulings required

1. Approve decomposing DP-1 into Axis R then Axis I (this brief's §3).
2. Rule on S1–S10 (§5), at minimum S2, S3, S4, S5, S6 before any contract.
3. Choose the runtime family (R-1/R-3 vs R-2) and the v1 issuance model.
4. Authorize or refuse any edit to `RequireModuleGuard`, `RequireFeatureGuard`, `EntitlementService`,
   `NavigationService`, the resolver token, and `CompanyContextGuard` — **per file**, and state the Area 21 boundary
   (those files are shared by closed controllers, and some are modified by another session).
5. Confirm the on-prem rule: the Control Plane is never a required dependency of an on-prem install, and the open
   ADR-015 licensing question is not closed by this decision.
6. Authorize (or not) a read-only proof for the NOT VERIFIED items that can be settled by reading a *disposable*
   database (e.g. what a UI-provisioned Company's `installation` row contains).

## 10. Stop conditions

- Any change to the guards, resolver token, `EntitlementService`, navigation, or auth without per-file authorization.
- Any change to the manifest schema or signing format without an explicit S5 ruling.
- Generating, storing, or placing a private key anywhere (this brief creates none).
- A fallback from a Company-scoped route to installation-wide entitlement without an explicit S2/S3 ruling.
- Applying `config_overrides` per Company before the Configuration Engine is Company-scoped.
- Any design that makes the Control Plane mandatory for on-prem.
- Implementation Contract before DP-1 **and** DP-9 are ruled.

## 11. Files read (read-only)

`foundation/entitlement/{entitlement.service,entitlement.controller,manifest.type}.ts` ·
`foundation/company/company-entitlement-provisioning.ts` ·
`foundation/module-registry/{require-module.decorator,require-feature.decorator,entitlement-resolver.token}.ts` ·
`foundation/configuration-engine/active-edition.provider.ts` · `foundation/module-role-templates/module-role-template.seeder.ts` ·
`foundation/module-lifecycle/module-lifecycle.service.ts` · `foundation/navigation/{navigation.service,navigation.controller}.ts` ·
`foundation/database-registry/company-connection-manager.service.ts` · `foundation/crypto/ed25519.ts` ·
`domains/accounting/application/{journal-entry.service,gl-account.service,closing-snapshot-signing-key.service}.ts` ·
`foundation/configuration/app-config.service.ts` (entitlement keys) · guard-order grep across `*.controller.ts` ·
`backend/docs/studies/SAAS_CONTROL_PLANE_TENANT_LIFECYCLE_PHASE0_STUDY.md`.
