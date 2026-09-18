# ADR-019 — On-Premise/LAN Foundation & Infrastructure Independence

**Status:** ACCEPTED (architecture) — no On-Premise product is built in V1
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_ONPREM_LAN_ARCHITECTURE.md`, `architecture/DAII_INFRASTRUCTURE_ABSTRACTION.md`
**Supersedes/extends:** ADR-015 (Deployment Model Independence) — ADR-015 established the principle; this ADR closes the remaining design detail the CTO directive's items D and E require.

## Context

ADR-015 established that infrastructure dependencies are accessed through ports, not hardcoded. This directive requires the Foundation to explicitly support a local application server, PostgreSQL, multiple concurrent LAN users, auth/authz, concurrency, local storage, backup/restore, and upgrade/rollback on-premise — without building the complete On-Premise product now.

## Decision

Every Foundation/Shared Engine contract is verified against a **third deployment target column (On-Premise/LAN), not just Cloud** — concretely: (1) no contract assumes internet reachability for anything that must work purely on a LAN (authentication, authorization, order/inventory/shipment operations all function with zero external connectivity — only Notification's external channels and any future Finance/carrier integrations are internet-dependent by nature, and are already isolated behind the Integration Gateway per `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §18); (2) every infrastructure port (ADR-015) has a concrete, named On-Premise/LAN adapter identified now, even though it is not built in V1; (3) concurrent-user correctness (locking, optimistic concurrency, ADR-003 §4) is identical on LAN Postgres and cloud-managed Postgres — same engine, same guarantees, only hosting differs.

## Consequences

- The On-Premise/LAN adapter column exists in `DAII_INFRASTRUCTURE_ABSTRACTION.md`'s port catalog now, populated with a named technology choice per port, but **no adapter code is written in V1** (per this directive §4 and blueprint §49).
- Backup/restore/upgrade for an on-premise install is a distinct operational concern from cloud (no managed-service auto-backup to rely on) — addressed in ADR-020.
- The on-premise licensing/activation open question from ADR-015 remains open and is not resolved by this ADR — it is a business-model question, not an infrastructure-portability one, and infrastructure independence does not require resolving it.
