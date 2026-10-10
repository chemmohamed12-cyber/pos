# Daii Reusable Platform Capability Contract

Status: **DRAFT — Stage 1.1 Extension.**
Companion to `DAII_PLATFORM_GRADE_CAPABILITY_STANDARD.md` (the *how mature* rubric). This document defines *what reusability itself means* for a Daii capability, and the mechanism by which a capability serves both Daii V1 and future consumers without becoming a domain-specific framework wearing a generic label.

---

## 1. Target Architecture

```
                    PLATFORM FOUNDATION
                           |
        +------------------+------------------+
        |                  |                  |
      Daii V1        Future Daii        New Vertical
                         Modules           Platform
        |                  |                  |
        +------------------+------------------+
                           |
                    Shared Engines
```

This is the structure Stage 1.1 exists to make achievable. It is not automatic: Stage 1's extraction matrix identified *concepts* worth reusing, but a concept becomes a member of the "Shared Engines" layer only once it clears the Platform-Grade Capability Standard on the dimensions that matter for cross-consumer reuse (Domain Independence, API/Data Contract, Security, Deployment Independence above all).

## 2. What Makes a Capability Reusable

A capability qualifies for the Shared Engines layer only if it is:

- **Domain-neutral** — passes Platform-Grade Standard §2.2 without exception; knows nothing about hospitality, restaurants, or even Daii's own Sales/Warehouse/Shipment vocabulary at the code level.
- **Contract-driven** — its public API/data contract (Standard §2.3–2.4) is the *only* thing a consumer depends on; internal implementation may change freely without breaking consumers as long as the contract holds.
- **Security-aware** — enforces its own authentication/authorization/scope requirements (Standard §2.5) rather than assuming a caller has already checked; a future vertical platform's caller code should not need to re-implement security the Shared Engine itself should guarantee.
- **Scope-aware** — where the capability touches per-tenant or per-user data, it accepts scope as an explicit input, never infers it from ambient global state (this directly generalizes the Scope Engine principle from `DAII_SECURITY_ARCHITECTURE.md` §3 to every Shared Engine, not just the Scope Engine itself).
- **Persistence-independent at the business-contract level** — callers interact through commands/queries, never through direct table access (Standard §2.1, §2.4); the underlying schema can be re-tuned or even re-hosted (see §4, Deployment Independence) without breaking any consumer.
- **Observable** — Standard §2.10, non-negotiable for anything shared across consumers, since a failure in a Shared Engine is by definition a multi-consumer incident.
- **Testable** — Standard §2.9; a Shared Engine without contract tests cannot safely serve a second consumer, because nothing would catch a breaking change before it reaches that consumer.
- **Versionable** — Standard §2.11; the whole point of a Shared Engine is that Daii V1 and a future platform can consume different versions of the same contract without either being forced onto the other's release cadence.
- **Configurable** — Standard §2.13; a Shared Engine's behavior varies by consumer through configuration, never through consumer-specific code forks.
- **Deployable in different environments** — Standard §2.14; a Shared Engine that only runs in Daii's specific cloud deployment cannot, by definition, be "shared" with an on-premise or LAN-deployed consumer.
- **Documented** — Standard §2.12; a Shared Engine's documentation is written for a consumer team that has never seen Daii's codebase, not for Daii's own engineers who already know the context.

## 3. The Extension Mechanism — Contracts, Adapters, Policies, Configuration

Per the CTO directive: where domain-specific behavior is required, a Shared Engine exposes an extension point rather than embedding the assumption. Four mechanisms, applied per situation:

| Mechanism | When to use | Worked example |
|---|---|---|
| **Contract** (interface the engine calls out to) | The engine needs a decision only the consumer domain can make, at a well-defined point in its logic | Process Engine calls a consumer-supplied `PermissionCheck(actor, transition)` contract at every state transition — the engine doesn't know what a "Sales Supervisor" is, only that *something* answers yes/no |
| **Adapter** (swappable implementation of an infrastructure port) | The engine depends on infrastructure that varies by deployment target | Object storage: Cloud deployment plugs in an S3 adapter, On-Premise plugs in a local-filesystem adapter, behind the same Media Foundation contract (ADR-015) |
| **Policy** (data-driven rule set, not code) | The engine's behavior should vary by business rule without a code change | Limit Engine's quota keys and thresholds are policy data (`limit_profiles`), not hardcoded per consumer |
| **Configuration** (Foundation Configuration Engine entries) | The variation is a simple value, not a rule or a swappable implementation | Numbering Engine's prefix format per document type; Notification Engine's channel credentials |

