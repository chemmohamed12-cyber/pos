# Daii Platform-Grade Maturity Scorecard

Status: **DRAFT — Stage 1.1 Extension.** Applies `DAII_PLATFORM_GRADE_CAPABILITY_STANDARD.md`'s 14 dimensions to the Priority-1 Shared-Engine candidates identified in Stage 1 (`DAII_SOURCE_EXTRACTION_MATRIX.md` summary) and the `DAII_REUSABLE_PLATFORM_CAPABILITY_CONTRACT.md` §5 hypothesis table. No new source-code discovery was performed — every level cites Stage 0 audit evidence already gathered.

Per-dimension levels use the L0–L3 scale from the Standard §1. `—` means "not evaluated / no source evidence available at this granularity" rather than a score.

---

## Scoring Legend Recap

- **L0** Prototype/Stub — not safe to depend on
- **L1** Domain-Coupled — solid but tied to a specific source platform/domain
- **L2** Daii-Hardened — domain-neutral, secure, real-DB, tested; proven only in one (assumed cloud) deployment model
- **L3** Platform-Grade — domain-neutral AND deployment-neutral AND fully documented/tested/versioned/observable

---

## Process Engine (`baseline/server/engines/process-engine.js`, ADR-008)

| Dim | Current | Target for Shared Engine | Gap |
|---|---|---|---|
| 2.1 Architecture | **L2** | L3 | Already single-responsibility, zero coupling — architecture itself needs no rework, just formal documentation |
| 2.2 Domain Independence | **L2** | L3 | Genuinely domain-neutral already (the Standard's own worked example, §4) — closest to L3 of any candidate |
| 2.3 API Contract | **L1** | L3 | No formal public contract exists yet — it's an internal JS module, not a documented, versioned interface |
| 2.4 Data Contract | **L0** | L2+ | Stateless as found — Daii adds `process_instances`/`process_transitions` tables from scratch (ADR-008); no existing data contract to inherit |
| 2.5 Security | **L1** | L2 | No security logic of its own by design (caller-enforced) — must formally document this as an explicit contract obligation on callers, not an implicit assumption |
| 2.6 Concurrency | **L1** | L2 | Stateless core has no concurrency issue itself; the *persistence* Daii adds around it must be built L2-correct from day one (ADR-003) |
| 2.7 Audit | **L0** | L2 | No audit hooks exist in the source; must be added as part of extraction, not inherited |
| 2.8 Events | **L0** | L2 | No event emission exists in the source; add per ADR-012 |
| 2.9 Testing | **L1** | L3 | Proven reused twice within `baseline` itself (informal evidence of correctness) but no visible formal test suite audited |
| 2.10 Observability | **L0** | L2 | None in source |
| 2.11 Versioning | **L0** | L2 | No versioning concept in source (single in-process module) |
| 2.12 Documentation | **L1** | L3 | Documented only as source-code comments within `baseline`, not as a standalone contract doc |
| 2.13 Configuration | **L2** | L2 | Process Definitions are already externalized data (states/transitions), not hardcoded — this is *why* the engine works at all |
| 2.14 Deployment Independence | **L2** | L3 | No infrastructure dependency of its own (stateless) — trivially deployment-independent once wrapped in a real persistence/audit/event layer that is itself deployment-independent |

**Overall read:** Best-positioned candidate for L3. The core logic needs almost no rework; the gap is entirely in the scaffolding Daii must build around it (contract doc, persistence, audit/event hooks, tests) — none of which is source-code risk.

## Inventory Ledger (`baseline/server/engines/inventory-ledger-engine.js`, ADR-007)

| Dim | Current | Target | Gap |
|---|---|---|---|
| 2.1 Architecture | **L2** | L3 | Domain-neutral by design (`inventoryType`-partitioned) — solid |
| 2.2 Domain Independence | **L2** | L3 | Genuinely generic; its *consumers* in `baseline` are domain-coupled (Reject), the ledger core itself is not |
| 2.3 API Contract | **L1** | L3 | Internal module only; no formal contract |
| 2.4 Data Contract | **L1** | L2+ | Missing warehouse/location dimension and Daii's stock-state vocabulary — a real data-model gap, not just a documentation gap (ADR-007) |
| 2.5 Security | **L1** | L2 | No permission gating inside the engine — caller-enforced, must be formalized |
| 2.6 Concurrency | **L0** | L2 | **Confirmed dependency on JSON-file-safe single-process writes** — caps this dimension at L0 until rebuilt on DB row-locking/conditional UPDATE per `DAII_DATA_ARCHITECTURE.md` §4; this is the single most important gap for this capability |
| 2.7 Audit | **L1** | L2 | Some audit logging exists in `baseline` generally but not confirmed specifically wired to ledger movements at the depth needed |
| 2.8 Events | **L0** | L2 | No event emission in source |
| 2.9 Testing | **L1** | L3 | "Battle-tested, used by 3 warehouse consumers" per audit — informal evidence, no formal test suite confirmed |
| 2.10 Observability | **L0** | L2 | None in source |
| 2.11 Versioning | **L0** | L2 | None in source |
| 2.12 Documentation | **L1** | L3 | Source-code-comment level only |
| 2.13 Configuration | **L2** | L2 | `inventoryType` partitioning is already externalized |
| 2.14 Deployment Independence | **L1** | L3 | Currently JSON-file-dependent (2.6's gap directly caps this too) — once rebuilt on Postgres, deployment-independent by the same logic as Process Engine |

**Overall read:** Strong math, weak concurrency foundation. The ledger core's *algorithm* is reusable, but Concurrency (2.6) is the dimension requiring the most real engineering work, not just documentation — this is the same finding as ADR-007/ADR-003, now made explicit on a per-dimension basis.

## Permission Engine + Limit Engine (`xnexus-website`, ADR-005)

| Dim | Current | Target | Gap |
|---|---|---|---|
| 2.1 Architecture | **L2** | L3 | Clean, well-reasoned per audit — but genuinely proven only at the tenant/website granularity |
| 2.2 Domain Independence | **L1** | L3 | **Confirmed gap**: resolves per-tenant only, no per-user-role dimension — this is a real architecture rework (ADR-005), not just hardening |
| 2.3 API Contract | **L1** | L3 | `/permissions/mine` exists as a read endpoint but the full write/admin contract isn't formally specified as a standalone document |
| 2.4 Data Contract | **L1** | L2+ | Schema needs the added per-user-role dimension before it can be a stable Daii-wide contract |
| 2.5 Security | **L2** | L3 | **Strongest security evidence of any candidate** — independently verified over real HTTP with real tokens in source's own phase reports, 404-not-403 anti-enumeration proven, not asserted |
| 2.6 Concurrency | **L1** | L2 | Read-heavy, low write contention — lower risk than Inventory Ledger, but still JSON-file-backed today |
| 2.7 Audit | **L1** | L2 | Permission-profile changes are auditable events but not confirmed wired to a hash-chained audit trail |
| 2.8 Events | **L0** | L2 | No formal event emission confirmed |
| 2.9 Testing | **L2** | L3 | Source's own Phase D-02 methodology (verify forbidden code paths structurally don't exist) is itself an L3-grade testing practice — the *practice* is L3, needs porting alongside the code |
| 2.10 Observability | **L1** | L2 | Some evidence via phase-report verification methodology, not confirmed as ongoing production observability |
| 2.11 Versioning | **L0** | L2 | Not evaluated in source |
| 2.12 Documentation | **L2** | L3 | Unusually well-documented by source's own standards (phase reports) — closest to L3 on this dimension of any candidate |
| 2.13 Configuration | **L2** | L2 | Package→Profile chain is already externalized data |
| 2.14 Deployment Independence | **L0** | L3 | Not yet evaluated against on-prem/LAN (ADR-015 is new) |

**Overall read:** Best Security and Documentation evidence of any candidate, but Domain Independence (2.2) requires genuine redesign, not just hardening — this is the one dimension where "extract the pattern" (Stage 1's classification) understates the amount of new design work involved.

## Geography Engine + Egypt Master Data (`xnexus-website`, ADR-010)

| Dim | Current | Target | Gap |
|---|---|---|---|
| 2.1–2.2 Architecture / Domain Independence | **L2** | L3 | Built QR-domain-independent from the start, confirmed by audit — strongest Domain Independence score of any QR Platform candidate |
| 2.3–2.4 API/Data Contract | **L1** | L2+ | Stable canonical IDs already (matches blueprint §37) — good data contract bones, no formal public API contract yet |
| 2.5 Security | **L2** | L2 | Reference/master data, low security surface — L2 is likely sufficient long-term, not just a waypoint |
| 2.6 Concurrency | **L2** | L2 | Infrequent writes, low contention — lowest-risk dimension of any candidate |
| 2.7–2.11 Audit/Events/Testing/Observability/Versioning | **L0–L1** | L2 | Standard gaps shared with every other candidate — none audited in depth at Stage 0 |
| 2.12 Documentation | **L2** | L3 | Phase F reports are genuinely thorough (sourcing methodology, HDX P-codes documented) |
| 2.13 Configuration | **L2** | L2 | Already data-driven |
| 2.14 Deployment Independence | **L2** | L3 | Reference data with no infra dependency beyond the DB itself — likely the easiest candidate to reach L3 on this dimension |

**Overall read:** Lowest-risk candidate overall — near-direct reuse per Stage 1, and this scorecard confirms no dimension has a severe gap. Primarily needs documentation/contract formalization, not redesign.

## Audit Engine (`30/kernel/audit`, ADR-012)

| Dim | Current | Target | Gap |
|---|---|---|---|
| 2.1–2.2 Architecture / Domain Independence | **L2** | L3 | Framework-agnostic, dependency-free algorithm — genuinely generic |
| 2.6 Concurrency | **L1** | L2 | Append-only writes are inherently low-contention; the gap is persistence (in-memory only), not concurrency logic |
| 2.7 Audit (self-referential — its own integrity) | **L2** | L3 | The one module RMS's own audit calls "fully real, not a stub" — hash-chain integrity logic is sound; needs a durable backend to reach L3 |
| 2.9 Testing | **L1** | L2 | One spec file exists (`audit.service.spec.ts`) — a real start, not comprehensive |
| 2.14 Deployment Independence | **L1** | L3 | In-memory store is trivially deployment-portable in principle but not yet proven against any real persistence target |
| All others | **L0–L1** | L2 | Same standard gaps as every candidate — no contract doc, no formal versioning |

**Overall read:** Small, sound, low-risk algorithm; the entire gap to L2 is "give it a real database," which is already ADR-012's stated plan.

## RMS Generator/Validator Tooling (Class A, engineering governance, not a runtime capability)

Not scored against the runtime-capability dimensions (2.3–2.8, 2.10 don't meaningfully apply to a build-time script). Scores **L2–L3 on Architecture, Domain Independence, Configuration, and Deployment Independence** as-is — plain Node.js `fs`/`path`, zero framework coupling, confirmed portable regardless of ADR-002's outcome. The most Platform-grade-ready asset in the entire discovery, precisely because it was never coupled to a runtime deployment model in the first place.

---

## Cross-Cutting Finding

**Every single candidate scores L0 on Deployment Independence (2.14) except Geography, Process Engine, and the tooling** — confirming ADR-015's framing that this is genuinely new evaluation ground, not an oversight in Stage 1. **Every candidate scores L0–L1 on Audit, Events, Testing, and Observability (2.7–2.10)** — these four dimensions are the common, expected gap across the whole Foundation layer, not a property of any one engine's quality, and should be planned as a shared Stage 2 workstream (a common Audit/Event/Test/Observability harness applied consistently) rather than re-solved independently per capability.
