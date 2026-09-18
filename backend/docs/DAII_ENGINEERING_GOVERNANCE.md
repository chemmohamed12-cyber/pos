# Daii Engineering Governance

Status: **ACCEPTED as binding process** (ADR-014). Adapted from RMS Step 30's governance culture, itself audited and rated a "transferable process asset" independent of any reusable code (`Daii/_source-audits/rms-step30/` §5).

---

## The 13 Governance Rules (from the CTO directive §2.20, adopted verbatim as binding)

1. Every stub must be explicitly labeled as a stub — in the code itself, once Daii has code, with a pointer to what real requirement it does not yet satisfy. Not a separate doc nobody reads mid-implementation.
2. No silent refactoring.
3. No silent copying — every extraction cites its `architecture/extraction/DAII_SOURCE_EXTRACTION_MATRIX.md` row and rationale.
4. Every extraction must have a written rationale (satisfied at the planning level by the matrix; must remain true at implementation time too — a PR that extracts code cites the matrix row).
5. Every architecture discrepancy must be disclosed, not quietly resolved — see `planning/stage-1/STAGE_1_RISK_REGISTER.md` for live examples of this practice, and ADR-002's PROPOSED (not ACCEPTED) status for another.
6. Repository structure must be mechanically validated — adopt RMS's generator/validator tooling pattern (`tools/generators/`, `tools/validation/`) once the stack (ADR-002) is chosen.
7. Business Modules must not import platform internals directly — enforced mechanically per ADR-006, not by convention alone.
8. Source repositories (`baseline/`, `30/`, `xnexus-website/`) remain immutable references — Daii never writes back to them, never treats them as branches to merge from.
9. Daii architecture must be independently owned — no domain silently reverts to copying a source's shape because it's easier (ADR-001).
10. Security decisions must be server-side enforceable — a hidden UI button is never a security boundary (ADR-005, blueprint §33).
11. Production persistence assumptions must be explicit — no code assumes synchronous file I/O safety the way both JS sources' concurrency guarantees implicitly did (ADR-003).
12. Concurrency assumptions must be explicit — every extraction matrix row with a "Concurrency Review" note must be resolved with an explicit mechanism (lock, optimistic version, unique constraint) before the corresponding Stage 2 code ships, not left implicit.
13. Every important architectural decision must be documented — as an ADR, with a real Status (PROPOSED/UNDER REVIEW/ACCEPTED), not asserted true in passing inside an unrelated document.

## How This Differs From "Aspirational Process Doc"

RMS's own audit found that this discipline was *actually followed*, not just stated — every kernel module's stub-comment names the specific undone requirement (RMS-doc section, ADR number), and the Step 30 report itself surfaced two unresolved judgment calls explicitly rather than picking quietly. Daii's version of this discipline is judged by the same bar: **a rule that isn't checked in code review isn't a governance rule, it's a wish.**

## Enforcement Points

| Rule | Enforced by |
|---|---|
| 1, 4 | Code review checklist; PR template referencing the extraction matrix |
| 2, 3, 9 | Code review; ADR-001/ADR-014 as the standing reference |
| 5, 13 | ADR process — every non-trivial decision gets a status, reviewed periodically for PROPOSED items still pending |
| 6, 7 | Mechanical tooling (lint rule / structure validator), once ADR-002 is resolved |
| 8 | No write access from Daii tooling to `baseline/`, `30/`, `xnexus-website/` — enforced by directory/repo permissions, not just intention |
| 10, 11, 12 | Security/data architecture review gate before a domain's Stage 2 code merges (see `DAII_SECURITY_ARCHITECTURE.md`, `DAII_DATA_ARCHITECTURE.md`) |

## Relationship to Stage 0 Evidence

Every future Daii engineering stage cites `Daii/_source-audits/` rather than repeating discovery (CTO directive Part 0, binding). If new source material surfaces later that isn't covered by the three completed audits, it gets its own new audit — the "do not re-audit" rule applies specifically to the three repositories already covered, not to all future discovery generally.
