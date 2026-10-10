# ADR-016 — Platform-Grade Maturity Target Policy

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_MATURITY_TARGET_POLICY.md`

## Context

The Platform-Grade Capability Standard (Stage 1.1) defines L0–L3. Without an explicit policy on which level is the *target* versus which is merely *acceptable for V1*, there is a real risk of building V1 in a way that requires breaking redesign later to reach L3 — exactly what a "temporary architecture" anti-pattern looks like.

## Decision

**L3 (Platform-Grade) is the architecture target for every Foundation/Shared Engine contract, from the first line written.** L2 (Daii-Hardened) is an acceptable **implementation** bar for V1 shipping, but only where a capability's L2 implementation is a strict subset of its L3 design — never a divergent shortcut. Concretely: contracts, data models, and extension points (contract/adapter/policy/configuration) are designed at L3 scope up front; what may lag at V1 is *coverage* (e.g., only the Cloud adapter is implemented, the On-Premise adapter's interface exists but isn't built yet) — never *shape* (there is no separate "V1 contract" and "future contract").

## Consequences

- Every capability entry in `architecture/extraction/DAII_PLATFORM_GRADE_MATURITY_SCORECARD.md` gains a required field at Stage 2 implementation time: **"L2 exception justification"** — if a capability ships at L2, the specific dimension(s) held back and why must be stated, and the L3 path must already be visible in the contract (not hypothetical).
- A capability that would require a breaking contract change to go from L2 to L3 fails this policy at design time, not discovered later — this is a Stage 2 code-review gate, not just a planning-time aspiration.
- This does not mean building unused infrastructure for V1 (e.g., no On-Premise adapter code ships in V1 per blueprint §49/this directive §4) — it means the *port* the adapter would plug into already exists in the contract.
