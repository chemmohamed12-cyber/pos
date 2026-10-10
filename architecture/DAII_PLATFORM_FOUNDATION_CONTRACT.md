# Daii Platform Foundation Contract

Status: **DRAFT — Stage 1 Planning.**
Defines the 20 Platform Core capabilities from `DAII_PLATFORM_ARCHITECTURE_V1.md`. For each: Responsibility, Inputs, Outputs, Data ownership, Dependencies, Security boundary, Persistence requirement, API exposure, Events emitted/consumed, source reuse verdict.

---

## 1. Identity

- **Responsibility:** Represent a real-world actor (staff user, sales rep, warehouse worker, driver, customer contact) as a single canonical record, independent of how they authenticate.
- **Inputs:** Registration/provisioning data (name, org membership, contact info, role assignment).
- **Outputs:** Stable `userId`, profile data, active role/org memberships.
- **Data ownership:** `users`, `user_org_memberships`.
- **Dependencies:** Organization (for membership), Authorization (for role assignment).
- **Security boundary:** Only Foundation writes identity records; all other domains reference `userId` by foreign key, never duplicate identity fields.
- **Persistence requirement:** Relational, strong consistency, unique constraints on login identifiers.
- **API exposure:** Internal service + a narrow `/identity/me` self-service read endpoint.
- **Events emitted:** `identity.user.created`, `identity.user.deactivated`, `identity.role.assigned`.
- **Events consumed:** none.
- **Source reuse:** None directly reusable — `baseline/users-engine.js` (Class B) is a reasonable reference for CRUD/audit shape only; rebuild the record model to support Daii's multi-role, multi-org requirement it doesn't have.

## 2. Authentication

- **Responsibility:** Verify "who is making this request" and issue/validate credentials. Full detail in `DAII_SECURITY_ARCHITECTURE.md` §2 and ADR-004.
- **Inputs:** Login identifier + credential (password, or mobile OTP for field roles), refresh token.
- **Outputs:** Access token (short-lived, signed), refresh token (rotatable), session/device metadata.
- **Data ownership:** `credentials` (hashed only), `sessions`/`refresh_tokens`, `login_attempts` (for lockout).
- **Dependencies:** Identity (subject), Configuration (secret material, token TTLs), Audit (every auth event logged).
- **Security boundary:** The **only** component permitted to verify credentials or mint tokens. No domain module re-implements this. Fails closed (refuses to start) if signing secrets are missing/default.
- **Persistence requirement:** Relational; credential hashes never in plaintext logs or API responses.
- **API exposure:** `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/password-reset/*`.
- **Events emitted:** `auth.login.succeeded`, `auth.login.failed`, `auth.token.revoked`, `auth.password.changed`.
- **Events consumed:** `identity.user.deactivated` (force-revoke sessions).
- **Source reuse:** **None as-is.** All three sources fail this bar: `baseline`/`xnexus-website` hand-roll HMAC/JWT per actor type (up to 4x duplicated) with hardcoded dev-secret fallbacks; `30/kernel/authentication` trusts unsigned headers outright. Rebuild on a vetted library (Class D). The one reusable pattern: `baseline/requireAuth`'s check against revoked/disabled/stale-password tokens (fail-open only on read failure, never on a positive negative signal) is worth keeping as a design reference.

## 3. Authorization

- **Responsibility:** Answer "may this authenticated actor perform this action" — role-membership resolution only (the *what*). Paired with Permission (below) for the full decision.
- **Inputs:** Actor's role set, requested action.
- **Outputs:** Allow/deny + reason code.
- **Data ownership:** `roles`, `user_roles`.
- **Dependencies:** Identity, Permission Engine.
- **Security boundary:** Enforced server-side on every mutating and every sensitive-read route; never inferred from client state.
- **Persistence requirement:** Relational.
- **API exposure:** Internal only (middleware/guard), not a public API.
- **Events emitted:** `authz.role.granted`, `authz.role.revoked`.
- **Events consumed:** none.
- **Source reuse:** Concept only (Class C/D) — no source has a real role model; `baseline` duplicates per-engine role arrays, `30/` is a single `roles.includes()` stub.

