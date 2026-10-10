# Daii ERP — Master Architecture

**Last reconciled: 2026-08-24.** This is the entry point into Daii's architecture — a summary of
the binding decisions plus, for the first time, a reconciliation against what's actually
implemented in `backend/src/**`/`frontend/src/**` today, not just what was planned.

**A note on scope, read this first:** the `architecture/` folder holds 18 focused documents (~1,500
lines total), each covering one distinct architectural concern with almost no overlap between them.
Unlike the 35+ root-level `HANDOVER_*.md`/`*_REPORT.md` session files (genuinely repetitive status
snapshots — see `MASTER_PROJECT_STATUS.md` §5 for that consolidation), these architecture documents
are **not** a documentation-bloat problem and this file does not replace them — it indexes them and
adds the one thing they were missing: current-implementation reconciliation. Keep all 18; they
remain the detailed reference for anyone implementing against a specific capability.

---

## 1. How Daii's architecture came to be

Daii was designed by auditing three prior codebases (`_source-audits/`: `baseline` — an XNEXUS
hospitality system; `30` — an RMS "Step 30" governance/kernel prototype; `xnexus-website` — the QR
Platform) for reusable **concepts**, never reusing code wholesale. The verdict, still true today:
**no source's authentication, authorization, or JSON-file persistence approach was carried
forward** — all three had disqualifying gaps (hand-rolled/duplicated auth, hardcoded dev-secret
fallbacks, no real database, in-memory-only event bus and audit log). What *was* adopted: the
Process Engine concept (generic state machine + data-driven process definitions), the audit
hash-chain algorithm, the Permission Engine's deny-by-default/ancestor-walk/404-not-403 pattern, the
movement-based inventory ledger shape, and the "mobile is a thin client over the same domain APIs"
pattern. Full detail: [`architecture/DAII_PLATFORM_ARCHITECTURE_V1.md`](architecture/DAII_PLATFORM_ARCHITECTURE_V1.md).

## 2. Binding rules (apply to every future change, not just historical)

These are the rules a future session should treat as constraints, not suggestions:

1. **No domain leakage.** Every domain talks to every other domain only through published
   commands/queries/events — never by importing another domain's persistence layer directly.
   ([`DAII_DOMAIN_BOUNDARIES.md`](architecture/DAII_DOMAIN_BOUNDARIES.md))
2. **Permission = WHAT a user may do. Scope = WHICH data they may do it to.** Both checked on every
   request, server-side, never inferred from client state or a hidden UI button.
   ([`DAII_SECURITY_ARCHITECTURE.md`](architecture/DAII_SECURITY_ARCHITECTURE.md) §3)
3. **Scope-vs-Role split for multi-actor workflows** (confirmed live, not just planned — this
   session re-verified it): the originating actor (e.g. a Sales Rep) is Scope-restricted to their
   own assigned resources; a reviewer/approver role (supervisor, manager, finance) acts by **role
   membership** on any resource that has reached their workflow stage, not by per-resource Scope
   assignment. Reference implementation: `sales-orders.service.ts`'s `isReviewerOrAdmin` pattern,
   the same pattern this session confirmed live-fixed for `finance` (`task_cf32e266`, see
   `MASTER_PROJECT_STATUS.md`).
4. **Anti-enumeration:** unauthorized access to a specific resource ID returns 404, never 403 — a
   non-owner never learns the resource exists.
5. **Numbering is issued inside the same transaction as the entity it numbers.** (Closes a
   confirmed defect — TD-29 — found in one of the audited source systems: a free-standing counter
   desynced after a backup restore.)
6. **The event outbox write happens in the same DB transaction as the domain state change.**
   Dispatch to subscribers happens after commit — never let an event advertise a fact the database
   didn't durably commit first.
7. **Immutable ledgers, corrections not edits.** `stock_movements`, `audit_records`,
   `tracking_events`, `customer_ledger_entries` are append-only; a wrong entry is reversed by a new
   offsetting entry referencing the original, never edited in place.
