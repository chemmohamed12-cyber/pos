# Daii On-Premise / LAN Architecture

Status: **ACCEPTED (ADR-019).** Stage 1.1 Final Closure item D. Architecture only — no On-Premise product/installer is built in V1 (this directive §4, blueprint §49).

---

## 1. Deployment Topology

```
                    Cloud                          On-Premise / LAN
        ┌─────────────────────────┐       ┌─────────────────────────┐
        │  Managed PostgreSQL      │       │  Local PostgreSQL        │
        │  Managed object storage  │       │  Local filesystem/MinIO  │
        │  Managed Redis/queue     │       │  Postgres-backed queue   │
        │  App server (autoscaled) │       │  App server (single/few  │
        │                          │       │  nodes on customer LAN)  │
        └─────────────────────────┘       └─────────────────────────┘
                    ↑                                  ↑
             Same application code, same domain/API contracts, different adapters selected at deployment time (ADR-015, ADR-019)
```

The application code that implements Sales Orders, Inventory, Shipment, etc. does not know or care which column it's running in — this is the entire point of the port/adapter discipline (`DAII_INFRASTRUCTURE_ABSTRACTION.md`).

## 2. Requirements Addressed

| Requirement | Design |
|---|---|
| **Local application server** | The same NestJS/TypeScript (pending ADR-002 finalization) application binary/container runs on a customer's own server hardware — no code fork between Cloud and On-Premise builds, only environment configuration (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §8) selects adapters. |
| **PostgreSQL** | Same engine both places (ADR-003) — self-hosted on-prem, managed in cloud. Concurrency guarantees (locking, optimistic concurrency, ADR-003 §4) are identical because it's the same database engine, not a different one requiring separate correctness proofs. |
| **Multiple concurrent users** | Already a first-class requirement for Cloud (`DAII_DATA_ARCHITECTURE.md` §4) — a LAN deployment with, say, 5–50 concurrent warehouse/sales users is a *smaller-scale* instance of the same concurrency model, not a different one. No separate "LAN mode" concurrency logic is needed. |
| **Authentication** | Foundation Authentication (ADR-004) works fully offline-from-cloud — it is Daii's own service, not a dependency on an external cloud identity provider. A LAN deployment with no internet at all still authenticates users normally. |
| **Authorization** | Same Permission/Scope Engine (ADR-005), same data, same enforcement — no special-casing for on-prem. |
| **Concurrency** | Covered above — identical model, different hosting scale. |
| **Local storage** | Object storage port (`DAII_INFRASTRUCTURE_ABSTRACTION.md`) resolves to a local-filesystem or self-hosted MinIO adapter on-prem instead of S3 — same Media Foundation contract (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §15), different adapter. |
| **Backup/restore** | See ADR-020 / `DAII_BACKUP_RECOVERY_UPGRADE_ARCHITECTURE.md` — on-prem backup is a first-class requirement (no managed-service auto-backup to fall back on), not an afterthought. |
| **Upgrade/rollback** | See ADR-020 — an on-prem site cannot be upgraded the way a cloud fleet is (blue/green, managed migrations); the strategy must work for a single customer-operated instance. |
| **Health/diagnostics** | The same `/health/deep` aggregator (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §17) works identically — an on-prem operator (who may not have Daii's own engineering team on call) needs this to be at least as clear as the cloud version, arguably clearer since there's no central ops team watching it by default. |

## 3. What Is Explicitly Deferred (per this directive §4)

- No installer, no packaging, no license/activation flow (the open question from ADR-015 remains open), no on-prem-specific admin UI, no offline notification degraded-mode implementation (design only, per Stage 1.1's risk R13).
- No adapter code for the On-Premise column is written in V1 — only the port contracts are designed to already support it (ADR-016's maturity policy: contract at L3 scope, coverage at L2).

## 4. Why This Doesn't Require Future Reconstruction

Because every Foundation/Shared Engine's contract (per ADR-016) was already designed without a hidden Cloud-only assumption — Authentication doesn't assume a cloud IDP, Permission/Scope doesn't assume a multi-tenant SaaS-only model, Inventory Ledger doesn't assume a managed database's specific features — adding the On-Premise/LAN adapters later is implementing already-designed ports, not redesigning the domains that use them.
