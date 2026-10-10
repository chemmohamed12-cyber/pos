# ADR-005 — Authorization / Permission / Scope

**Status:** ACCEPTED (model) — Scope Engine implementation PROPOSED (no direct source exists)
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_SECURITY_ARCHITECTURE.md` §3, `architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md` §3–5

## Context

QR Platform's Permission Engine (hierarchical, deny-by-default, ancestor-walk inheritance, 404-not-403 anti-enumeration) is the strongest permission pattern found in any source, but resolves per-tenant only — it has no per-user-role dimension. No source has a Scope Engine (which specific records a user may act on) at all.

## Decision

Daii adopts a three-layer model: **Role (Authorization) → Permission (what) → Scope (which)**, evaluated on every request. Permission Engine's architecture is adopted from QR Platform with a per-user-role dimension added. Scope Engine is built fresh, informed by `baseline`'s per-record `computePermissions(record, user)` pattern and QR Platform's permission-node ancestry mechanics generalized to record-level filtering.

## Consequences

- A hidden UI button is never treated as a security boundary — every list/detail/mutation route re-derives Permission and Scope server-side.
- Unauthorized resource access returns 404, not 403 (anti-enumeration, adopted directly from QR Platform's consistently-verified discipline).
- Every Scope-filtering column requires a DB index (Scope filtering is a hot path).
- Verification standard: confirm forbidden actions have no code path for a given actor, not just that they currently return a rejection (adopted from QR Platform's Phase D-02 Authorization Matrix methodology).