8. **No hardcoded secrets, ever, with no default fallback.** The service must refuse to start
   rather than run with a missing or placeholder signing secret — this directly reverses a pattern
   found (and exploited-in-theory) in all three audited source systems.
9. **Deployment independence:** no domain or shared service branches on `if (cloud) / if (on-prem)`.
   Infrastructure (database, object storage, cache, queue, secrets) is accessed through a port; the
   concrete adapter is chosen once, at the composition root, via configuration. See §5.
10. **Finance boundary:** no V1 domain calls into a future Finance/GL system — only emits events a
    future Finance module could subscribe to. (Note: this refers to a *possible future* general
    ledger/chart-of-accounts system, explicitly deferred — **not** the Customer Financial
    Account/Invoice/AR/Treasury domain, which **is** built and live; see §4.)

## 3. Foundation capabilities — planned vs. actually implemented

The planning documents define 20 Foundation capabilities
([`DAII_PLATFORM_FOUNDATION_CONTRACT.md`](architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md)) at a
target maturity of L3 (domain-neutral, deployment-neutral, contract-driven — see
[`DAII_PLATFORM_GRADE_CAPABILITY_STANDARD.md`](architecture/DAII_PLATFORM_GRADE_CAPABILITY_STANDARD.md)),
with an explicit V1-acceptable bar of L2 (functionally solid, Daii-hardened, not yet proven outside
Daii's own deployment model) where fully justified
([`DAII_MATURITY_TARGET_POLICY.md`](architecture/DAII_MATURITY_TARGET_POLICY.md), ADR-016). Below is
this session's reconciliation of that plan against the code actually running today:

| Capability | Planned | Actually implemented (verified this session) |
|---|---|---|
| Identity / Authentication | Centralized, JWT, bcrypt/argon2, refresh rotation, fail-closed on missing secrets | **Built and live.** JWT login (`POST /auth/login`), bootstrap-first-admin-registration pattern confirmed working, role assignment via `/admin/roles/assign`. |
| Authorization (role) | Role-membership check | **Built and live.** `RolesGuard` + `@RequireRole(...)` decorators used on every state-changing route observed this session. |
| Permission Engine (hierarchical module→feature→action) | Deny-by-default node tree, ancestor-walk | **Simplified in practice.** No evidence of a full hierarchical permission-node tree; V1 uses route-level `@RequireRole` instead — a pragmatic L1/L2 implementation of the *intent*, not the originally planned tree structure. Not flagged as broken — just narrower than the original L3 contract envisioned. Worth an explicit note if a future session builds toward the fuller model. |
| Scope Engine | Per-resource assignment + reviewer role-based bypass | **Built and live, matches the documented policy exactly** (§2.3 above) — `ScopeService.assertAccess`/`getAssignedResourceIds`, `UNRESTRICTED_ROLES`, per-domain `isReviewerOrAdmin` bypass patterns. |
| Audit Engine | Hash-chained, append-only | **Built and live.** `AuditService.record()` called at the point of every state change observed this session (deposits, sales order edits, returns, shipments, vehicle mutations, etc.). |
| Event Engine (outbox pattern) | Outbox write in the same transaction as the domain write; dispatch after commit | **Built and live**, confirmed by direct code reading — e.g. `ShipmentService.createShipment`'s `dataSource.transaction` block calls `events.publish(manager, 'shipment.created', ...)` inside the same transaction as the entity save. |
| Numbering Engine | Transactional, tied to entity creation | **Built and live**, confirmed transactional (e.g. RSH number + Shipment row created together). |
| Terminology Registry | Canonical code → ar/en label, versioned, never a blank/raw code shown | **Built and live, extensively used.** Dozens of migrations seed `terminology_entries`; this session added several more following the exact same pattern. |
| Process Engine | Generic state machine, data-driven process definitions | **Built and live, exactly as designed** — confirmed used for Sales Order approval, Fulfillment pick/pack, Shipment lifecycle, Returns, and Warehouse Transactions, each as a separate `ProcessDefinition` consumed by one generic engine (the "worked example" in the Capability Standard doc, §4, describes this pattern precisely — and it's exactly what's running). |
| Idempotency Guard (shared) | One shared `IdempotencyGuard` + `idempotency_keys` table | **Partial / ad hoc.** No evidence of the single shared guard described in the plan; a concurrent session's most recent work this same day was titled "Fix duplicate-collection idempotency gap," suggesting idempotency is being handled per-endpoint as gaps are found, not via one shared mechanism yet. Real gap against the L3 contract — worth a dedicated pass (see §6). |
| Media / File Abstraction | Object storage port, S3 or local-filesystem adapter | **Built, local-filesystem today** (`backend/storage/media`) — matches the "L2 coverage of an L3 contract" pattern the Maturity Policy explicitly permits, *if* the port abstraction is real underneath (not verified in depth this session — flagged in §6). |
| Numbering / Audit / Terminology maturity | Target L3 contract | Contracts appear stable and reused consistently across every domain observed — consistent with the L3-contract/L2-coverage split the Maturity Policy calls for. |

## 4. Business domains — planned vs. actually implemented

[`DAII_DOMAIN_BOUNDARIES.md`](architecture/DAII_DOMAIN_BOUNDARIES.md) defines 12 domains. All are
now built (V1 planning explicitly deferred domain #12, Finance/GL — still correctly deferred).
Three domains grew well beyond the original V1 planning scope through later CTO directives, now
fully implemented and verified (see `MASTER_PROJECT_STATUS.md` for the detailed, evidence-cited
status of each): **RSH Shipping Orders**, **Custody** (Shipping Company + Company Vehicle), and
**Customer Financial Account / Invoice / AR / Treasury integration** — none of these were named as
distinct domains in the original 12, but none violate the domain-boundary rules either; each reuses
existing Foundation capabilities (Process Engine, Numbering, Audit, Scope) rather than introducing
parallel mechanisms. This is the intended extension model working as designed (§3's "Contract,
Adapter, Policy, Configuration" mechanisms), not scope creep outside the architecture.

**Important clarification** (a naming collision worth being explicit about): the Customer Financial
Account/Invoice/AR/Treasury domain built and verified this session is a **Daii-specific V1
business domain** (Customer Ledger, Sales Invoices, Payments, AR Aging, Treasury accounts) — it is
**not** the same thing as the deferred "Finance Phase 2" GL/chart-of-accounts system §2 rule #10
refers to. The former is built and live; the latter remains correctly unbuilt and unscoped. A future
session should not assume the AR/Treasury work means the Finance boundary has been crossed — it
hasn't; `DAII_FINANCE_INTEGRATION_BOUNDARY.md`'s event-catalog contract remains the plan for if/when
a real GL is ever added.

## 5. Cross-cutting readiness (directive's Performance/On-Prem/Security/Licensing ask)

This is already substantially designed, not a from-scratch gap:

- **On-Premise/LAN:** [`DAII_ONPREM_LAN_ARCHITECTURE.md`](architecture/DAII_ONPREM_LAN_ARCHITECTURE.md)
  — **ACCEPTED (ADR-019)**. Same application code, same PostgreSQL engine, same auth/permission/scope
  model runs identically in Cloud or On-Prem/LAN; only infrastructure adapters differ, selected at a
  single composition root. No installer/packaging/license flow built yet — deliberately deferred as
  a *deployment* step, not a *rebuild*, per the doc's own §3.
- **Infrastructure abstraction (the port/adapter mechanism that makes the above true):**
  [`DAII_INFRASTRUCTURE_ABSTRACTION.md`](architecture/DAII_INFRASTRUCTURE_ABSTRACTION.md) —
  **ACCEPTED (ADR-019)**. Binding rule: no domain or shared engine imports a cloud SDK directly or
  branches on deployment target; adapters are wired once at the composition root. **Not independently
  re-verified against the current codebase this session** — worth a grep-based audit (`aws-sdk`,
  direct `fs` calls outside the Media foundation, etc.) before claiming this is still true in
  practice, not just in the original design.
- **Backup/Recovery/Upgrade:**
  [`DAII_BACKUP_RECOVERY_UPGRADE_ARCHITECTURE.md`](architecture/DAII_BACKUP_RECOVERY_UPGRADE_ARCHITECTURE.md)
  — **ACCEPTED (ADR-020)**. `pg_dump`-based backup, roll-forward-first rollback strategy, audit
  hash-chain walk as a free post-restore integrity check. The prior V1 release
  (`planning/v1-release/`) already exercised a real `pg_dump`/`pg_restore` cycle with exact row-count
  verification — a real precedent exists, not just a plan.
- **Security:** [`DAII_SECURITY_ARCHITECTURE.md`](architecture/DAII_SECURITY_ARCHITECTURE.md) —
  the Permission/Scope/anti-enumeration model in §2 above. Licensing/anti-copy itself is explicitly
  **not** designed yet (correctly — it was rejected as V1 scope in `DAII_PLATFORM_ARCHITECTURE_V1.md`
  §4, "per-installation software licensing... no analog in a hosted web/mobile platform," written
  when Daii was cloud-only; the on-prem/LAN work since has reopened this as a legitimate future need,
  not yet re-scoped).
  **Licensing/anti-copy readiness check — done this session, per the directive's "readiness only,
  not a full build" scope.** Verified against real code, not assumed: (1) `main.ts` has a single
  composition root (`bootstrap()` calling `NestFactory.create(AppModule)` once) — a future license/
  activation check has exactly one place to hook in, server-side, before `app.listen()`, with no
  competing bootstrap path to also cover. (2) Every domain controller already carries a class-level
  `JwtAuthGuard` (§2/§6 above) and `configuration.schema.ts` already fails closed on missing/default
  secrets in production — the codebase's existing pattern for "reject at startup/request time unless
  a server-side condition holds" is exactly the pattern a license/activation guard would reuse, not
  a new mechanism. (3) No frontend-only gating exists anywhere (no feature is enabled/disabled by a
  frontend flag with no server-side check behind it) — confirmed by the same route-authorization
  spot-check in `MASTER_PROJECT_STATUS.md` §6, so there is no existing anti-pattern a future license
  check would have to work around. **Conclusion: no current architectural decision blocks
  server-side license validation, environment/server binding, signed builds, or secure activation —
  the codebase is ready for that work whenever it's actually scoped; nothing further was built now,
  per the directive's explicit "readiness only" instruction.**
- **Future sync (Daii Local ↔ Daii Cloud):**
  [`DAII_SYNC_READINESS_NOTE.md`](architecture/DAII_SYNC_READINESS_NOTE.md) — reference only, nothing
  built or required now. Worth knowing: 31/33 audited entities already use UUID primary keys (no
  cross-node collision risk later), and the inventory ledger's append-only shape happens to be
  sync-friendly by accident of its own (unrelated) design rationale.
- **Performance:** no dedicated architecture document exists for this (not one of the original 18).
  Not evaluated in depth this session — see `MASTER_PROJECT_STATUS.md` §6 for what a real,
  measured (not impressionistic) pass should cover.

## 6. What a future session should verify before trusting this reconciliation blindly

This document was built by reading the 18 architecture files plus this session's own direct code
observations — it is **not** a fresh line-by-line audit of every capability against the standard in
`DAII_PLATFORM_GRADE_CAPABILITY_STANDARD.md`.

**Verified this session, item 1 closed:** grepped the entire backend for cloud SDK imports
(`aws-sdk`, `@aws-sdk/*`, `S3Client`, a Redis client) and deployment-target branching
(`if (isCloud)`-shaped conditionals) — **found none**. Confirmed `backend/src/foundation/media/`
has a genuine port/adapter pair: `object-storage.port.ts` (the port) and
`local-filesystem-storage.adapter.ts` (the one adapter implemented today) — exactly the shape
described in §5, ready for a second (S3) adapter later without changing the port contract or any
consumer. The on-prem/LAN readiness claim holds up under actual code inspection, not just the
design docs.

**Verified this session, item 2 also closed (correcting an earlier wrong guess in this same
document):** a shared `IdempotencyService` genuinely exists
(`backend/src/foundation/error-contract/idempotency.service.ts`) — an explicit, opt-in
`withIdempotency(scope, key, operation)` wrapper matching `DAII_FOUNDATION_CROSSCUTTING_SPEC.md` §5's
contract closely, including correct handling of the concurrent-race case (a unique-constraint
collision on the idempotency key returns the actual winning record's cached result, not a generic
error). The concurrent session's "duplicate-collection idempotency" fix seen this session does
**not** use it — but on inspection that's appropriate, not a gap: that fix (`delivery.service.ts`,
`recordCollection`) enforces a **domain uniqueness invariant** ("a shipment may only ever have one
Collection record"), a `findOne`-then-`ConflictException` guard — a different concern from the
shared service's actual job (client-supplied retry keys surviving a duplicate HTTP request). Both
patterns are legitimate and now confirmed present; no shared-mechanism gap exists.

Remaining genuinely open item: a real, measured performance pass — **now done**, see
`MASTER_PROJECT_STATUS.md` §6 (a real N+1 bug found and fixed, a real unpaginated-list gap found and
precisely documented, rate limiting added).

**Structural conformance (Governance Rule 6) — run and reconciled this session.**
`npm run validate:structure` (`backend/tools/validation/validate-structure.js`) had never actually
been run against the current tree; it failed with 3 violations. Investigated each rather than either
force-fitting the code to the rule or silently loosening the check (Governance Rule 5 — disclose, don't
quietly resolve):
- `domains/reports` (missing `domain`/`infrastructure`) — a genuine, deliberate shape: a read-only
  aggregator over other domains' own data, owning no entities and no persistence of its own. A
  `domain`/`infrastructure` layer here would be an empty, unlabeled stub.
- `domains/sales` (missing `domain`) — a thin CRUD-around-a-profile domain
  (`createSalesRepProfile`/`getSalesRepProfile`/`isSalesRep`, 117 lines total across 3 files), no
  business rules or invariants of its own to justify a `domain` layer.
- `foundation/integrations` (has full domain-style layers) — the QR Platform connector integration
  genuinely outgrew "flat Foundation submodule": per-connector mapping/pairing/encryption logic
  benefits from real domain/application/infrastructure/interface separation. Kept under `foundation/`
  rather than moved to `domains/` to avoid an import-breaking rename this close to release for a
  purely organizational question — a future session should revisit reclassifying it to `domains/` if
  that boundary question ever becomes load-bearing (e.g. if Integrations grows real business rules
  beyond connector plumbing).

All three are now explicit, named, reasoned exceptions inside the validator itself
(`DOMAIN_MISSING_LAYER_EXCEPTIONS`/`FOUNDATION_LAYER_EXCEPTIONS`) — the validator still fails on any
*other* structural drift, it just no longer flags these three already-judged cases.
`node tools/validation/validate-structure.js` now passes clean.

## 7. Document map

| Document | Covers | Status |
|---|---|---|
| [`DAII_PLATFORM_ARCHITECTURE_V1.md`](architecture/DAII_PLATFORM_ARCHITECTURE_V1.md) | Why Daii looks the way it does; source-audit verdicts | Draft (historical rationale, still accurate) |
| [`DAII_PLATFORM_FOUNDATION_CONTRACT.md`](architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md) | The 20 Foundation capabilities, contract-by-contract | Draft — see §3 reconciliation above |
| [`DAII_DOMAIN_BOUNDARIES.md`](architecture/DAII_DOMAIN_BOUNDARIES.md) | The 12 Business Domains, ownership rules | Draft — see §4 reconciliation above |
| [`DAII_SECURITY_ARCHITECTURE.md`](architecture/DAII_SECURITY_ARCHITECTURE.md) | Identity/Auth/Permission/Scope in full | Draft — matches live behavior |
| [`DAII_DATA_ARCHITECTURE.md`](architecture/DAII_DATA_ARCHITECTURE.md) | Persistence, transactions, concurrency (incl. a real 30-concurrent-request advisory-lock test result) | Draft |
| [`DAII_API_ARCHITECTURE.md`](architecture/DAII_API_ARCHITECTURE.md) | Response envelope, versioning, idempotency intent | Draft |
| [`DAII_EVENT_ARCHITECTURE.md`](architecture/DAII_EVENT_ARCHITECTURE.md) | Outbox pattern, audit integration, background jobs | Draft — outbox pattern confirmed live |
| [`DAII_I18N_TERMINOLOGY_ARCHITECTURE.md`](architecture/DAII_I18N_TERMINOLOGY_ARCHITECTURE.md) | Terminology Registry, RTL/LTR | Draft — confirmed live and extensively used |
| [`DAII_MOBILE_ARCHITECTURE.md`](architecture/DAII_MOBILE_ARCHITECTURE.md) | Sales Rep Mobile App design (not yet built) | Draft |
| [`DAII_MATURITY_TARGET_POLICY.md`](architecture/DAII_MATURITY_TARGET_POLICY.md) | L3-contract/L2-implementation rule | **Accepted (ADR-016)** |
| [`DAII_FOUNDATION_CROSSCUTTING_SPEC.md`](architecture/DAII_FOUNDATION_CROSSCUTTING_SPEC.md) | One shared Audit/Events/Observability/Testing/Idempotency/Error-contract spec | **Accepted (ADR-017)** |
| [`DAII_FINANCE_INTEGRATION_BOUNDARY.md`](architecture/DAII_FINANCE_INTEGRATION_BOUNDARY.md) | What a future GL/Finance Phase 2 needs from today's events | **Accepted (ADR-018)** |
| [`DAII_INFRASTRUCTURE_ABSTRACTION.md`](architecture/DAII_INFRASTRUCTURE_ABSTRACTION.md) | Port/adapter catalog for deployment independence | **Accepted (ADR-019)** |
| [`DAII_ONPREM_LAN_ARCHITECTURE.md`](architecture/DAII_ONPREM_LAN_ARCHITECTURE.md) | Cloud vs. On-Prem/LAN deployment topology | **Accepted (ADR-019)** |
| [`DAII_BACKUP_RECOVERY_UPGRADE_ARCHITECTURE.md`](architecture/DAII_BACKUP_RECOVERY_UPGRADE_ARCHITECTURE.md) | Backup, restore, rollback strategy | **Accepted (ADR-020)** |
| [`DAII_REUSABLE_PLATFORM_CAPABILITY_CONTRACT.md`](architecture/DAII_REUSABLE_PLATFORM_CAPABILITY_CONTRACT.md) | What makes a capability reusable beyond Daii itself | Draft (Stage 1.1 extension) |
| [`DAII_PLATFORM_GRADE_CAPABILITY_STANDARD.md`](architecture/DAII_PLATFORM_GRADE_CAPABILITY_STANDARD.md) | The L0-L3 maturity rubric, 14 evaluation dimensions | Draft (Stage 1.1 extension) |
| [`DAII_SYNC_READINESS_NOTE.md`](architecture/DAII_SYNC_READINESS_NOTE.md) | What must stay true for a future Daii Local↔Cloud sync | Reference only, not a build plan |

Also relevant, not in `architecture/`: [`docs/DAII_ENGINEERING_GOVERNANCE.md`](docs/DAII_ENGINEERING_GOVERNANCE.md)
(referenced by several of the above as the governance-enforcement layer — not read/reconciled in
this pass, flag for a future session) and `architecture/extraction/`, `architecture/decisions/`
(the full ADR set and source-extraction matrix these summaries reference — kept as-is, detailed
historical record, not duplicated here).
