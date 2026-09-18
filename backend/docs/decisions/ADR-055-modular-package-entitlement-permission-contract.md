# ADR-055 — DAII Modular, Package, Entitlement & Permission Master Architecture Contract

**Status:** ACCEPTED — ranked above per-module ADRs; every future module ADR must comply with it.
**Date:** 2026-09-18
**Full detail:** `architecture/DAII_MODULAR_PACKAGE_ENTITLEMENT_PERMISSION_CONTRACT.md`
**Parent:** ADR-053 (DAII ERP Long-Term Completion Charter)

## Context

`ADR-054` closed a real but narrow question (Procurement's GRNI accounting
policy). The CTO separately identified a broader, longer-lived risk: HR,
Payroll, and Manufacturing are about to be built without an explicit,
binding statement of how DAII is packaged, entitled, and permissioned as it
grows — and ratifying that after those modules exist would most likely force
re-auditing every one of them for compliance.

## Decision

**DAII is built as a set of small, bounded, independently entitlable
modules — never as monolithic growth of the Core.** Every module, current
and future, must satisfy all of:

1. Bounded module surface (backend, frontend, migrations, permissions,
   configuration, audit, dependencies, entitlements, tests) — removable from
   an edition without breaking the Core or another module.
2. Module **entitlement** (does the customer own it — Package/Edition level)
   is architecturally distinct from user **permission** (may this user use
   it — Role/User level); neither substitutes for the other.
3. A Package Builder composes each customer's edition from the module tree;
   hiding a menu item is not entitlement.
4. Entitlement is enforced at the backend AND the frontend, with the backend
   as final authority — an unentitled module has no reachable UI, routes,
   API, data, or commands, matching the existing `RequireModuleGuard`
   pattern's anti-enumeration behavior.
5. Every module has a runtime lifecycle state (`AVAILABLE`/`ENABLED`/
   `DISABLED`), moving toward a formal Module/Capability Registry.
6. Permissions are fine-grained from the first commit (e.g.
   `procurement.supplier.approve`, not `can_view_procurement`), preserving
   the existing Maker/Checker discipline.
7. Dependency on another *optional* module must be a declared contract, never
   a hard code-level assumption that it exists.
8. Adding a module follows a formal lifecycle (entitlement → dependency check
   → migration → enable → permissions → configuration → verification);
   removing/disabling one never deletes its historical data — that data
   remains part of the installation's permanent record.
9. No new screen, API, or feature ships without an explicit Entitlement +
   Permission design as part of its Definition of Done — composing directly
   with `ADR-053 §18`'s three-proof "module complete" bar.

The full contract (`architecture/DAII_MODULAR_PACKAGE_ENTITLEMENT_PERMISSION_CONTRACT.md`)
is the canonical, binding reference. It ranks above individual module ADRs;
where a conflict is found, it is escalated per its own §10, not resolved
silently.

## Consequences

- HR, Payroll, and Manufacturing architecture-contract work (per `ADR-053 §9`/§13)
  must demonstrate compliance with this ADR's nine requirements before
  implementation begins.
- The Module/Capability Registry (contract §5) does not yet exist as a
  concrete system component — its design/build is a required near-term
  follow-up, tracked separately.
- Existing modules are not required to be retrofitted immediately, but any
  one of them touched by future work must be brought into compliance as part
  of that work.
- Escalation to the CTO is limited to the categories in the full contract's
  §10 (undeclarable optional-module dependency, conflict with an existing
  ratified ADR, an unanswered security/data-retention question, or a module
  that cannot get a clean lifecycle without a breaking Core change) — all
  other implementation decisions proceed without waiting for sign-off.
