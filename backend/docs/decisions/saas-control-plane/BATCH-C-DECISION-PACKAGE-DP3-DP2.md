# Batch C — DP-3 / DP-2 — Decision Package (docs only)

**Status:** PROPOSED / EVIDENCE ONLY — nothing here is decided, authorized or implemented. 2026-10-05.
**Method (same as Batch A v2 / Batch B):** Decided/Open/Conditional → Verified evidence → Existing-tree evidence (separate) → Dependencies → Conflicts/gaps/risks → Recommended bundle (PROPOSED) → Authorization status → Stop conditions.
**Not touched:** code, migrations, guards, Plans, Approval Engine, Event Engine. Labels: **DECIDED · OPEN · CONDITIONAL · VERIFIED · NOT FOUND · NOT VERIFIED · PROPOSED**.

> **CTO RULINGS 2026-10-05 on this package — authoritative; the option text below is the original proposal.**
> **DP-3 — DECIDED: Additive Invitation Model.** An invitation flow **on top of D1, not replacing it.** Constraints: (1) D1 stays valid for the existing-user membership path; (2) an invitation never creates a Platform Admin; (3) it creates/links a **Company membership** within one specific Company; (4) permissions come from **Company RBAC**, not from the invitation; (5) the inviter never sends a password; (6) the invitation is **one-time, expirable and auditable**; (7) it is bound to one Company and cannot be reused for another; (8) the existing `pending` status may be reused if review shows it fits — no parallel lifecycle without reason.
> **Invitation Core = DECIDED. Delivery Transport = DECIDED (CTO, later 2026-10-05): V1 is transport-independent with out-of-band delivery of the link/token outside DAII; the invitee creates their own credential; no Email, WhatsApp, SMS or Notification Engine integration within DP-3 without a separate decision, and no implementation may turn out-of-band into one of those.** (Earlier wording preserved here: Delivery Transport was OPEN) — the engine must be transport-independent; V1 may hand the token/link over outside the system, but Email/WhatsApp/SMS are **not** part of DP-3 implementation without a separate decision. ("out-of-band links" in §6 is *not* adopted as a full execution decision.) **Implementation: NOT AUTHORIZED.**
> *Still open inside DP-3 (not ruled):* whether an invitation may carry a requested `roleKey` reference (constraint 4 says permissions come from Company RBAC, not the invitation); who may issue which invitation (first Company Admin vs staff) in detail; seat-accounting moment (DP-6); rate limiting and token format.
> **DP-2 — DECIDED: XNEXUS is Platform-Level, not a DAII Company.** XNEXUS is **not** represented as an operational Company/tenant inside DAII (structure: Installation/XNEXUS Platform → Company A/B/C; **not** an XNEXUS Company containing customer Companies). No artificial XNEXUS Company may be created to ease permissions or entitlement. This supersedes the `Layout.tsx` code comment as a formal architectural decision and **overrides the earlier PROPOSED lean (option B after DP-4)**. DP-2 authorizes **no** change to platform/Company authority — that belongs to DP-4. **Implementation: NOT AUTHORIZED.** *Consequence noted, not ruled:* if XNEXUS ever needs to run its own business in DAII, that is a separate installation/decision; this ruling does not address it. DP-5's "internal subscription for XNEXUS" and any "owner plan" are therefore out of scope.

## 0. Inherited decisions (binding on this batch)
D1 (provisioning/membership management never create a `User`; `initialAdminUserId` must exist) · D7 (no READY Company without an administrator) · Model B · DP-9 DECIDED (only `READY` grants access; no support bypass) · DP-8 DECIDED 8-1 (SaaS capabilities optional, never an On-Prem dependency) · **DP-4 DECIDED 4-A** (Platform Authority ≠ Company Operational Authority; no implicit escalation; any Support/Platform access to Company operations explicit, monitored, scope-limited) · DP-1 architecture DECIDED IN PRINCIPLE / CONDITIONAL · F4 SUPERSEDED · R14 latent authority · CD-1 on the Risk Docket · WP-0.4 NOT MET · Plans / Approval / Event Engine work = NEEDS RE-PROOF. **Implementation of everything: NOT AUTHORIZED.**

---

## DP-3 — Company Admin Invitation / Onboarding

**1. State.** OPEN. Conditional on DP-4 implementation (who may invite) and on a transport decision; must not supersede D1 unless the CTO says so.