A capability that resorts to a fifth mechanism — **a hardcoded conditional branching on which consumer/domain is calling** — has failed Domain Independence (Standard §2.2) regardless of how well it scores elsewhere. This is the single most important structural rule in this contract.

## 4. Deployment Independence as a Reuse Precondition

A future vertical platform is not guaranteed to run in the same environment as Daii V1. Neither is a future on-premise/LAN deployment of Daii itself (see ADR-015). For a Shared Engine to serve both, every infrastructure dependency is accessed through a port, with the concrete adapter chosen at deployment/composition time:

| Port | Cloud adapter | On-Premise / LAN adapter |
|---|---|---|
| Relational database | Managed PostgreSQL | Self-hosted PostgreSQL (same engine, different hosting — no port abstraction needed at the DB-engine level per ADR-003/ADR-015, only at the connection/ops level) |
| Object storage | S3-compatible managed storage | Local filesystem or self-hosted MinIO |
| Background job queue | Managed Redis + BullMQ | Postgres-backed queue (`pg-boss` or equivalent) — avoids requiring Redis as a hard dependency for a small on-prem install |
| Cache | Managed Redis | In-process cache (acceptable at LAN single-instance scale, per `xnexus-website`'s `response-cache-engine.js` pattern, Class A, already proven at this scale) |
| Notification channels | Cloud email/SMS/WhatsApp providers | Same providers if internet-reachable from the on-prem site, or a documented degraded mode if not — **flagged as an open question**, not resolved here (see ADR-015 consequences) |
| Secrets | Cloud secrets manager | Environment-file-based secrets with the same fail-closed-on-missing/default-value discipline (`DAII_SECURITY_ARCHITECTURE.md` §5) — the *policy* (never a default secret) is deployment-invariant even when the *mechanism* (secrets manager vs. env file) varies |

## 5. Foundation Capabilities Assessed Against This Contract

Not every Stage 1 Foundation capability is a Shared-Engine candidate — some are inherently Daii-specific (e.g., Daii's own Sales Order domain logic is never meant to be "shared" with a future vertical platform; it's Daii's business, not a Foundation primitive). The distinction:

| Likely Shared Engine (Foundation, domain-neutral by design) | Daii-Specific (V1 business domain, not meant to generalize) |
|---|---|
| Process Engine (workflow) | Sales Order domain logic |
| Inventory Ledger (movement math) | Commerce/Catalog domain logic |
| Permission Engine, Limit Engine, Scope Engine | CRM/Customer domain logic |
| Audit Engine | Sales/Sales Rep domain logic |
| Event Engine | Deposit Control domain logic |
| Notification Engine | Fulfillment/Shipment/Waybill/Delivery/Returns domain logic (these ARE strong Shared-Engine candidates for a *future logistics-adjacent vertical*, but are Daii-V1-domain-owned for now — flagged as a later reassessment, not decided here) |
| Numbering Engine | |
| Geography Engine + Egypt Master Data | |
| Terminology Registry / Localization | |
| Configuration Engine | |

This table is a starting hypothesis, not a final classification — confirmed by applying the Platform-Grade Standard per capability in `architecture/extraction/DAII_PLATFORM_GRADE_MATURITY_SCORECARD.md`.

## 6. Relationship to Stage 1

This contract does not change any Stage 1 domain boundary, ADR, or extraction classification. It adds a *second* lens — Stage 1 asked "should Daii own this capability and where does it belong," this document asks "could this capability someday be depended on by something other than Daii, and what does that require." A capability can be a correct Stage 1 extraction target and still be far from satisfying this contract — that gap is tracked, not hidden, in the maturity scorecard.
