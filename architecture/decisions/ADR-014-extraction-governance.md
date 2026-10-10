# ADR-014 — Extraction Governance

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `docs/DAII_ENGINEERING_GOVERNANCE.md`

## Context

RMS Step 30's governance culture — every stub labeled as a stub in-source, disclosed discrepancies rather than silently resolved, mechanically-validated repository structure — is itself a transferable asset independent of any reusable code, and directly matches blueprint §6 ("no silent copying") and §41 ("no silent refactoring").

## Decision

Daii adopts RMS's governance discipline as binding process, carried forward into `docs/DAII_ENGINEERING_GOVERNANCE.md`:

1. Every stub, once Daii has its own code, is labeled as a stub in-source with a pointer to what real requirement it doesn't yet satisfy.
2. No silent refactoring; no silent copying — every extraction cites its matrix entry and rationale.
3. Every architecture discrepancy is disclosed, not quietly resolved (this document set's own open items — e.g., ADR-002's pending team-capability input — are examples of the practice, not exceptions to it).
4. Repository structure is mechanically validated once the stack (ADR-002) is chosen — a generator + validator pair, adopting RMS's `tools/generators/` and `tools/validation/` scripts directly (Class A, stack-neutral).
5. Business Modules never import platform/kernel internals directly — enforced mechanically (ADR-006).
6. Source repositories (`baseline/`, `30/`, `xnexus-website/`) remain immutable references — Daii never writes back to them.

## Consequences

- Every future Stage cites `_source-audits/` as evidence rather than repeating discovery (binding per the CTO directive Part 0).
- Every extraction matrix row is treated as the single source of truth for "why was this ported/rejected" — new engineers don't re-derive it from reading source code cold.
- This governance model is itself subject to review — but changes to it are ADRs, not silent drift.