## 4. Permission Engine

- **Responsibility:** Answer "what may this role/user do" at a fine-grained, hierarchical (module→feature→action) level. The *what*, distinct from Scope's *which data*.
- **Inputs:** Role, requested module/feature/action node.
- **Outputs:** `hidden` (404) / `read-only` / `editable`.
- **Data ownership:** `permission_nodes`, `role_permission_profiles`.
- **Dependencies:** Authorization (role), Organization (for org-level permission profiles).
- **Security boundary:** Deny-by-default; missing profile = no access, not open access. Anti-enumeration: unauthorized resource access returns 404, never 403.
- **Persistence requirement:** Relational; profile resolution must be a cheap, cacheable read (hot path on every request).
- **API exposure:** `/permissions/mine` (read-only, client-side cache/UX only — never the enforcement point itself).
- **Events emitted:** `permission.profile.changed`.
- **Events consumed:** `authz.role.granted/revoked`.
- **Source reuse:** **Strongest pattern found** (Class C) — `xnexus-website/server/engines/permission-engine.js`. Ancestor-walk inheritance and 404-not-403 anti-enumeration are directly adopted design decisions. Gap that must be closed: source resolves per-*tenant* only; Daii adds the per-*user-role* dimension.

## 5. Scope Engine

- **Responsibility:** Answer "which specific records (customers, warehouses, orders) this actor may act on," independent of what action is permitted.
- **Inputs:** Actor, resource type, resource ID or query filter.
- **Outputs:** Allow/deny per record, or a pre-applied filter for list queries.
- **Data ownership:** `scope_assignments` (e.g., sales-rep→customer, warehouse-worker→warehouse, supervisor→team).
- **Dependencies:** Organization (team/territory hierarchy), Permission Engine (paired check).
- **Security boundary:** Every list/detail query for scoped resources passes through Scope Engine server-side — never trust a client-supplied "my customers" filter without a server-side re-derivation.
- **Persistence requirement:** Relational; must support efficient row-level filtering (indexed join, not per-row application logic in hot paths).
- **API exposure:** Internal only.
- **Events emitted:** `scope.assignment.changed`.
- **Events consumed:** `sales.customer.assigned`, `warehouse.worker.assigned`.
- **Source reuse:** **No direct source — confirmed gap across all three audits.** Build fresh, informed by `baseline`'s scattered manager-scope-resolution logic (`computePermissions(record, user)` pattern in sales-order-engine/purchase-engine) and the QR Platform's permission-node ancestry mechanics.

### 5.1 Finalized Scope-vs-Role policy (Stage 2 implementation note, closes the gap above)

