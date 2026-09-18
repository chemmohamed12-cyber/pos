# ADR-001 — Daii Platform Independence

**Status:** ACCEPTED
**Date:** 2026-08-22

## Context

The workspace contains three source repositories — `baseline/`, `30/`, `xnexus-website/` — all completed and audited in Stage 0 (`Daii/_source-audits/`). The blueprint (§3) and the CTO directive both mandate that Daii not be a clone, fork, or merged copy of any of them.

## Decision

Daii is built as an independent platform in its own directory tree (`Daii/`), separate from all three source repositories. Source repositories remain unmodified, referenced-only. Daii extracts validated concepts/patterns per `architecture/extraction/DAII_SOURCE_EXTRACTION_MATRIX.md`, never entire modules or repositories wholesale.

## Consequences

- No `git clone`/fork of any source repo into `Daii/`.
- Every extraction requires a matrix entry with an explicit classification (A–E) and rationale before it's ported.
- Daii's own persistence, security, and domain models are designed fresh (see ADR-003, ADR-004, ADR-005, ADR-006), informed by but not copied from the sources.
- Source repositories may continue to evolve independently; Daii does not track or re-sync against them automatically.
