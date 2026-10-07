# AZ-13 (Integrations — Hybrid ownership) and AZ-14 (Media — Company-owned): ownership record and execution plan

Status: CTO decisions CLOSED (2026-10-07) — recorded here with what F4 implemented and what is deliberately scheduled as its own gated step.
Rule applied to both: nothing that belongs to a Company may become platform-owned data because XNEXUSTECH operates the infrastructure; platform access to Company content exists only through the restricted, approved support model (explicit, time-boxed, reason-required, audited, Company-visible).

## AZ-13 — Integrations (Hybrid Ownership Model)

| Concern | Owner | Where it lives | F4 status |
|---|---|---|---|
| Integration Catalog, provider definitions, connector versions | XNEXUSTECH / control plane | `integration_providers` (control plane), seeded with the one shipped provider `qr_store` | **IMPLEMENTED** (table, service, `GET/PUT /platform/integrations/providers`, `platform.integration.view/manage`, audited) |
| Global availability, package/module gating | XNEXUSTECH / control plane | `integration_providers.status` + `requiresModule` | **IMPLEMENTED** (open/close availability); the per-Company join is made where the Company plane consumes the catalog (below) |
| Support access to a Company's integrations | restricted model | `support_readonly` support membership | **IMPLEMENTED** (F4 support access; read-only, Company-visible) |
| Integration Connections, credential references, mappings, activation, webhooks, sync state, operational logs | **Company** | today: AMBIENT tables `integration_connectors / _credentials / _product_mappings / _sync_logs` (pre-existing finding AZ-13) | **NOT moved in F4 — scheduled as F4-B (own gate, see below)** |

Why F4-B is separate and not a code tweak: `IntegrationsService` (626 lines) creates sales orders, customers and stock movements through domain services that are ALREADY Company-scoped; the intake endpoint (`integrations/qr/:connectorId/orders`) authenticates by connector credential with no JWT, so it has no Company context to route by; and the ambient tables may hold real DAII data and encrypted credentials whose key is platform-wide. Moving ownership therefore changes data residency and credential custody, which is a migration of real data — a CTO STOP condition ("migration touching unknown real estate") if done silently inside F4.

**F4-B plan (to be authorised separately):**
1. Entities `IntegrationConnector/Credential/ProductMapping/SyncLog` join the Company entity registry (new Company-DB migration; no data copied by it).
2. `IntegrationsService` + controller become Company-plane (`CompanyContextGuard` + `PermissionGuard`, new node `core.company.integrations.manage` granted to the legacy `admin` by migration, offered as a capability to `company_admin`), reading the catalog to check provider availability and the package module.
3. Control-plane routing table `integration_routes(connectorId → companyId)` written when a Company creates a connection; the QR intake resolves the Company from it, then runs on that Company's DataSource (no ambient write path remains).
4. Credential custody: re-encrypt Company credentials under a per-Company key (HKDF over the platform secret + `companyId`), so ambient/platform access to the control-plane database never yields Company secrets.
5. Data migration of existing ambient rows into the owning Company DB (DAII) under an explicit migration plan: inventory (read-only on a clone), copy + verify, dual-read window, flip, retire ambient reads. Needs the CTO's go and a verified backup; never run implicitly.
6. Verification: A/B isolation spec (Company A connector invisible to B; intake for A's connector never touches B), credential custody test, A/B on intake routing, Protected Baseline.

## AZ-14 — Media (Company-owned)

Decision: media/files belong to the Company; XNEXUSTECH manages storage infrastructure, availability and entitlement only; the platform has no ordinary operational access to Company content; support access only through the restricted model.

F4: **no migration** (CTO: "do not execute any migration now outside its dedicated phase"). Recorded constraints for that phase:
1. `MediaAsset` joins the Company entity registry; `MediaService` runs on the Company DataSource; routes get `CompanyContextGuard` + permission nodes (replacing today's "JWT only + admin check inside the controller").
2. Storage layout is Company-prefixed (`companies/<companyId>/…`); the storage adapter never lists or serves across prefixes.
3. Existing ambient media rows/files are handled by an independent migration plan (inventory on a clone → owner Company resolution via the uploader's membership → copy + checksum → dual-read → flip → retire), executed only on explicit CTO order.
4. No shortcut that makes media platform-owned to simplify execution.
Note (pre-existing, AZ-14): today `GET /media/:id` is JWT-only on the AMBIENT plane, so the F4 support role does not (and cannot) restrict it; closing that is exactly what the media phase's Company-plane routes and permission nodes are for.

## Not changed by F4 (so nothing regresses)
`/integrations/*` and `/media/*` keep their current ambient behaviour and guards until their gated steps; they remain on the list of platform-adjacent routes whose Company ownership is pending (Appendix C of the Phase-0 inventory).