Confirmed by live end-to-end verification (real UI, real Postgres) during the Sales Order approval chain: Scope Engine, as built, only supports direct resource assignment (§5's `scope_assignments` table) — it has no team-hierarchy/ancestor-walk resolution. Requiring per-resource Scope for every actor in a multi-step approval chain would mean only the one supervisor or manager explicitly assigned to a resource could ever review it, which is not what any V1 workflow needs. The policy actually implemented, and now the standing rule for every domain:

- **Sales Rep (resource owner):** Scope applies — a rep may only act on customers/orders they are explicitly assigned to (`scope.assertAccess`), enforced server-side on every read and on the rep's own actions (create, submit, resubmit).
- **Supervisor / Manager (approval roles):** Scope is deliberately NOT required for their review actions. Instead, Role membership (Authorization/Permission Engine) is the enforced boundary: any actor holding the qualifying role (`sales_supervisor`, `sales_manager`) may act on a resource that has reached their stage in the workflow. This is a role-scoped boundary ("qualified for this workflow stage"), not unrestricted access to all orders — a supervisor/manager still cannot bypass the Process Engine's state machine, still cannot act outside their role's defined transitions, and every action is still audit-logged.
- **Applies uniformly:** the same split governs every other multi-actor approval/review flow in the platform (Deposit Control approval, Returns approval, etc.) — Scope for the originating actor's own operational actions, Role for reviewer/approver actions at a workflow stage.
- **Reference implementation:** [`sales-orders.service.ts`](../backend/src/domains/sales-orders/application/sales-orders.service.ts) `transitionOrder()`.
- **Future work (not required for V1):** a true team-hierarchy Scope resolver (manager sees direct reports' assignments) remains valid backlog if a future release needs finer-grained reviewer restriction than "any holder of the role."

## 6. Limit Engine

- **Responsibility:** Enforce numeric quotas (max warehouses, max sales reps, max orders/month) — fails open (unlimited) on a missing profile, deliberately the opposite fail-safe direction from Permission.
- **Inputs:** Actor/org, limit key, requested quantity.
- **Outputs:** Allow/deny + current usage.
- **Data ownership:** `limit_profiles`, `limit_usage_counters`.
- **Dependencies:** Organization.
- **Security boundary:** Advisory/business-rule enforcement, not a security boundary in itself.
- **Persistence requirement:** Relational; counters need atomic increment (DB-level, not read-modify-write in application code).
- **API exposure:** Internal only.
- **Events emitted:** `limit.exceeded`, `limit.threshold.warning`.
- **Events consumed:** domain events that consume quota (e.g., `sales.order.created`).
- **Source reuse:** **Reuse+harden (Class B)** — `xnexus-website/server/engines/limit-engine.js` + `limit-schema.js`. Re-point at Daii's own limit keys; the resolution algorithm and fail-open reasoning transfer near-verbatim.

## 7. Organization / Tenant Context

- **Responsibility:** Model Company→Branch→Department→Team→Warehouse and (if Daii is ever multi-tenant beyond a single business) tenant scoping.
- **Inputs:** Org structure CRUD.
- **Outputs:** Hierarchy tree, membership resolution.
- **Data ownership:** `organizations`, `branches`, `teams`, `org_memberships`.
- **Dependencies:** Identity.
- **Security boundary:** Org membership is an input to Scope Engine, not itself a security boundary.
- **Persistence requirement:** Relational, tree/closure-table or adjacency-list with recursive query support.
- **API exposure:** `/org/*` admin CRUD.
- **Events emitted:** `org.branch.created`, `org.membership.changed`.
- **Events consumed:** none.
- **Source reuse:** **Reuse+harden (Class B)** — `baseline/server/engines/organization-engine.js`. Directly matches; relax its hardcoded single-company assumption (ENG-026) as a conscious decision, not silently.

## 8. Configuration Engine

- **Responsibility:** Generic named value-list / setting store for enums and admin-editable config.
- **Inputs:** Key, value(s), scope (global/org).
- **Outputs:** Resolved config value with precedence.
- **Data ownership:** `configuration_entries`.
- **Dependencies:** none.
- **Security boundary:** Write access admin-gated; read access broad.
- **Persistence requirement:** Relational, cacheable.
- **API exposure:** `/config/*` admin CRUD, internal resolver for services.
- **Events emitted:** `config.changed`.
- **Events consumed:** none.
- **Source reuse:** **Direct reuse of pattern (Class A)** — `baseline/server/engines/configuration-engine.js`. Fully generic, zero domain coupling. Note: RMS's `kernel/configuration` is NOT a candidate — it's a bare `process.env` wrapper, not an engine.

## 9. Audit Engine

- **Responsibility:** Durable, tamper-evident record of every significant action.
- **Inputs:** Actor, org, action, resource, resource ID, result, correlation ID.
- **Outputs:** Append-only audit trail, verifiable hash chain.
- **Data ownership:** `audit_records` (append-only; no UPDATE/DELETE grants at the DB role level).
- **Dependencies:** Identity, Events (many audit records originate from domain events).
- **Security boundary:** Write-once; verification (hash-chain walk) must be independently runnable without trusting the application layer.
- **Persistence requirement:** Relational, durable, indexed by actor/resource/time; hash-chain integrity must survive the persistence swap RMS's implementation never had (RMS's version is in-memory only).
- **API exposure:** `/audit/*` read-only, scoped by permission.
- **Events emitted:** none (audit is a consumer/sink, not a source, to avoid infinite loops).
- **Events consumed:** all domain events tagged `auditable: true`.
- **Source reuse:** **Reuse+harden (Class B)** — `30/kernel/audit`'s SHA-256 hash-chain algorithm (each record commits to its own content + prior record's hash) is the strongest single primitive found in any source; framework-agnostic, small, dependency-free. Combine with `baseline/kernel/audit-diff.js`'s pure before/after diff builder. Contingent on the stack decision (ADR-002) for how directly the RMS code ports — the *algorithm* ports regardless of stack.

