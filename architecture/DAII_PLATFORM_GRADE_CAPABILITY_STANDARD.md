# Daii Platform-Grade Capability Standard

Status: **DRAFT — Stage 1.1 Extension.** Does not modify or supersede any Stage 1 ADR or architecture document; adds a maturity rubric those documents are now evaluated against. See `planning/stage-1.1/STAGE_1_1_MATURITY_EXTENSION_PLAN.md` for how this fits alongside Stage 1.

---

## 0. Why This Exists

Stage 1 answered "what should Daii's Foundation capabilities do." This document answers a different question: **"is a given implementation of that capability mature enough to be reused beyond Daii V1 itself"** — by a future Daii module, or by a future vertical platform built on the same Foundation.

The existence of an Engine in a source repository — or even a well-designed extraction plan for it — does not make it Platform-grade. Most of Stage 1's Priority-1 extraction candidates are strong **concepts**, not yet Platform-grade **implementations**. This standard makes that gap explicit and measurable rather than assumed away.

## 1. Maturity Levels

| Level | Name | Definition |
|---|---|---|
| **L0** | Prototype / Stub | Works for one demo/dev scenario; hardcoded assumptions; no meaningful tests; not safe for any team to depend on. (RMS's `kernel/authentication` is a documented L0 — self-labeled "MINIMUM-FOUNDATION STUB.") |
| **L1** | Domain-Coupled | Functionally solid, production-proven even, but tied to a specific business domain or source platform's assumptions (hospitality hardware, QR restaurant menus, a single deployment target). Not reusable outside that context without rework. (Most audited source engines land here — e.g., `baseline`'s Sales Order engine, `xnexus-website`'s Delivery Dispatch domain.) |
| **L2** | Daii-Hardened | Domain-neutral, contract-driven, security-enforced, persisted on a real transactional database, tested — but proven only inside Daii's own deployment model (assumed cloud-hosted, single-tenant-per-install). Not yet verified to survive a different deployment target (on-prem, LAN) or a second consuming platform. |
| **L3** | Platform-Grade | Domain-neutral **and** deployment-neutral **and** fully documented, tested, versioned, and observable. Safe for a future vertical platform to depend on, or for Daii to run unmodified in Cloud, On-Premise, or LAN deployment, without Daii-V1-specific rework. |

No source engine audited in Stage 0 is L3 as found. The extraction matrix's classifications (A–E) describe *how much of the source is reusable as a starting point*; this standard describes *how far that starting point is from Platform-grade* — the two are complementary, not duplicates. See `architecture/extraction/DAII_PLATFORM_GRADE_MATURITY_SCORECARD.md` for the applied scoring.

## 2. The 14 Evaluation Dimensions

Every capability intended for Daii Foundation, reusable Daii infrastructure, or future-platform reuse is evaluated against all 14. A capability does not need to be L3 on every dimension to ship in Daii V1 (L2 is an acceptable V1 bar for most Foundation capabilities per Stage 1's ADRs) — but every dimension's current level must be **known and stated**, never assumed.

### 2.1 Architecture
- Clear, single responsibility; clear ownership; clear boundaries (mirrors `DAII_DOMAIN_BOUNDARIES.md`'s no-leakage rule, applied at the capability level, not just the domain level).
- No unrelated domain assumptions baked in.
- No source-platform coupling (no residual assumption that "this only makes sense for hospitality hardware" or "this only makes sense for a QR menu").
- No UI coupling — a capability's server-side logic never assumes a specific client's rendering needs.
- No persistence leakage — callers interact through the capability's contract, never its underlying tables directly.
- No direct dependency on legacy application structure (e.g., a specific source repo's file layout or a specific framework version tied to that repo).

### 2.2 Domain Independence
- The Engine does not assume XNEXUS Hospitality, QR restaurants, Daii Sales, Manufacturing, or Warehouse-specific behavior internally.
- Domain-specific behavior is injected via **contracts, adapters, policies, or configuration** — never embedded as an `if (businessType === 'hospitality')` branch inside a generic engine. (Process Engine already demonstrates this correctly — it knows nothing about "orders"; see §4 for the worked example.)
- A capability failing this dimension is, by definition, capped at L1 regardless of how well-built it otherwise is.

### 2.3 API Contract
- Explicit public contract: stable request/response models, error contract, validation contract.
- Versioning strategy stated (see 2.11).
- Authentication and authorization requirements declared per `DAII_API_ARCHITECTURE.md` §3's per-route declaration discipline.
- Idempotency behavior stated where the capability is state-changing.
- Pagination/filtering conventions stated where the capability returns lists.

### 2.4 Data Contract
- Owned entities and fields explicitly listed (no capability silently reads/writes a table it doesn't own — this is `DAII_DOMAIN_BOUNDARIES.md`'s ownership rule made concrete per-capability, not just per-domain).
- Relationships, invariants, unique constraints, and referential integrity stated as real DB constraints (`DAII_DATA_ARCHITECTURE.md` §5), not application-code-only assumptions.
- Lifecycle, deletion policy (soft vs. hard, per `DAII_DATA_ARCHITECTURE.md` §5), and retention policy stated explicitly, not left to be discovered later.

### 2.5 Security
- Authentication dependency, authorization, permission, and scope requirements declared per capability (not just per domain).
- Tenant/organization boundary behavior stated explicitly — does this capability's data isolate by organization, and how.
- Resource ownership rules stated (who may create/read/update/delete a given record).
- Sensitive-data handling and secret handling follow the centralized "sensitive field" marker discipline from `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §11/§19 — never ad hoc per-endpoint masking.
- All enforcement is server-side, per `DAII_SECURITY_ARCHITECTURE.md` §3's binding rule — no exceptions for "internal" or "trusted" capabilities.

### 2.6 Transactions and Concurrency
- Transaction boundary explicitly stated per state-changing operation.
- Concurrency model stated: locking strategy, optimistic concurrency where appropriate, race-condition prevention, duplicate-operation prevention.
- Idempotency and retry behavior stated.
- **A capability must not depend on synchronous JSON-file writes or process-local locks as its fundamental correctness model** — this single criterion caps every unmodified source engine at L1 at best, since all three sources share this property (`DAII_DATA_ARCHITECTURE.md` §1). This is the most consistent gap found across the entire Stage 0 discovery.

### 2.7 Audit
- Actor, organization, action, resource, resource ID, timestamp, correlation ID, result, and before/after diff (where meaningful) all captured per mutating operation.
- Audit integrity: append-only, tamper-evident (the hash-chain pattern from `DAII_EVENT_ARCHITECTURE.md` §3), not just "logged somewhere."

### 2.8 Events
- Events emitted and events consumed explicitly listed, with schema and version (`DAII_EVENT_ARCHITECTURE.md` §5).
- Idempotent consumption, retry, and failure behavior stated (outbox pattern, §2 of the same document).
- Ordering guarantees stated where relevant (per-aggregate ordering only, per §6).

### 2.9 Testing
- Unit tests for pure logic (Process Engine's stateless core is the easiest capability in the whole discovery to hit this bar, precisely because it has no side effects).
- Integration tests against a real (test) database — never a JSON-file fixture standing in for the real persistence model.
- Contract tests verifying the API contract (2.3) doesn't silently drift.
- Authorization and scope tests verifying the *structural absence* of forbidden code paths, not just a runtime rejection — adopting the verification standard QR Platform's Phase D-02 Authorization Matrix reports demonstrated (`DAII_SECURITY_ARCHITECTURE.md` §3).
- Concurrency tests where the capability has a race-condition surface (mandatory for anything touching Inventory reservation or Shipment Offer-Accept).
- Failure/retry and idempotency tests.

### 2.10 Observability
- Structured logging, with correlation ID propagation from the Audit Engine's `correlationId` field (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §19).
- Metrics for the capability's key operations (latency, error rate, throughput).
- A real functional health check contributing to `/health/deep`, following RMS's "real round-trip check, not hardcoded ok" discipline (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §17).
- Error tracking that never leaks secrets/stack traces externally (`DAII_API_ARCHITECTURE.md` §2) but is fully visible internally.

### 2.11 Versioning
- Explicit strategy for evolving the capability without breaking existing consumers, future platforms, mobile clients, or integrations — schema versioning for events (2.8), URL-path API versioning (`DAII_API_ARCHITECTURE.md` §4), and Terminology Registry-style label versioning (`DAII_I18N_TERMINOLOGY_ARCHITECTURE.md` §3) applied consistently.

### 2.12 Documentation
- Purpose, contract, dependencies, security model, data ownership, examples, failure behavior, and integration instructions — written as if for a team that has never seen this capability's source, not assumed-obvious to whoever built it.

### 2.13 Configuration
- No hardcoded secrets, environment-specific URLs, organization identifiers, deployment assumptions, or business constants that belong in the Configuration Engine (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §8).
- This directly targets the pattern found repeatedly in Stage 0 (hardcoded dev-secret fallbacks in both `baseline` and `xnexus-website`) — a capability with even one hardcoded secret fallback cannot exceed L1 on this dimension regardless of its other qualities.

### 2.14 Deployment Independence
- The capability does not inherently depend on a cloud-only managed service, a particular hostname, a particular source repository, or a particular deployment environment.
- Infrastructure dependencies (object storage, cache, message broker) are accessed through an abstract port, with environment-specific adapters selected at deployment/composition time — not hardcoded into the capability itself. See ADR-015 and `DAII_REUSABLE_PLATFORM_CAPABILITY_CONTRACT.md` §4 for the mechanism.
- **This dimension is new in Stage 1.1** — Stage 1's architecture assumed a single (implicitly cloud-hosted) deployment target throughout; no source engine or Stage 1 design was evaluated against on-premise/LAN portability before now. Every capability's score on this dimension should currently be read as "not yet evaluated" rather than assumed passing.

## 3. Scoring Convention

For each capability, record a **per-dimension level (L0–L3)**, not a single aggregate score — a capability can be L2 on Architecture and L0 on Deployment Independence simultaneously, and collapsing that into one number would hide exactly the information this standard exists to surface. The applied scorecard (`architecture/extraction/DAII_PLATFORM_GRADE_MATURITY_SCORECARD.md`) uses this convention against Stage 1's Priority-1 extraction candidates.

## 4. Worked Example — Domain Independence Done Right

`baseline`'s Process Engine (`server/engines/process-engine.js`, adopted per ADR-008) is the clearest existing example of dimension 2.2 done correctly: it knows only `(state, action, actor, excludedActor)` — no concept of "orders" or "plans" anywhere in its code. Daii's Sales Order Approval Workflow is a **Process Definition** — a configuration object naming states/transitions/actions — consumed by the generic engine, not a fork of it. A future vertical platform's own approval workflow (say, a purchasing-approval flow in an unrelated future product) would consume the *same* generic engine with its *own* Process Definition. This is the pattern every other Foundation capability should be hardened toward: the engine is generic; the domain-specific meaning lives in data/configuration the engine consumes, never in the engine's own code.

## 5. What This Standard Does Not Do

This document does not re-score or re-audit any source repository — every level assigned in the applied scorecard cites Stage 0 evidence already gathered (`Daii/_source-audits/`). It also does not block Daii V1 shipping with L2 capabilities where Stage 1's ADRs already accepted that bar (most Foundation capabilities) — it exists so that decision is *explicit and revisitable*, not invisible.
