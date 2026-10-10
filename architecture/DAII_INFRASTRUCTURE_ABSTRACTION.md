# Daii Infrastructure Abstraction

Status: **ACCEPTED (ADR-019).** Stage 1.1 Final Closure item E. Consolidates and extends the port catalog first introduced in `DAII_REUSABLE_PLATFORM_CAPABILITY_CONTRACT.md` §4 — this is now the canonical reference for it.

---

## 1. The Binding Rule

**No Business Domain and no Shared Engine imports a cloud-specific SDK (AWS S3 client, a specific Redis client, a specific cloud provider's API) directly.** Every infrastructure dependency is accessed through a Foundation-defined port; a concrete adapter is selected at deployment/composition time via configuration (ADR-015, generalizing ADR-006/ADR-018's domain-boundary lint-rule discipline to this second axis).

```
if (consumer === "Daii") { ... }     ← PROHIBITED inside a Shared Engine (this directive §2)
if (deploymentTarget === "cloud") { ... }   ← PROHIBITED inside domain/business code
```

Both are the same anti-pattern: a hardcoded branch standing in for what should be a configuration-selected adapter. The port/adapter mechanism exists precisely so this branch never needs to be written anywhere except in the one composition-root file that wires adapters to ports at startup.

## 2. Port Catalog

| Port | Cloud Adapter | On-Premise/LAN Adapter | Consumed by |
|---|---|---|---|
| Relational Database | Managed PostgreSQL | Self-hosted PostgreSQL | Every domain (via repository contracts, `DAII_DATA_ARCHITECTURE.md`) |
| Object Storage | S3-compatible | Local filesystem / self-hosted MinIO | Media Foundation (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §15) |
| Cache | Managed Redis | In-process cache (LAN single-instance scale) or self-hosted Redis | Rate limiter, response cache (`DAII_API_ARCHITECTURE.md` §7) |
| Background Job Queue | Managed Redis + BullMQ | Postgres-backed queue (`pg-boss` or equivalent) | Background Processing (`DAII_EVENT_ARCHITECTURE.md` §4) |
| Event Bus / Outbox Dispatcher | Same outbox pattern, cloud-hosted dispatcher process | Same outbox pattern, on-prem dispatcher process — **no different mechanism**, only where the dispatcher process runs | Event Engine (`DAII_EVENT_ARCHITECTURE.md` §2) |
| Notification Transport | Cloud email/SMS/WhatsApp provider APIs | Same providers if the site has internet reachability; degraded-mode behavior is an open design question (R13) if not | Notification Engine (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §11) |
| Secrets | Cloud secrets manager | Environment-file-based secrets, same fail-closed-on-missing/default policy | Authentication (`DAII_SECURITY_ARCHITECTURE.md` §2) and every credential-holding capability |
| Observability sink | Cloud log aggregator / APM | Local log files + optional self-hosted aggregator | Observability (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §19) |

## 3. Composition-Root Discipline

Exactly one place in the codebase (the application bootstrap/composition root) reads deployment configuration and wires concrete adapters to ports. No other file in the codebase branches on deployment target. This is a Stage 2 build-order item (`planning/stage-2/STAGE_2_BUILD_ORDER.md`, item 19 — "Shared infrastructure adapters") and a governance-enforced rule (`docs/DAII_ENGINEERING_GOVERNANCE.md`), not just a design intention.

## 4. Relationship to the Platform-Grade Standard

Standard §2.14 (Deployment Independence) is scored per capability precisely by checking this table — a capability that cannot name its On-Premise/LAN adapter, even hypothetically, has failed this dimension regardless of how well it scores elsewhere (per the maturity scorecard's finding that nearly every candidate currently sits at L0 here).