## 10. Event Engine

- **Responsibility:** Durable pub/sub for domain and integration events, decoupling producers from consumers.
- **Inputs:** `publish(topic, payload)`.
- **Outputs:** Delivered events to subscribers; durable log for replay.
- **Data ownership:** `event_log` (outbox), `event_subscriptions`.
- **Dependencies:** none upstream; nearly everything downstream.
- **Security boundary:** Domain code never imports a broker SDK directly — only the Event Engine's facade (mirrors RMS's ADR-006 boundary-enforcement discipline).
- **Persistence requirement:** Outbox pattern — event write and triggering domain write happen in the same DB transaction; dispatch happens after commit. See `DAII_EVENT_ARCHITECTURE.md`.
- **API exposure:** Internal only.
- **Events emitted:** n/a (this *is* the event infrastructure).
- **Events consumed:** n/a.
- **Source reuse:** **Extract interface only (Class C)** — `30/kernel/event-bus`'s `publish/subscribe` contract and "never import the broker directly" discipline are sound; its in-memory implementation is an explicit placeholder and is not reused.

## 11. Notification Engine

- **Responsibility:** Multi-channel (email/SMS/WhatsApp/push) dispatch of user-facing messages, templated, deduplicated, delivery-logged.
- **Inputs:** Template key, recipient, variables, channel preference.
- **Outputs:** Delivery attempt record, success/failure.
- **Data ownership:** `notification_templates`, `notification_log`.
- **Dependencies:** Identity (recipient contact info), Configuration (channel credentials), Events (triggered by domain events per blueprint §32).
- **Security boundary:** Credential fields (API keys, tokens) masked centrally via a schema-level "sensitive field" marker — not per-endpoint manual masking.
- **Persistence requirement:** Relational for templates/log; channel credentials in a secrets manager, not the app DB.
- **API exposure:** Internal only; admin CRUD for templates.
- **Events emitted:** `notification.sent`, `notification.failed`.
- **Events consumed:** `sales.order.approved`, `deposit.verified`, `shipment.dispatched`, etc. (blueprint §32 business events).
- **Source reuse:** **Reuse+harden (Class B)** — `baseline/server/kernel/notification.js`. Working, production-proven multi-channel dispatch. Must centralize secret-masking (source does it ad hoc per endpoint) and add retry/backoff (source has none).

## 12. Numbering Engine

- **Responsibility:** Generate human-readable sequential document numbers (SO-2026-000123 etc.) with year rollover.
- **Inputs:** Document type/prefix.
- **Outputs:** Next number, guaranteed unique and gapless-or-documented-gap-policy.
- **Data ownership:** `numbering_sequences`.
- **Dependencies:** none.
- **Security boundary:** n/a.
- **Persistence requirement:** **Must be issued inside the same DB transaction as the entity it numbers** (DB sequence or unique-constraint-enforced insert) — this is the mandatory fix for the confirmed defect below.
- **API exposure:** Internal only.
- **Events emitted:** none.
- **Events consumed:** none.
- **Source reuse:** **Reuse+harden, hardening mandatory (Class B)** — `baseline/server/engines/numbering-engine.js` is small and clean but has a **confirmed production defect (TD-29)**: the free-standing counter has no cross-check against real entity data and silently desynced after a backup restore. Daii must not port the counter mechanism verbatim; tie numbering to entity creation transactionally.

