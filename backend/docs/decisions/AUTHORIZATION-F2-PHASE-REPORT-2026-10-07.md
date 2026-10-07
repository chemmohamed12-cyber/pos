# Authorization Foundation — F2 Phase Report: Company Users, Invitations, Multi-role (2026-10-07)

Scope (CTO directive 2026-10-06/07): Company Users directory (membership-based, backend-enforced) · invitation + acceptance (remove the UUID-attach model; uniform responses; no identity-existence leak) · multi-role 0..n with the Company `user_roles` as authority and the membership as belonging + compatibility mirror · last-administrator protection · audit · no automatic role elevation.
Environment: isolated PG 127.0.0.1:5656 (bv_* DBs, backend 3601, frontend 5601). `daii_dev` and Production untouched. No push.
Prerequisite: F1 closed VERIFIED → UAT READY (`1c562e6`).

## 1. What was implemented

**Data model (additive, idempotent core migrations).**
- `1790003000000-MembershipLifecycleAndInvitations`: `user_company_memberships` + `status` (`active`/`suspended`, CHECK also reserves `invited`/`removed`), `joinedAt` (backfilled from `createdAt` exactly once), `invitedBy`, `lastAccessAt`, `authzVersion`; new `company_invitations` (only the SHA-256 of the token is stored; one pending invitation per Company+e-mail); `membership_operations` + `previousRoleKeys`/`targetRoleKeys`. Every existing membership stays `active` (nobody loses access); `down` is a deliberate no-op (additive-only rollback).
- `1790004000000-SeedCompanyUsersTerminology`: the sidebar label.

**Authority model.** The Company database's `user_roles` is the single source of truth for what a member can do. `user_company_memberships.roleKey` is a READ-ONLY compatibility mirror (= primary role: an administrator role first, else the previous primary if still held, else alphabetical; `-` for "no roles"), recomputed from the authority and bumped via `authzVersion`. Every role/status change changes the authority FIRST, inside one Company transaction that also takes a per-Company administration advisory lock, then syncs the mirror through the durable operation ledger (`role_set`); the reconciler heals a failed mirror sync by recomputing from the authority (never the other way round).

**Company Users backend** (`/company/users`, no company identifier in any route — the Company is the one `CompanyContextGuard` validated for the token):
`GET /` directory (members of THIS Company only: control-plane membership rows keyed by the validated companyId → identities by those ids → roles from the Company DB) · `GET /roles` (the Company's roles + whether this actor may assign each) · `GET|POST|DELETE /invitations` · `PUT /:userId/roles` (full role set, 0..n) · `PATCH /:userId` (suspend / reactivate) · `DELETE /:userId` (remove). Reads need `core.company.members.manage` read-only, every write editable (wiring locked by a spec).

**Invitation + acceptance** (`/invitations/preview|accept|register`):
- creation is IDENTICAL for an e-mail that has an identity elsewhere and one that has none; the only fact a Company can learn is about its OWN directory (an e-mail already a member of this Company is refused);
- token = 256 random bits, single-use (atomic `UPDATE … WHERE status='pending'`), 7-day expiry, supersede on re-invite, revoke; unknown / expired / used / revoked / wrong-e-mail all answer the same `INVITATION_INVALID` 404;
- an EXISTING identity accepts only by being signed in as the invited e-mail (a token can never set a password on, or take over, an existing account); a NEW identity is created only for an e-mail with no account, with the invitee's own password and NO role other than what the Company membership grants (not even `register`'s first-user bootstrap `admin`);
- at acceptance the roles are re-validated against the INVITER's current authority (still holds `members.manage` and every grant of every invited role) — a demoted inviter cannot leave a live grant behind;
- delivery is `manual` (no mail system exists): the one-time link is returned once to the inviter.

**Removed:** the Company-plane `POST /memberships` (attach any existing identity by raw user id) and its controller. The platform plane keeps `/installation/companies/:companyId/memberships` (platform `admin`; support/bootstrap; audited) until F4 moves it behind `platform.*` + time-boxed support access.

**Security rules enforced in the service (not only the UI):**
- *Anti-self-elevation:* an actor may add or remove a role only if they hold every grant that role carries (evaluated on their request-scoped AuthorizationContext); nobody can change their own roles, suspend or remove themselves; re-activation restores only the roles still held — it never grants anything.
- *Last administrator:* counted on the AUTHORITY (administrator-role holders in the Company DB who still have an ACTIVE membership); demote / suspend / remove of the last one is refused (`LAST_ADMIN`); two concurrent removals serialise on the advisory lock and exactly one wins.
- *Suspension / removal* are enforced on the very next request by `CompanyContextGuard`, `select-company`, refresh, `/memberships/mine` and the Company view (all read only ACTIVE memberships); `/auth/me` degrades a suspended membership to the platform view.
- *Audit:* `role.assigned|removed`, `membership.invited|accepted|suspended|reactivated|removed|invitation_revoked`, `role.assignment.denied|blocked_last_admin`, `invitation.denied` in the Company's own hash-chained audit, plus `company.membership.*` in the platform chain, same correlation id; refusals are audited with result `denied`.