**2. Verified evidence (source read; nothing executed in this batch).**
- **The only user-creation path is `POST /auth/register`.** Bootstrap-only for the first user (who becomes platform `admin`); afterwards it requires an authenticated **platform `admin`** caller. It **auto-activates** the account with **no invitation and no email verification**, and the **admin supplies the password**. Throttled (5/min). There is **no other "create user" endpoint** (the controller's own comment says so).
- `POST /admin/users/:id/reset-password` lets a platform admin **set** a user's password directly (revokes sessions); no self-service password setup for a new user.
- Login blocks any user whose status is not `active`; the default status is `pending`; there is a failed-attempt lockout. So a `pending` state already exists and is already blocking.
- Company onboarding today: the Create Company screen is a **picker over `GET /admin/users`** — the operator must create the User first, then choose it as `initialAdminUserId`.
- **A Company Administrator cannot create a User** (D1: membership management only grants a membership to an existing User; creating a User needs platform `admin`). Users are global identities in the platform database; a Company's staff are memberships.
- **No notification/email transport exists:** `foundation/notification/` is a README stating "NOT IMPLEMENTED — skeleton only". No MFA/TOTP concept was found.

**3. Existing-tree evidence (not ratified).** A front-end page `CompanyMembers.tsx` exists in the control-plane pages (another workstream, 2026-10-05 00:02; **not reviewed here**). No backend invitation code exists in the Plans work.

**4. Dependencies.**
- **DP-4 4-A:** an invitation must not give a Company admin platform authority; the identity-creation step is a platform-identity act, so who may trigger it needs a platform-side rule.
- **DP-9:** an invitation into a non-READY Company must not yield operational access.
- **DP-8 8-1:** On-Prem installations must keep the current manual path; invitation must be an optional capability.
- **DP-5/DP-6:** `users.max` (DP-6) counts memberships or users — invitations must decide when a seat is consumed (at invite, at acceptance).

**5. Conflicts / gaps / risks.**
- **Credential handling:** the platform admin chooses and therefore knows the initial Company Admin's password; the account is active at once.
- **Gap against the intended SaaS split:** the target model has the Company Admin managing the Company's employees, but a Company Admin has no way to create the Users those employees need — only platform `admin` can.
- No delivery channel: any invitation link must travel out-of-band until a notification component is separately decided.
- Invitation tokens are a new credential class: expiry, single use, revocation, audit and rate limiting are all undefined.
- A new identity flow sits next to D1 and next to `AuthService` (a shared engine) — blast radius and re-proof.

**6. Options (PROPOSED only).**
- **A** — keep the current path: platform admin pre-creates the User; passes `initialAdminUserId`.
- **B** — additive invitation record; the User and credential are created by a **separate identity flow when the invitee accepts** (status `pending` → `active`); the **unchanged** provisioning/membership paths then receive the existing `userId`. D1 stays literally true.
- **C** — provisioning creates the User directly (supersedes D1; needs an explicit ruling).
- **Sub-decisions for B:** who may issue an invitation (platform authority per DP-4 for the first Company Admin; Company `core.company.members.manage` holders for staff — scoped to their own Company); transport (out-of-band link vs a new notification component); first-credential setting by the invitee; expiry/single-use/revocation; audit record; rate limit; seat accounting (DP-6).

**Recommended bundle (PROPOSED):** B as a component *beside* Membership Management (never inside it); first-Company-Admin invitations issued by platform authority, staff invitations by the Company's member-management permission; out-of-band link in V1; invitee sets their own password; seats counted at acceptance. Start with a design package only.

**7. Authorization.** NOT AUTHORIZED. **8. Stop conditions.** No new user-creation or token code; no change to `AuthService`/`AuthController`; no change to D1; no notification component; no invitation that grants any operational access before acceptance and `READY`.

**Questions for the CTO.** (a) Keep D1 literally (B) or supersede it (C)? (b) Who may invite whom (first Company Admin vs staff)? (c) Transport for V1. (d) Seat accounting moment. (e) Is the current "admin chooses the password" path acceptable for On-Prem only, or to be retired?

---

## DP-2 — XNEXUS as a Tenant

**1. State.** OPEN. Conditional on DP-4 **implementation** (the *decision* 4-A removes the conceptual blocker; the separation does not yet exist in code).

**2. Verified evidence.**
- The only statement of the current position is a **code comment** in `Layout.tsx`: the Control Plane menu is "not a Company-scoped nav item and **XNEXUS is not an operational Company tenant**". It is not an ADR.
- Nothing in the code prevents creating a Company named XNEXUS through the existing flow; it would be an ordinary Company with its own database and administrator.
- Structural separation already exists on paper: platform authority = platform `roles/user_roles`; Company authority = roles inside the Company database; membership links a global User to a Company. The same person can hold both.
- The first registered user becomes platform `admin` (bootstrap). Platform admin surfaces use `@RequireRole('admin')` (platform), not Company permissions (VERIFIED).
- **Latent authority (R14, executed):** every Company `admin` role holds platform-style nodes (`core.limit.edit`, `core.entitlement`, `core.config`, `system.release`) — harmless today because those routes have no Company context, but an XNEXUS Company admin would carry them too.
- The installation manifest's `customer_name` identifies the licence customer of the installation; in SaaS the host installation is XNEXUS's own — no concept of "operator vs customer" exists in that row.

**3. Existing-tree evidence (not ratified).** None specific to DP-2; the Plans work adds assignment of packages to Companies, which would apply to an XNEXUS Company as to any other.

**4. Dependencies.** **DP-4 implementation (hard prerequisite):** a person who is both a platform operator and an XNEXUS Company member must not inherit either authority from the other. DP-5 (an internal subscription for XNEXUS), DP-6 (internal limits), DP-9 (an XNEXUS Company is subject to the same READY rule; platform administration stays available per O-3), DP-8 (nothing On-Prem-specific).

**5. Conflicts / gaps / risks.**
- Without implemented platform-role separation, the single `admin` role is both the operator and (potentially) the XNEXUS operational administrator.
- Self-referential operation: the Control Plane provisioning, backing up and suspending its own tenant; an XNEXUS suspension must never lock out platform administration (consistent with O-3, but unproven).
- The existing comment would need an explicit superseding record; it must not be overridden implicitly.
- Dormant platform-style Company grants (R14) apply to XNEXUS as to everyone.

**6. Options (PROPOSED only).** **A** — XNEXUS owns the platform only and uses no ERP (status-quo comment, made an explicit decision). **B** — XNEXUS is an ordinary Company with its own database, administrator and internal subscription; platform authority remains a separate identity axis (DP-4 4-A). **C** — B plus a documented internal "owner" plan/exception.
**Recommended bundle (PROPOSED):** keep **A** until DP-4 is **implemented and proven**, then adopt **B** with no owner exception unless a concrete need appears; require a superseding record for the `Layout.tsx` position.

**7. Authorization.** NOT AUTHORIZED. **8. Stop conditions.** No creation of an XNEXUS Company as a decision-by-fact; no change to the existing comment or navigation; no grant of Company roles to platform operators; no special plan or exemption.

**Questions for the CTO.** (a) Does XNEXUS use DAII operationally (dogfooding) at all? (b) If yes, after DP-4 implementation — B or C? (c) Must platform administration be provably unaffected by the XNEXUS Company's own status?

---

## Batch C bundle, dependencies and status (PROPOSED)

| Order | Package | Needs first | Authorization |
|---|---|---|---|
| 1 | DP-3 | DP-4 implementation (who invites), **transport decision (open)** | **DECIDED (additive invitation); implementation NOT AUTHORIZED** |
| 2 | DP-2 | — (no code consequence) | **DECIDED (platform-level, not a Company); implementation NOT AUTHORIZED** |

**Consistency with Batches A/B:** no conflict — DP-3 and DP-2 inherit DP-4 4-A and DP-9 as decided; DP-3's seat accounting ties to DP-6; DP-2's internal subscription ties to DP-5. Both touch shared engines (identity/authentication; platform roles) and so wait on WP-0.4.

## Decision docket after Batches A–C (all PROPOSED unless marked)

| DP | State |
|---|---|
| DP-9 | DECIDED (implementation NOT AUTHORIZED; Lifecycle Admission = separate package) |
| DP-8 | DECIDED 8-1 |
| DP-4 | DECIDED 4-A |
| DP-1 | architecture DECIDED IN PRINCIPLE / CONDITIONAL |
| DP-6, DP-5, DP-7 | PENDING CTO REVIEW — Batch B prepared |
| DP-3 | **DECIDED** (additive invitation; transport OPEN) |
| DP-2 | **DECIDED** (XNEXUS platform-level, not a Company) |
| CD-1 | **DECIDED — policy** (see `CD-1-ARCHITECTURE-RISK-DOCKET.md`); repair NOT AUTHORIZED |
| Lifecycle Admission (LA-1) | PACKAGE DEFINED — specification required; implementation HOLD |
