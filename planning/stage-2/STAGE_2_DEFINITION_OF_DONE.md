# Stage 2 — Definition of Done

Status: **ACTIVE.** Applies to every Phase A and Phase B item in `STAGE_2_BUILD_ORDER.md`.

---

## Per-Capability Definition of Done

A build-order item is **Done** only when all of the following hold — not when code merely runs once locally:

1. **Contract matches architecture** — the implementation's public API/data contract matches the corresponding Stage 1/1.1 architecture document exactly (`DAII_PLATFORM_FOUNDATION_CONTRACT.md`, `DAII_DOMAIN_BOUNDARIES.md`, or the relevant ADR). Any deviation is either a documented ADR amendment or a bug, never a silent drift (governance rule 2).
2. **Security enforced server-side** — no capability ships that relies on client-side gating as its enforcement boundary (`DAII_SECURITY_ARCHITECTURE.md` §3, binding).
3. **Real database, real transactions** — no JSON-file persistence, no in-memory-only state for anything the architecture designates durable (ADR-003).
4. **Idempotent where state-changing** — per the shared `IdempotencyGuard` (`DAII_FOUNDATION_CROSSCUTTING_SPEC.md` §5), not a bespoke per-endpoint mechanism.
5. **Audited** — every state change produces an Audit record via the shared `AuditRecorder` (§1 of the same document), not a custom log line.
6. **Events emitted per contract** — every event named in the capability's Stage 1 domain/event contract is actually emitted, with the correct schema version.
7. **Errors follow the canonical contract** — no ad hoc error shape; every error resolves through the shared envelope (`DAII_API_ARCHITECTURE.md` §2).
8. **Tested per the shared harness** — unit tests for pure logic, integration tests against a real test database, contract tests for the public API, and (where the capability has a race-condition surface) concurrency tests, and (where it's security-relevant) authorization tests proving the forbidden code path is structurally absent (`DAII_FOUNDATION_CROSSCUTTING_SPEC.md` §4).
9. **Observable** — structured logs and a real functional health probe registered with `/health/deep`, correlation ID propagated end-to-end.
10. **No hardcoded domain/consumer/deployment branching** — no `if (consumer === "Daii")`, no `if (domain === "X")`, no `if (deploymentTarget === "cloud")` inside a Shared Engine (this directive §2, `DAII_INFRASTRUCTURE_ABSTRACTION.md` §1). Variation is via contract, adapter, policy, or configuration only.
11. **Documented** — purpose, contract, dependencies, security model, data ownership, failure behavior, and integration instructions exist as a standalone reference (Standard §2.12), not only as source comments.
12. **Configuration externalized** — no hardcoded secret, environment-specific URL, org identifier, or business constant that belongs in the Configuration Engine (`DAII_MATURITY_TARGET_POLICY.md` §2's "not allowed" examples are a direct checklist here).
13. **Arabic/English quality bar met where the capability has user-facing labels** — Professional Egyptian Business Arabic and proper English business terminology, resolved through the Terminology Registry, never hardcoded strings (`DAII_I18N_TERMINOLOGY_ARCHITECTURE.md` §4).
14. **Maturity level stated** — the capability's current per-dimension level (L0–L3, per the Platform-Grade Standard) is recorded, and if it ships at L2 on any dimension, the justification required by ADR-016 is written down, not assumed.

## Milestone-Level Definition of Done

**Phase A (Foundation) is Done** when every item in `STAGE_2_BUILD_ORDER.md` Phase A satisfies the 14-point checklist above and `STAGE_2_FOUNDATION_READINESS.md` shows all 20 items at Build Status: Complete.

**A Phase B domain is Done** when it satisfies the same checklist AND its domain boundary is verified — no direct persistence access to another domain's tables, no business logic bypassing the Foundation capabilities it depends on (`DAII_DOMAIN_BOUNDARIES.md`'s Cross-Domain Rule, mechanically checked per ADR-006/ADR-019's boundary-enforcement tooling once item 1's structure-validator is in place).

**Stage 2 as a whole is Done** when V1's full operational scope (blueprint §42, this directive §4) — Customer → Sales Rep → Sales Order → Supervisor Review → Manager Approval → Deposit Verification → Stock Reservation → Warehouse → Picking → Packing → Shipment → Waybill → Tracking → Delivery → Collection/Return — runs end-to-end against a real database with every Definition-of-Done point satisfied at every step, with Finance, full offline-first, and On-Premise packaging still correctly out of scope.
