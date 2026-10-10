# ADR-003 — Database / Persistence

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_DATA_ARCHITECTURE.md`

## Context

All three source repositories persist to flat JSON files. Both `baseline` (numbering-counter desync defect, TD-29) and `xnexus-website` (Offer-Accept atomicity, self-documented as contingent on synchronous file I/O) have concurrency-safety guarantees that would silently break under concurrent access without a redesign. Daii's blueprint (§17, §21) requires true multi-warehouse, multi-user concurrent writes.

## Decision

Daii uses **PostgreSQL** as its primary transactional datastore from day one. No JSON-file persistence model is carried forward into production. Object storage (S3-compatible) is used for media/attachments, metadata only in Postgres. A durable job queue (not in-memory) backs Background Processing.

## Consequences

- Every extracted engine/repository's persistence layer is rebuilt, not ported — this is accounted for in every extraction matrix row's "Concurrency Review" column.
- Numbering is issued transactionally with entity creation (closes TD-29's defect class).
- Stock reservation, Offer-Accept, and order-approval races are handled via row-level locks or optimistic concurrency (version columns), not file-system atomicity.
- No down-migration reliance in production; roll forward with corrective migrations.
