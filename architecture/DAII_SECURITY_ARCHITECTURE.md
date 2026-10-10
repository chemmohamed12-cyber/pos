# Daii Security Architecture

Status: **DRAFT — Stage 1 Planning.**
Covers Identity, Authentication, Authorization, Permission, and Scope in full. See ADR-004 and ADR-005 for the decision records this document supports.

---

## 1. Why No Source Authentication Is Reused As-Is

| Source | Finding | Verdict |
|---|---|---|
| `baseline/` | Hand-rolled JWT, hardcoded per-engine role arrays (`SO_VIEW_ROLES`, `PR_MANAGE_ROLES`, ...), explicitly documented as "duplication, not sharing — matches the established convention." `permissions.json` exists but is unused ("designed-but-unbuilt RBAC"). | Not a permission engine despite file names suggesting otherwise. |
| `30/` | `kernel/authentication` trusts unsigned `x-user-id`/`x-user-roles` headers with **no JWT/session verification at all**. `kernel/authorization` is a single `roles.includes(role)` check. Both self-labeled "MINIMUM-FOUNDATION STUB" in their own source comments. No auth/crypto library is even installed in `package.json`. | Confirmed non-functional as production auth. |
| `xnexus-website/` | HMAC-token auth reimplemented **four separate times** (CMS, Driver, Consumer, Business Customer), each with its own `process.env`-sourced secret defaulting to a hardcoded `'dev-only-...-do-not-use-in-production'` string when unset. | Real production-deployment risk class: a misconfigured deployment could silently run with a known dev secret. |

