# Batch A — DP-8 / DP-4 / DP-1 — Stable Decision Package (v2, after CTO rulings 2026-10-05)

**Status:** RULED. DP-8 **DECIDED (8-1)** · DP-4 **DECIDED (4-A)** · DP-1 **architecture DECIDED IN PRINCIPLE — CONDITIONAL**.
**Implementation authorization for all three: NOT AUTHORIZED.** Production: HOLD.
**Governing rule (CTO):** *existing code that predates a decision does not turn into the decision.* The order is **Architecture Decision → Authorization → Code**, never Code → Architecture justification.

This package is deliberately split into: **§1 what was decided**, **§2 what is still open inside it**, **§3 what already exists in the shared tree (evidence only, not ratified)**, **§4 gap analysis of that code against the decided architecture**, **§5 consistency of the three rulings**, **§6 standing constraints**.
Labels: **DECIDED · NOT RATIFIED · NOT AUTHORIZED · VERIFIED (source read; executed where stated) · PROPOSED · NOT VERIFIED**.

---

## 1. Decision Records

### DP-8 — On-Prem Compatibility — **DECIDED — Option 8-1**
- The SaaS Control Plane must **not** become a prerequisite for running DAII On-Prem.
- Preserve: On-Prem independence; Company operational autonomy; **no** SaaS subscription / billing / control-plane dependency forced on a local installation; the **same Core architecture** wherever possible — a difference of deployment/control plane, **not a product fork**.
- Any SaaS-only service is an **optional control-plane capability**, never an operational dependency of On-Prem.
- The ADR-015 business question (does DAII commercially license On-Prem?) remains **open**; this ruling does not answer it.
- **Implementation: NOT AUTHORIZED** until the DP-1 / DP-4 dependency implications are assembled.

### DP-4 — Platform Identity, Roles & Separation of Duties — **DECIDED — Option 4-A**
- **Platform Authority ≠ Company Operational Authority.** Model B stays: Platform DB → identity, membership, control-plane concerns; Company DB → operational roles and permissions.
- Platform Admin does **not** automatically become a Company Super Admin; **no implicit privilege escalation** through the SaaS Control Plane.
- Any Support/Platform access to Company operations must be **explicit, monitored and scope-limited**.
- Consistent with DP-9 O-3: Platform Admin manages platform-level concerns but has **no bypass** of the Company `READY` rule.
- **Implementation: NOT AUTHORIZED.** (Role set, store design, separation-of-duties rules and the Support-access mechanism are implementation-package questions — §2.)

### DP-1 — Entitlement Runtime Resolution — **ARCHITECTURE DECIDED IN PRINCIPLE — CONDITIONAL**
> **Per-Company entitlement resolution, using an explicit Company context, with the signed manifest / runtime artifact remaining part of the authority chain, and no default or ambient Company context.**

| Item | State |
|---|---|
| DP-1 architecture direction | **DECIDED** |
| Existing Plans implementation | **NOT RATIFIED** |
| DP-1 implementation authorization | **NOT YET GRANTED** |

**Two conditions before this direction can become an implementation authorization:**
1. **Area 21.** Entitlement enforcement may **not** be claimed complete on all Company routes while 16 controllers remain outside the Company-context boundary — VERIFIED: they are exactly the 16 remaining Area 21 controllers (`accounting ap ar attendance cash-bank commission fixed-asset hr inventory-accounting invoices payroll returns rfq sales supplier target`); the other 27 of the 43 module-guarded controllers have `CompanyContextGuard`.
2. **Plans code is not the reference merely because it exists.** Required sequence: **DP-1 architecture → Existing-Plans gap analysis → authorization.** Not: existing Plans → ratification.

---

## 2. Still open inside Batch A (to be settled by implementation packages, not by this record)

| DP | Open sub-decision | Note |
|---|---|---|
| DP-8 | Whether an explicit deployment-mode switch (8-2) is needed to keep SaaS-only surfaces off On-Prem builds; whether plan tables belong in the `core` migration tag that On-Prem also runs | No deployment-mode flag was found in the code read; the as-built Plans migration is in `core` |
| DP-8 | ADR-015 on-prem licensing | Business decision, not answerable from code |
| DP-4 | Platform role set, store design (separate tables vs namespace within 4-A), separation-of-duties rules, key-custody ownership, the explicit/monitored/scoped Support-access mechanism | Support access has **no V1 bypass** under DP-9 O-3 |
| DP-4 | Treatment of the dormant platform-style nodes already in Company `admin` roles (§6) | Standing constraint, not yet a work package |
| DP-1 | Is the per-Company runtime artifact itself signed (a signed Company artifact), or is the signed **installation** manifest the sole signed element with Company plan data unsigned? | The CTO text keeps "the signed manifest/runtime artifact" in the chain; the exact shape is **not** decided |
| DP-1 | Key custody (who may sign; may the Control Plane sign) | Depends on DP-4 |
| DP-1 | Behavior of a Company with no package; cache TTL and invalidation (Gate D); exact wording of partial-enforcement claims until Area 21 | |
| DP-1 | Interaction with the DP-9 Lifecycle Admission Boundary (§4, G-5) | |

