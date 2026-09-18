# ADR-010 — Geography Master

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** extraction matrix (QR Platform: Geography Engine + Egypt Master Data)

## Context

QR Platform's Geography Engine (Governorate→City/Markaz→District→Area, stable prefixed IDs sourced from official UN OCHA/HDX P-codes, GPS-to-nearest-node with confidence tiers) is a near-direct reuse candidate — same country as Daii, already follows blueprint §37's canonical-code discipline, built QR-domain-independent from the start.

## Decision

Daii adopts the geography hierarchy design and the Egypt master-data seed (27 Governorates, 365 City/Markaz, District/Area where available) directly (Class A/B). Persistence moves from JSON file to a Postgres table. Seed data is re-validated/re-downloaded from the primary HDX source rather than assumed current at extraction time.

## Consequences

- Never use a localized display name as a canonical identifier — stable opaque IDs only, consistent with blueprint §37.
- Used by Customer addresses (CRM), Warehouse locations (Warehouse), and Delivery-zone/Eligibility resolution (Shipment) — a genuine cross-domain Foundation/shared-reference-data capability, not owned by any single business domain.
- Ancestor-chain resolution (`resolveActive()` pattern) is adopted directly.
