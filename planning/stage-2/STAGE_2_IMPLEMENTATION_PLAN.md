# Stage 2 — Implementation Plan

Status: **ACTIVE.** Implementation has begun (see `STAGE_2_FOUNDATION_READINESS.md` items 1-2).

---

## 1. Scope

Stage 2 implements the Daii Platform Foundation (Phase A) followed by the V1 Business Domains (Phase B), per `STAGE_2_BUILD_ORDER.md`. It does not implement Finance, full offline-first mobile, or On-Premise packaging (all deferred per ADR-018/ADR-013/ADR-019, and per this directive §4).

## 2. Stack (ADR-002, finalized this session)

- **Language/Framework:** TypeScript, NestJS
- **Database:** PostgreSQL
- **Structure:** clean 4-layer module pattern (domain/application/infrastructure/interface), adapted from RMS Step 30's proven pattern (Class A tooling reuse), enforced by a ported generator + structure-validator (`tools/generators/`, `tools/validation/`)
- **Boundary enforcement:** ESLint `no-restricted-imports` rule blocking cross-domain and Business-Module-imports-Kernel-internals violations (ADR-006/ADR-019 pattern, adapted from RMS's ADR-006)

## 3. First Implementation Milestone: Repository Structure + Backend Stack Bootstrap

**Scope (Build Order items 1-2 only):**
- A real, buildable, runnable NestJS/TypeScript project under `Daii/backend/`
- Domain-boundary folder structure matching `DAII_DOMAIN_BOUNDARIES.md` (a `foundation/` tree for the 20 Platform Core capabilities, a `domains/` tree for the 12 Business Domains) — folders created as placeholders per capability/domain, empty of business logic (mirrors RMS's own honest "skeleton, zero business logic" discipline, Class C process pattern adopted deliberately)
- The generator + structure-validator tooling, ported and adapted from RMS (Class A)
- A boundary-enforcement lint rule
- A minimal `AppModule` and a real `/health` endpoint (the first genuinely running code in the whole Daii package) — proof the stack boots, following RMS's own validation discipline (server boots, health check returns 200) rather than a bare "hello world"
- A `docker-compose.yml` for local PostgreSQL (dev-only; not a deployment artifact)
- No Identity, Authentication, or any other Foundation capability's actual logic yet — those are the next milestones, per the build order's explicit item-by-item sequencing

**Explicitly not in this milestone:** database connection/ORM setup (item 3), any Foundation capability's business logic (items 4+), any Business Domain (Phase B).

**Verification:** `npm run build` succeeds, `npm run start` boots the server, `GET /health` returns `200 { success: true }`. This is the same bar RMS's own Step 30 report used to prove its skeleton didn't break anything — applied here to prove Daii's skeleton actually runs, not just exists as files.

## 4. Subsequent Milestones (not started this session)

| Milestone | Build Order items | Depends on |
|---|---|---|
| 2 — PostgreSQL Foundation | 3 | Milestone 1 |
| 3 — Configuration + Identity | 4-5 | Milestone 2 |
| 4 — Authentication + Authorization + Permission + Scope | 6-9 | Milestone 3 |
| 5 — Organization + Audit + Events + Error Contract + Idempotency + Observability | 10-15 | Milestone 4 |
| 6 — Terminology + Numbering + Process Engine contract | 16-18 | Milestone 5 |
| 7 — Infrastructure adapters + Foundation tests | 19-20 | Milestones 2-6 complete |
| 8+ — Business Domains | 21-32 | Milestone 7 (Phase A fully Done) |

## 5. Governance in Effect (unchanged, `docs/DAII_ENGINEERING_GOVERNANCE.md`)

Every file created in this milestone cites its architectural source (extraction matrix row or ADR) where it adapts existing material, and is marked as new-build where it doesn't. No source repository is modified. No business logic is written ahead of its Foundation dependency being Done.
