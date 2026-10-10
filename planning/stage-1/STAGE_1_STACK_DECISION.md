# Stage 1 — Daii Stack Decision Report

Status: **DRAFT — recommendation made, not silently finalized.** See ADR-002.

---

## Option A: Express + JavaScript

| Criterion | Assessment |
|---|---|
| Domain complexity fit | Adequate for current V1 scope; both `baseline` and `xnexus-website` prove Express handles ERP-scale route surfaces (300+ routes in `xnexus-website/server.js` alone) |
| Type safety | None by default; relies entirely on discipline and tests — the audits found real defects plausibly linked to this (hardcoded role arrays with no compile-time check, `fetch()` error-handling gaps) |
| Modularity | Achievable (both sources show reasonable engine/repository separation) but not *enforced* — nothing stops a new file from reaching across boundaries; `baseline`'s own docs admit "duplication not sharing" as a deliberate, arguably regrettable convention |
| Dependency boundaries | Convention-only, no mechanical enforcement in either JS source |
| Maintainability | Proven at current source scale; unclear how it holds as Daii adds Finance Phase 2 and grows domain count |
| Team productivity | High if the team is already comfortable here — two of three sources are Express/JS, a real signal of existing tooling/deployment investment (e.g., `baseline`'s `ecosystem.config.js` PM2 setup) |
| Testing | No structural blocker; neither source has strong test coverage evidence in the audited engines beyond the process/regression reports |
| Validation | Manual/ad hoc (e.g., hand-written validation in each engine) |
| API design | Works fine; both sources' `{success, data, meta}` envelope pattern is stack-agnostic anyway |
| Long-term ERP complexity | Higher risk as domain count grows without static typing to catch cross-domain contract drift |
| Extraction effort from sources | **Lower for baseline/xnexus-website business logic** — same language, no translation step, though persistence and concurrency still require a full rewrite regardless (per ADR-003) |
| Database integration | Any Postgres driver/query-builder (Knex etc.) works fine |
| Background jobs | Any Node-compatible queue library works |
| Event architecture | Works, no structural advantage or disadvantage |
| Security architecture | No structural advantage — the actual gap found (auth, permissions) was a design/discipline failure, not a language limitation |

## Option B: NestJS + TypeScript

| Criterion | Assessment |
|---|---|
| Domain complexity fit | Strong — DI and module system map naturally onto the 12-domain structure in `DAII_DOMAIN_BOUNDARIES.md` |
| Type safety | Full — catches the exact defect class found repeatedly in the audits (untyped role checks, inconsistent record shapes across engines) |
| Modularity | Enforced via NestJS modules + decorators, not just convention |
| Dependency boundaries | **Mechanically enforceable** — RMS's ADR-006 lint rule proves this is achievable in this exact stack, not theoretical |
| Maintainability | Better long-term signal for a multi-year, multi-domain platform; worse if the team fights the framework |
| Team productivity | Lower initially if the team lacks NestJS/TS experience — **this is the one input this discovery cannot audit** |
| Testing | NestJS's DI makes mocking/unit testing more structured out of the box; Jest is already RMS's proven test runner (43/43 passing at Step 30) |
| Validation | `class-validator`/`class-transformer` give declarative, typed request validation — a direct upgrade over both JS sources' hand-written validation |
| API design | Decorator-based OpenAPI generation is close to free |
| Long-term ERP complexity | Better-suited as domain count grows toward Finance Phase 2 |
| Extraction effort from sources | **Higher for baseline/xnexus-website business logic** (translation required) — but since almost everything extracted from those sources is Class C/D (concept, not code) anyway per the extraction matrix, this cost is smaller than it first appears |
| Database integration | Prisma or TypeORM, both mature, both used with Postgres routinely |
| Background jobs | `@nestjs/bull` (BullMQ) is a first-class, well-supported integration |
| Event architecture | RMS's event-bus interface and platform-sdk facade pattern are directly reusable as a starting shape (Class C, code-adjacent) |
| Security architecture | RMS's Audit hash-chain (Class B, the one genuinely non-stub kernel module) ports with minimal translation if this option is chosen |

## Recommendation

**NestJS + TypeScript + PostgreSQL** — for the reasons detailed in ADR-002: boundary enforcement matching blueprint §41's no-domain-leakage requirement, better long-term fit for a growing multi-domain ERP, and the fact that nearly every extraction candidate is a concept/pattern port regardless of stack (so the "two sources are JS" argument carries less weight than a first glance suggests).

**This is not marked as a final, unconditional decision.** The recommendation is contingent on one input this discovery process has no evidence for: **does the implementation team have, or can it acquire, NestJS/TypeScript proficiency.** If not, Express + TypeScript (a middle option not separately tabled above — plain Express with TS added, sacrificing NestJS's DI/module enforcement but keeping static typing) or Express + JavaScript (accepting weaker mechanical boundary enforcement, compensated by stricter code review discipline) are credible fallbacks.

**Action required before ADR-002 can move from PROPOSED to ACCEPTED:** a human/CTO confirmation of team capability.