---

## 3. What exists in the shared tree — AS-BUILT EVIDENCE, **NOT RATIFIED** (formerly "DP-1.0")

**CTO ruling on DP-1.0: REJECT AS AUTHORIZATION / RETAIN AS EVIDENCE.** Classification: **FOREIGN IMPLEMENTATION — NEEDS RE-PROOF / UNRATIFIED.** Not to be reverted, not to be discarded, not to be treated as approved.
Reasons recorded by the CTO: it appeared before any DP-1 ruling; its authorization is unknown; it modified a shared engine (`RequireModuleGuard`); it introduced `COMPANY_ENTITLEMENT_RESOLVER`; it has effects on a suspended Company; the 16 remaining controllers tie it directly to the Area 21 boundary.

| Item | Fact | Class |
|---|---|---|
| Components | `foundation/plans/`: `Plan`, `PlanModule`, `CompanyPlanAssignment`; `PlanService`; `CompanyPackageService` (assign a plan; sync role templates/grants into the Company DB); `CompanyEntitlementService` (per-Company resolver; 15 s in-process cache keyed by `companyId`; `effective = assigned package ∩ installation licence`; no package ⇒ installation entitlement unchanged); `CompanyViewContextService` (backs `/me/navigation`, `/me/entitlements`); `PlansController` (`@RequireRole('admin')`); migration `core/1789890000000-CreatePlansAndCompanyAssignments`; `PlansModule` `@Global()` and in `app.module.ts`; front-end pages | VERIFIED (read) |
| Shared engines modified | `entitlement-resolver.token.ts`, `require-module.decorator.ts`, `require-feature.decorator.ts` (guards now `async`; use the per-Company resolver when `request.companyContext.companyId` exists, else the installation-wide check), `entitlement.controller.ts`, `navigation.*`, `app.module.ts` | VERIFIED (git diff) |
| Who | "DAII HR (fork)" session — verbatim Write result for `company-package.service.ts`; rest of the group by co-location (inferred). Migration header cites "CTO: 'Super Admin workflow — create a company, assign its package'" — **an assertion inside a file; not received by this workstream; not verified** | VERIFIED (attribution) / NOT VERIFIED (authorization) |
| Corroboration | its generated `docs/acceptance/MODULE_ENFORCEMENT_COVERAGE.md` computes the same 27 / 16 split | VERIFIED |

**Out of Batch A (CTO):** the **Approval Engine** retrofit from the same session is **NOT AUTHORIZED — HOLD / NEEDS RE-PROOF**, no revert, and is not part of this package; no isolation spec it added grants retroactive authorization. The Event Engine work ("Multi-Company front") likewise stays NEEDS RE-PROOF.

---

## 4. Gap analysis — DP-1 decided architecture vs the as-built Plans code (read-only; evidence for the authorization decision, not an endorsement)