**Frontend:** Company Users page (`/company-users`: directory, multi-role editor with the anti-elevation hint, suspend / reactivate / remove, invitation form + one-time link + pending invitations with revoke) and the public Accept-Invitation page (`/accept-invitation`: accept as the signed-in matching account, explains a mismatch, sign in, or create the account); server-driven sidebar item gated by `core.company.members.manage`; Login returns to a pending invitation; `api.put/patch` added.

## 2. Files
Backend (new): `company/{company-user-roles.ts, company-user-management.service.ts, company-invitation.service.ts, company-invitation.entity.ts, company-users.controller.ts, company-invitations-public.controller.ts}`, 2 core migrations. Modified: `membership.entity.ts`, `membership.service.ts`, `membership-operation.{entity,service}.ts`, `membership-reconciliation.scheduler.ts`, `company-membership-provisioning.service.ts`, `company-context.guard.ts`, `company.module.ts`, `memberships-mine.controller.ts`, `authentication/{auth.service.ts, auth-me.service.ts}`, `identity/users.service.ts`, `plans/company-view-context.service.ts`, `navigation/navigation-registry.ts`. Removed: `company-membership.controller.ts` (+ spec).
Frontend: `pages/{CompanyUsers.tsx, AcceptInvitation.tsx}`, `App.tsx`, `pages/Login.tsx`, `context/AuthContext.tsx`, `lib/api.ts`.

## 3. Tests
| Spec / check | Result |
|---|---|
| `company-users.f2.real-pg.spec` (real PG, two disposable Companies + control plane) | 13/13 |
| `company-users.controller.spec` (route/permission wiring; no UUID-attach route) | 4/4 |
| Mutation check: with the administration lock removed the concurrency test FAILS (2 of 2 removals succeed → zero admins); with it, exactly one wins | proven both ways |
| Existing specs adapted to the active-membership lookup (guard, auth service, area-5/6 acceptance, permission-path acceptance) | pass |
| `auth-me.contract` after the join change | 8/8 |
| Real HTTP against the booted backend (`f2-http.js`, isolated env) | all checks PASS (see §5) |
| Browser (isolated 5601): sidebar item, invite → link, mismatch message, sign-out, create account → lands in the Company with ONLY the invited role's menus, no admin menu, direct URL → "no permission", multi-role save, suspend, reactivate, remove, revoke | verified |

## 4. Regression (affected areas: foundation, procurement, accounting company-isolation, treasury, sales-orders, crm, inventory-warehouse)
Serial run on the final code: **105 suites, 712/729 first run.** The only 17 failing tests are the 4 environment-guarded characterization suites (`provisioning-lifecycle`, `module-add-existing-company`, `limits-scope`, `ui-created-company-admin`), which refuse to start by design (they require the isolated HR instance on 127.0.0.1:5544 owned by another session) — identical to the pre-F1 build and to the F1 gate run; NOT executed here and NOT claimed as passing. Everything else is green, including `grni-posting` (its failure window is 00:00–03:00 Cairo, see the F1 report §9) and the Protected Baseline suites that live in these folders (NAV, ESC-3, procurement PRC-01, treasury, sales-orders, inventory). The accounting/HR baseline suites (D1–D10, T0, journal numbering, FA-02) are outside this affected area and are covered by the full-repo regression at the final release gate (standing rule); F2 touches no accounting or HR code. Existing specs that mocked the membership lookup were updated to the new active-only lookup; no assertion was weakened.

## 5. Security / isolation evidence (real HTTP + real PG)
Directory A/B: Verify Co token lists exactly Verify Co's members, Fresh Co 3 token exactly its own; a forged `?companyId` / `x-company-id` changes nothing; platform token with no Company → 403; unauthenticated → 401; `POST /memberships` (Company route) → 404. Invitations: identical response shape for known-elsewhere vs unknown e-mail; only the hash stored; token single-use; a token for an e-mail that already has an account cannot register over it (409, must sign in); the new member holds exactly the invited role and no platform role; an unprivileged member gets 404 on the directory and on inviting; cannot change own roles (403); suspension → the member's next Company request is 403 and `select-company` 401, the Company disappears from `/memberships/mine`; re-activation restores exactly the same role; removal → directory no longer lists them; another Company's administrator cannot revoke this Company's invitation (404). Company and platform audit chains verify.