## 13. Terminology Registry

- **Responsibility:** Server-owned mapping of canonical machine codes to professionally-authored Arabic and English labels. Full detail in `DAII_I18N_TERMINOLOGY_ARCHITECTURE.md`.
- **Inputs:** Canonical code (e.g., `PENDING_REVIEW`), language.
- **Outputs:** Localized label, with English fallback if a translation is missing (never blank, never raw code shown to a user).
- **Data ownership:** `terminology_entries` (code, ar, en, category, version).
- **Dependencies:** none.
- **Security boundary:** n/a.
- **Persistence requirement:** Relational, versioned (label wording may evolve without changing the canonical code).
- **API exposure:** `/terminology/*` read endpoint, consumed by all clients.
- **Events emitted:** `terminology.entry.changed`.
- **Events consumed:** none.
- **Source reuse:** **No direct source — confirmed gap even in the most mature source.** QR Platform's i18n is a UI-chrome dictionary only; its own documentation admits raw status enums are deliberately left untranslated. Build fresh per blueprint §36.

## 14. Localization / i18n Foundation

- **Responsibility:** RTL/LTR layout mechanics, default-language selection, persisted language preference. Full detail in `DAII_I18N_TERMINOLOGY_ARCHITECTURE.md`.
- **Inputs:** User's language choice (never derived from device locale by default).
- **Outputs:** `dir` attribute, active language for Terminology Registry lookups.
- **Data ownership:** `user_language_preference` (or client-persisted, server-respected).
- **Dependencies:** Terminology Registry.
- **Security boundary:** n/a.
- **Persistence requirement:** Minimal — a preference flag.
- **API exposure:** Part of Identity/session payload.
- **Events emitted:** none.
- **Events consumed:** none.
- **Source reuse:** **Reuse mechanics (Class B)** — QR Platform's default-to-Arabic-never-locale-derived rule, single persisted-choice key, and flexbox-based RTL mirroring (not hardcoded left/right) are proven, working patterns worth adopting directly.

## 15. File / Media Abstraction

- **Responsibility:** Upload, validate, store, and serve attachments (deposit evidence, product images, documents).
- **Inputs:** File stream, type/size constraints, owner entity.
- **Outputs:** Stored reference (URL/key), metadata.
- **Data ownership:** `media_assets`.
- **Dependencies:** Authorization (who may upload/view).
- **Security boundary:** Type/size validation server-side, never trust client-declared MIME type alone.
- **Persistence requirement:** Object storage (not DB blobs) + a relational metadata table.
- **API exposure:** `/media/upload`, `/media/:id`.
- **Events emitted:** `media.uploaded`.
- **Events consumed:** none.
- **Source reuse:** **Reuse+harden, not yet deeply audited (Class B, provisional)** — `baseline/kernel/media-engine.js` and `xnexus-website/image-processing-engine.js` both have relevant upload plumbing; flagged for a Stage 1 follow-up deep-read before final classification.

## 16. Background Processing

