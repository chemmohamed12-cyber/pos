# Authorization Foundation — CTO Decisions of 2026-10-07 (Final Closure Sequence)

Source: CTO EXECUTION DIRECTIVE — *Authorization Foundation — Final Closure Sequence* (2026-10-07). Environment: Development / Verification only · Production HOLD · Push NOT AUTHORIZED · `daii_dev` untouched.
These records **do not change the approved architecture**; they close the six open items carried since F4/F5/F6 and bind the implementation described under each decision.

| # | Decision | Status |
|---|---|---|
| 1 | F4-B — Hybrid Integration ownership | APPROVED / CLOSED |
| 2 | Legacy `admin` — transitional alias → retirement | APPROVED — transitional, retirement required |
| 3 | New Company default authorization = `company_admin` only | APPROVED / CLOSED — **implemented in this closure** |
| 4-A | Mail provider = XNEXUSTECH-managed | APPROVED / CLOSED |
| 4-B | D16 second approver — no global policy now | APPROVED / CLOSED (threshold policy DEFERRED / POLICY REQUIRED) |
| 4-C | Support self-grant PROHIBITED | APPROVED / CLOSED — **implemented in this closure** |

## Decision 1 — F4-B Integrations: Hybrid Integration Ownership
**XNEXUSTECH / Control Plane owns:** provider catalog · provider definitions · connector versions · global availability · entitlement / package gating.
**The Company owns:** integration connections · credential references · mappings · activation state · webhooks · sync state · operational logs/data.
Company integration resources are resolved **only** through the validated Company context (JWT → Company Context → Permission → Resource ownership). Support access to them is explicit, time-boxed, reason-required, audited and Company-visible. Company credentials never become platform-owned.
*Implementation state (honest):* the control-plane half exists since F4 (`integration_provider_catalog`, `platform.integration.*`, `IntegrationCatalogService`). The Company-owned retrofit of the existing `IntegrationsController` (15 routes still behind the legacy `admin` alias, ambient data) is **the F4-B work package; it is not part of this closure and is recorded as DEFERRED — NOT YET IMPLEMENTED** (no scope expansion during the closure sequence).

## Decision 2 — Legacy `admin`: Transitional Alias → Retirement
`legacy admin → temporary compatibility mapping → Platform Super Admin where applicable`. **Never** `admin → company_admin`. Mandatory path: **Map → Dual-check → Migrate → Retire**. **No new authorization dependency on `admin` may be added.** Final retirement happens only after zero remaining authorization dependencies, migrated call-sites and a green regression are proven.
*Enforcement now in the test suite:* `legacy-admin-dependency.register.spec.ts` freezes every production reference to the alias as a ceiling (a file may keep fewer, never more; an unlisted file may have none; the register only shrinks) and asserts that no source line maps the alias onto `company_admin`.

## Decision 3 — New Company default authorization
A new Company is born with `company_admin`; the initial administrator holds **`company_admin` only** — no `wf.*` workflow capability, no ERP operational superuser capability. `company_admin` carries only what is needed to administer **users, roles, scopes, organization and the Company's authorization settings**, under **No Self-Elevation**.
*Implementation:* `DatabaseProvisioningService` default `administratorRole` is now `company_admin` (`'admin'` remains an explicit, documented opt-in for compatibility — it is a legacy value, not a default). `company_admin` holds `core.company.members.manage`, `core.company.roles.manage`, `core.company.backup.manage`, `core.company.audit.view` and **one** workflow-namespace node, `wf.core.organization.manage`. That node is an *administration* capability (it edits the organization tree, which is how scopes are placed); it is the only `wf.*` node the role holds and it is recorded here as the single deliberate exception. Migration `1790012000000` grants it to an existing `company_admin` role (additive, idempotent).
*Consequences recorded:* a Company's first administrator cannot perform ERP operations; operational roles are granted to **other** people (an administrator can never change their own roles — `SELF_ROLE_CHANGE`). A one-person Company therefore needs at least a second user to operate. The administrator administers scopes **without being data-unrestricted** (`core.scope.unrestricted` stays a data privilege): holding the Organization administration rule lets them place people on any unit, and they can never add to or widen **their own** scope (`SELF_SCOPE_CHANGE`) — the same non-self-elevation principle applies to Company Administrators as to Support.

## Decision 4-A — Mail provider
Default mail infrastructure: **XNEXUSTECH-managed mail provider**. Company custom SMTP / provider configuration: **deferred**; if introduced it is a **Company-owned integration** under the F4-B Hybrid model. Platform mail credentials are never Company-visible nor Company-admin accessible.
*State:* the invitation flow today returns the accept link to the inviting administrator (no mail is sent); wiring the managed provider is part of the mail/notification work package — **NOT YET IMPLEMENTED**, no Company-visible credential exists anywhere.

## Decision 4-B — D16 Second Approver
No global second-approver policy now. The Approval Engine stays architecturally able to support *Single Approver + optional Second Approver / Multi-step policy*; PR/PO maker-checker is unchanged (Maker ≠ Checker); Payments/Treasury receive no additional approval; **Second-Approver threshold policy: DEFERRED / POLICY REQUIRED** (a separate Business Policy).

## Decision 4-C — Support self-grant: PROHIBITED
Support may *request* temporary access; it may **not** grant itself access, approve its own request, extend its own access, broaden its own capabilities, add roles or scopes to itself, or convert itself into Company Admin. Support access is explicit, Company-specific, capability-specific (`support_readonly`), time-limited, reason-required, audited and Company-visible. The same non-self-elevation principle applies to Company Administrators.
*Implementation:* `SupportAccessService.grant` requires a **named** grantee that **differs** from the grantor (the former default "for myself" is removed); a self-grant — by a support operator, a Company Manager or even the Platform Super Admin, and an extension of one's own live access — is refused `SELF_GRANT_PROHIBITED` (403) and the refusal is audited (`platform.support_access.self_grant_denied`, result `denied`). A support membership can never receive an access scope (`SUPPORT_ACCESS_FIXED`) and its role/status are already fixed by F4. Ending one's own access is narrowing and stays allowed. *Request workflow:* a *request* is today an out-of-band ask to an authorized platform user; a recorded request/approval entity is **DEFERRED** (it adds nothing to the prohibition, which is enforced regardless).

## Scope Coverage Register (F6 pilot — recorded officially)
**Scope Enforced / Verified:** Inventory / Warehouse transactions (+ stock, movements, reservations, stock/movement reports) · Purchase Requests · Purchase Orders · Goods Receipts · Sales Orders · Treasury Accounts.
**Scope Expansion — NOT YET IMPLEMENTED (not scope-enforced; must not be described as such):** Customer Accounts / AR · Reports (all, including sales/stock overviews outside the four inventory endpoints) · Fulfilment · Shipments · Returns · every other domain not listed above.
No Scope Expansion is started by this closure.