**Conclusion (ADR-004): build one centralized Identity/Authentication Foundation. No source contributes code here — only negative lessons (what not to do) and one positive pattern** (`baseline`'s `requireAuth` check against revoked/disabled/stale-password tokens, fail-open only on a *read failure*, never on a positive negative signal — worth reusing as a design reference).

## 2. Authentication Design

- **Login identifier:** email or mobile number (mobile normalized to E.164 via the reusable Egypt-normalization utility found in `xnexus-website/customer-repository.js`, Class B).
- **Password handling:** industry-standard adaptive hash (bcrypt/argon2), never custom HMAC-of-password-plus-salt as all three sources do.
- **Access token:** short-lived, signed JWT (or equivalent), carrying `userId` + minimal claims only — role/permission data resolved fresh server-side per request, never trusted from token claims (mirrors `xnexus-website/cms-auth-engine.js`'s one good practice: "role is re-read from the repo every request, never trusted from a stale token").
- **Refresh token:** longer-lived, rotatable, revocable, stored hashed.
- **Session strategy:** stateless access token + server-tracked refresh-token family for revocation.
- **Token rotation:** refresh rotates on use; reuse of a rotated-out refresh token invalidates the whole family (breach detection).
- **Revocation:** logout invalidates the refresh-token family immediately; password change invalidates all prior tokens (`passwordChangedAt >= iat` check, adopted from `baseline`).
- **Account states:** pending, active, disabled, suspended — checked on every request, fail-closed (reject) on a positive disabled/suspended signal, fail-open only on an infrastructure read failure (bounded, documented risk, same as `baseline`'s pattern).
- **Password reset:** time-limited signed token, single use, invalidates existing sessions on completion.
- **Secret management:** all signing/HMAC secrets sourced from a secrets manager or required environment variable with **no default fallback** — the service refuses to start if a required secret is missing or matches a known placeholder value. This directly reverses the pattern found in both `baseline` and `xnexus-website`.
- **Startup validation:** a boot-time check asserts every required secret is present and non-placeholder before the service accepts traffic.
- **Multi-role users:** one Identity record may hold multiple role assignments across orgs/teams (e.g., a user who is both a Sales Supervisor and, in a different territory, a plain Sales Rep) — a real gap in all three sources' single-role-per-token assumption.
- **Mobile authentication:** same token mechanism as web; field roles (Sales Rep, Driver, Warehouse Worker) may additionally support mobile-number + OTP login for low-friction field use, still issuing the same token type — not a parallel auth engine (directly reversing `xnexus-website`'s four-times-duplicated-engine anti-pattern).
- **Web authentication:** standard login form + token.
- **Service-to-service authentication:** signed service credentials (client-credentials-style), distinct credential type from user tokens, used only for the Integration Gateway.

## 3. Authorization / Permission / Scope

The CTO directive's core distinction, adopted as binding:

> **Permission = WHAT a user may do.**
> **Scope = WHICH data/resources the user may do it against.**

Both are evaluated on every request; neither alone is sufficient.

```
User
  ↓
Role            (Authorization — role membership)
  ↓
Permission      (WHAT — module/feature/action, deny-by-default, hierarchical)
  ↓
Scope           (WHICH — specific records this user may act against)
```

### Worked examples (from the CTO directive, validated against domain design in `DAII_DOMAIN_BOUNDARIES.md`)

| Role | Permission (what) | Scope (which) |
|---|---|---|
| Sales Rep | Create orders, view customer detail | Only customers in their own `customer_assignments` |
| Sales Supervisor | Review team orders | Only their team's reps' customers/orders — never another supervisor's team |
| Warehouse Worker | Execute pick/pack tasks | Only their assigned warehouse(s) |
| Manager | Approve orders, broader reporting | Territory/org-wide per policy — still not unlimited by default |

### Enforcement Rule (blueprint §33, binding)

**A hidden UI button is not a security boundary.** Every list/detail/mutation endpoint re-derives Permission and Scope server-side from the authenticated actor — never from a client-supplied role/scope claim, filter parameter, or the mere absence of a visible UI control. A user must be **technically unable** to retrieve unauthorized customers, orders, products, inventory, warehouses, shipments, tracking data, or APIs — verified the way `xnexus-website`'s Phase D Authorization Matrix reports did: confirming the forbidden code path structurally doesn't exist for a given actor, not just that it currently returns a rejection.

### Anti-Enumeration

Unauthorized access to a specific resource ID returns **404, never 403** — adopted directly from `xnexus-website`'s consistently-applied discipline (verified across every cross-actor-access test in that codebase's Phase C/D/E reports). A non-owner never learns the resource exists.

### Permission Engine (see Foundation Contract §4)

Adopts `xnexus-website/permission-engine.js`'s hierarchical deny-by-default node tree and ancestor-walk inheritance. **Gap closed for Daii:** the source resolves per-tenant only; Daii adds the per-user-role dimension as a first-class second axis, not a bolt-on.

### Scope Engine (see Foundation Contract §5)

No direct source exists. Built fresh, informed by:
- `baseline`'s `computePermissions(record, user)` pattern (per-record, manager-scope-aware permission computation found in `sales-order-engine.js`/`purchase-engine.js`) — the *reasoning shape* (resolve once per request, return per-action booleans) is worth reusing.
- `xnexus-website`'s permission-node ancestry mechanics, generalized from "which UI node is visible" to "which specific record is accessible."

### Client-Side Permission Cache

`xnexus-website/cms/permission-gate.js`'s pattern — a `GET /permissions/mine` fetched once client-side, explicitly documented as **not the security boundary**, with server re-checking every write route independently — is adopted directly (Class B) as Daii's own UX-layer convention.

## 4. Client-Side Reliability (Security-Adjacent)

Not an authorization gap but a related risk class surfaced by `xnexus-website`'s one documented incident (`HOTFIX-ENGINEERING-INCIDENT-REPORT.md`): a "Send Order" button silently failed with no `.catch()`, no duplicate-submission guard, and a `fetch()` call that doesn't reject on 4xx/5xx. Every Daii state-changing client action (order submission, approval action, pick/pack confirmation, delivery outcome recording) must implement, from the start:

1. Duplicate-submission guard
2. Explicit pending/loading state
3. Explicit success state
4. Explicit error state with visible user feedback
5. Retry behavior where safe
6. Idempotency at the API layer (so a retried request is safe even if the client-side guard somehow fails)

This is an architecture requirement carried into `DAII_MOBILE_ARCHITECTURE.md` §4, not a later UI polish item.

## 5. Secrets Handling — Explicit Rejection

Both `baseline` (`kernel/website-integration-client.js`) and `xnexus-website` (all four auth engines) fall back to a literal hardcoded default secret when an environment variable is unset. **Daii's Foundation must fail closed**: refuse to start rather than run with a known/default/placeholder secret. This is a startup-time hard requirement, not a runtime warning.