- **Responsibility:** Retry/backoff/dead-letter queue for async work (escalations, scheduled reports, batch notifications).
- **Inputs:** Job definition, priority, schedule.
- **Outputs:** Execution result, retry state.
- **Data ownership:** `background_jobs` (if not delegated entirely to infrastructure, e.g. a managed queue).
- **Dependencies:** Events (jobs often triggered by or trigger events).
- **Security boundary:** n/a.
- **Persistence requirement:** Durable queue — **not** in-memory (RMS's implementation is explicitly in-memory only).
- **API exposure:** Internal only.
- **Events emitted:** `job.completed`, `job.failed`, `job.dead-lettered`.
- **Events consumed:** varies by job type.
- **Source reuse:** **Extract logic, rebuild storage (Class B/C)** — `30/kernel/background-processing`'s retry/backoff/DLQ/priority queue algorithm is sound and portable; it self-describes as an "honest substitute" for a real broker (BullMQ/Redis named as the intended target, never implemented). See `DAII_EVENT_ARCHITECTURE.md` §4 for the production recommendation.

## 17. Health / Diagnostics

- **Responsibility:** Report real functional health (not hardcoded "ok") of dependent systems.
- **Inputs:** none (polled).
- **Outputs:** Per-component health + overall status.
- **Data ownership:** none (stateless probe).
- **Dependencies:** Every other Foundation capability it probes.
- **Security boundary:** n/a (may be unauthenticated for load-balancer probes, with a separate authenticated deep-health endpoint).
- **Persistence requirement:** none.
- **API exposure:** `/health` (shallow, unauthenticated), `/health/deep` (authenticated, full component check).
- **Events emitted:** none.
- **Events consumed:** none.
- **Source reuse:** **Reuse pattern (Class C)** — `30/kernel/health`'s discipline of *real round-trip checks* (sign+verify, publish+subscribe, DB append+read) rather than a hardcoded 200 is worth adopting; the specific indicators are tied to RMS's own modules and not portable as code.

## 18. Integration Gateway

- **Responsibility:** Inbound/outbound integration with external systems (future Finance Phase 2, carriers, payment providers).
- **Inputs:** Inbound signed requests; outbound API calls.
- **Outputs:** Validated inbound payloads; outbound call results.
- **Data ownership:** `integration_credentials` (secrets-managed), `integration_log`.
- **Dependencies:** Configuration, Audit.
- **Security boundary:** Inbound requests HMAC-verified; outbound calls never leak internal state beyond the documented contract.
- **Persistence requirement:** Relational for logs; no local caching of a foreign system's state (read-through only).
- **API exposure:** `/integrations/*`, contract-specific.
- **Events emitted:** `integration.call.failed`.
- **Events consumed:** varies.
- **Source reuse:** **Extract architecture lesson (Class C)** — `xnexus-website/integration-gateway-engine.js`'s "read-through, never cache/duplicate a foreign system's state" rule (ADR-039 in that codebase, an explicit correction of an earlier over-engineered design) is directly valuable guidance, not the code itself.

## 19. Observability

- **Responsibility:** Structured logging, tracing, metrics across all Foundation and Domain services.
- **Inputs:** Application-level log/trace/metric emissions.
- **Outputs:** Correlated logs (via correlation ID from Audit), traces, dashboards.
- **Data ownership:** none (delegated to infrastructure — e.g., a log aggregator, APM).
- **Dependencies:** Every service (cross-cutting).
- **Security boundary:** Logs must never contain credentials/secrets/full card numbers — same "sensitive field" marker discipline as Notification.
- **Persistence requirement:** Delegated to infrastructure, not the application DB.
- **API exposure:** none (internal tooling).
- **Events emitted:** none.
- **Events consumed:** none (mostly log/metric emission, not event consumption).
- **Source reuse:** **None found** — no source has meaningful observability infrastructure; build fresh using standard infrastructure (correlation-ID propagation is the one architectural requirement to bake in from day one, informed by Audit Engine's `correlationId` field).

## 20. Error / Response Contract

- **Responsibility:** A single, consistent API envelope and error taxonomy across every Daii endpoint.
- **Inputs:** n/a (a convention, not a service).
- **Outputs:** `{ success, data, meta }` on success; `{ success: false, error: { code, message, details } }` on failure — canonical error codes, not ad hoc strings.
- **Data ownership:** none.
- **Dependencies:** Terminology Registry (error messages are canonical codes + localized labels, same discipline as domain status values).
- **Security boundary:** Error responses never leak stack traces, internal IDs, or SQL errors to the client.
- **Persistence requirement:** none.
- **API exposure:** This *is* the API contract convention, applied everywhere. See `DAII_API_ARCHITECTURE.md`.
- **Events emitted:** none.
- **Events consumed:** none.
- **Source reuse:** **Reuse pattern (Class B)** — `baseline`'s mobile API layer (`server-mobile-api.js` etc.) already wraps engines in a uniform `{success, data, meta}` envelope; adopt the shape, rebuild the error-code taxonomy to be canonical/localizable per Terminology Registry.