## 6. Performance (interleaved A/B vs the pre-F1 build, 4 runs × N=100, zero non-200 — stricter harness, see the F1 report addendum)
| Endpoint | pre p50/p95 (ms) | F2 build p50/p95 (ms) | Δp50 | Δp95 |
|---|---|---|---|---|
| auth/me | 7.2/10.4 | 7.1/11.3 | −0% | +8% |
| me/navigation | 107.3/184.1 | 7.8/11.8 | −93% | −94% |
| memberships/mine | 6.2/8.9 | 6.7/9.6 | +8% | +8% |
| accounting/accounts | 9.7/15.6 | 11.1/17.0 | +14% | +9% |
| sales-orders | 10.1/15.7 | 11.0/16.6 | +8% | +5% |
| approvals/requests | 9.0/14.4 | 8.2/11.9 | −9% | −17% |
| purchase-orders | 9.9/15.2 | 8.9/13.2 | −10% | −13% |
| organization/units (F1 intentional boundary cost) | 5.0/6.9 | 7.0/10.1 | +39% | +46% |
| **company/users (new, F2)** | n/a | 8.6/12.8 | — | — |

F2 adds no statement to the hot guard path (`CompanyContextGuard` still reads one membership row; it now also filters `status='active'`, same index). Every normal guarded route stays within the +25% budget; the new directory route costs about one guarded list call. `/auth/me` is at parity (inside run-to-run noise: Δp50 −7%…+12%).

## 7. Status
**F2: IMPLEMENTED · INTEGRATED · VERIFIED (isolated environment) → UAT READY**, with the residual items in §8 (none is a red gate: no cross-company exposure, no privilege escalation, no ability loss, no Protected-Baseline regression, no last-admin lockout, audit chains verify, performance inside the budget).
AZ mapping: AZ-10 (no Company user directory) closed · AZ-11 (onboarding) closed up to the mail-delivery decision · AZ-06 (single role per membership) closed · AZ-07 (user/membership part: membership + role changes audited in both DBs; the platform `/admin/*` writes remain F4) closed for the Company plane · AZ-01 closed for Company users (Company Users replaces role assignment through the platform Admin screen; the platform screen's own visibility is the F4 residual in §8.4).

## 8. Decisions recorded, residual risks and CTO items
1. **Invitation is a separate table, not a membership status.** No identity or membership exists until acceptance (no enumeration, nothing to clean up); the Blueprint's `invited`/`removed` membership states stay reserved by the CHECK; removal deletes the row (history lives in the audit chain).
2. **Mail delivery (CTO decision needed, not blocking F3).** With no mail system the one-time link goes to the INVITER. For an existing account this is safe (must sign in as that e-mail). For a NEW identity the holder of the link sets the password, so proof of mailbox ownership relies on out-of-band delivery. Production-grade onboarding needs an SMTP/mail provider decision; the service already isolates `deliveryMode` for it. Acceptance by a not-signed-in token holder also reveals "this e-mail already has an account" (409) to that holder — acceptable only because, with mail, the holder is the mailbox owner.
3. **Second approver for granting Critical capabilities (D16)** is still a Gate question; F2 enforces "you cannot grant what you do not hold" without it.
4. **AZ-01 residual (platform plane).** The platform Admin screen (`/admin`, `/integrations`, `/release-center`) is still platform-global and its sidebar entry is evaluated against role keys, so a Company-only administrator can still see a link that answers 403. Company administrators now have the correct screen (`/company-users`); the platform screens move to `platform.*` nodes and the platform/Company screen split in F4.
5. The Organization screen still reads `/admin/users` for its member picker (platform plane) — F5/F4 scope.
6. `roleKey` mirror shows `-` for a member with no roles; `/memberships/mine` therefore lists such a Company with `roleKey: '-'`.
7. The four characterization suites (HR instance, port 5544, another session) remain not executed by this session.

## 9. Gate evidence index
- Real PG: `company-users.f2.real-pg.spec.ts` 13/13; wiring `company-users.controller.spec.ts` 4/4; mutation proof of the administration lock (fails without, passes with).
- Real HTTP: `authz-tools/f2-http-verification.js` — 29 PASS / 0 FAIL on the rebuilt backend (isolated 3601); archived with the F1 script, the A/B harness and a README.
- Browser (5601): sidebar entry `/company-users`; invitation created from the form (one-time link shown); link opened while signed in as another account (mismatch explained, sign-out offered) → signed out (sign in / create account offered) → account created → lands in the Company with ONLY the invited role's menus (7 sidebar links, no Company users / Organization / Admin) → direct URL `/company-users` shows "no permission" (backend 404); then as the Company administrator: multi-role save (`sales.rep` + `sales.viewer`), suspend, re-activate, remove, and revoke of the stale pending invitations — all through the UI. One real UI defect was found and fixed during this check (the role picker was declared inside the page component and remounted on every keystroke).
- Regression: §4. Performance: §6.
- Commit: see the git log entry `feat(authz): F2 …` (no push).

## 10. CTO items
1. Mail provider decision for production-grade invitations (§8.2) — not blocking F3.
2. D16 (second approver for Critical grants) — still a Gate question; F3 introduces the Critical flag.
3. Execution of the four port-5544 characterization suites, if you want them run before F3.