| # | Requirement from the decided architecture / rulings | As-built (VERIFIED by reading; nothing executed against the Plans code) | Verdict |
|---|---|---|---|
| G-1 | Per-Company resolution | `CompanyEntitlementService.resolve(companyId)`; guards use the resolver | satisfied in code (unratified) |
| G-2 | **Explicit** Company context, no default/ambient context | Guards read only `request.companyContext.companyId` (set by `CompanyContextGuard`); never the JWT claim | satisfied in code (unratified) |
| G-3 | No default Company on routes without context | Routes without a validated context fall back to the **installation-wide** check — no Company is invented, no widening to platform privilege | satisfied in code; **consequence = partial enforcement** (27/43) until Area 21; a Company on a narrower package keeps the installation's full module set on the 16 |
| G-4 | Signed manifest / runtime artifact stays in the authority chain | The signed **installation** licence is the ceiling (`package ∩ installation`); Company plan assignment rows are **unsigned**; the existing per-Company signed-manifest writer remains unused | **OPEN** — the decided text does not say whether a Company-level artifact must itself be signed (§2) |
| G-5 | Respect DP-9 + Lifecycle Admission Boundary | `CompanyPackageService` and `CompanyViewContextService` open a Company DataSource checking only Membership + registry `ACTIVE`; `/me/navigation`/`/me/entitlements` return a view for a `SUSPENDED` Company; plan assignment forbids only `DECOMMISSIONED` | **GAP** |
| G-6 | Shared-engine changes are re-proved | Both guards changed from sync to `async`; no re-proof of the 43 module-guarded controllers by this workstream | **GAP** (NEEDS RE-PROOF) |
| G-7 | Platform authority per DP-4 4-A | Plan authority is the single platform `admin` role; no platform-role separation exists | **GAP** (depends on DP-4 implementation) |
| G-8 | DP-8 8-1: SaaS-only capability optional, never an On-Prem dependency | Resolver is `@Optional()`; no assignment ⇒ unchanged behavior; but the module is loaded unconditionally and its tables live in the `core` migration tag that On-Prem also runs | **OPEN** (inert, not a dependency; "optional capability" shape undecided) |
| G-9 | Entitlement ≠ permission (ADR-055) | Assigning a package adds grants and never removes any; the Company `admin` already holds every module root (executed, WP-0.5c) → a package that excludes a module does **not** remove the admin's permission nodes; entitlement is the only gate | **FINDING** — must be stated in any "package enforced" claim; live on the 16 controllers |
| G-10 | Cache and consistency | 15 s in-process TTL with exact invalidation in-process; cross-process staleness bound not verified | **OPEN** (Gate D; distinct from the DP-9 no-cache rule for lifecycle status) |
| G-11 | Limits / term / subscription | Plans carry modules only | **OUT OF SCOPE** of DP-1 (DP-5/DP-6) |
| G-12 | Latent authority not activated by accident | Not addressed by the code | **STANDING CONSTRAINT** (§6) |

Reading the table: the code realizes the *shape* of the decided direction (G-1, G-2, G-3) but leaves gaps (G-5, G-6, G-7), a finding (G-9), two open architecture questions (G-4, G-8) and one open consistency question (G-10). Nothing here ratifies it.

---

## 5. Consistency of the three rulings

| Pair | Check | Result |
|---|---|---|
| DP-8 8-1 × DP-1 | The signed installation manifest remains the only thing On-Prem needs; Plans/per-Company resolution is optional and inert when unused | consistent; the "optional capability" *shape* is open (G-8) |
| DP-4 4-A × DP-1 | Plan/entitlement authority needs a platform owner distinct from Company authority | consistent; **DP-1 implementation depends on DP-4 implementation** (G-7) |
| DP-4 4-A × DP-9 O-3 | Platform Admin: platform concerns only, no READY bypass | consistent |
| DP-1 × DP-9 | Entitlement resolution must not widen access to a non-READY Company | consistent in principle; **GAP G-5** until the Lifecycle Admission Boundary exists |
| DP-1 × Area 21 | No default Company context; partial enforcement stated | consistent; Condition 1 |

**No substantive conflict** among the three rulings.

---

## 6. Standing constraints recorded from this round

1. **Latent authority (CTO):** every Company `admin` role already holds `core.limit.edit`, `core.entitlement`, `core.config`, `system.release` (+ every module root) from the core migrations (executed, WP-0.5c). `/limits` is platform-DB only today, so these grants are inert. **Rule:** no route may gain Company context while checking a `core.*`/`system.*` node — and the limits architecture may not be evolved — without first reviewing those nodes against the Company `admin` grants, so this authority is never activated by accident.
2. **F4 (Phase-0 study) is SUPERSEDED** by the real-Postgres characterization and **may not be used** as a basis for any DP-4 or DP-6 decision.
3. **Evidence hygiene:** results are valid only for their tested source state; any run touching the migration runner must hash `dist/database/migrations` as well as `src`.
4. **Foreign changes** (Plans, Approval Engine, Event Engine) are never reverted and never counted as Area 21 or Batch A evidence until re-proved.

## 7. State and next step

| Item | State |
|---|---|
| DP-8 / DP-4 | DECIDED (8-1 / 4-A); implementation NOT AUTHORIZED |
| DP-1 | architecture DECIDED IN PRINCIPLE / CONDITIONAL; Plans code NOT RATIFIED; implementation NOT AUTHORIZED |
| Approval Engine retrofit | HOLD / NEEDS RE-PROOF; outside Batch A |
| WP-0.4 | **NOT MET** while other workstreams write to the tree |
| Next | Batch B and C (DP-6, DP-5, DP-7; DP-3, DP-2) are prepared against these rulings only on the CTO's call; **no implementation of any kind starts from this package.** |
