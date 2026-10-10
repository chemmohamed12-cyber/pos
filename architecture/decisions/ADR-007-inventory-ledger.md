# ADR-007 — Inventory Ledger

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_DOMAIN_BOUNDARIES.md` §6, extraction matrix (Baseline: Inventory Ledger Engine)

## Context

`baseline/server/engines/inventory-ledger-engine.js` is a movement-based, `inventoryType`-partitioned stock ledger where stock is always derived from movements, never stored as a mutable quantity — matching blueprint §17–18 almost exactly. It lacks a warehouse/location dimension and Daii's richer stock-state vocabulary.

## Decision

Daii adopts the ledger-core design (Class B — reuse the math, `getStockLevel`/`getStockSummary` shape) and extends it with: (1) a warehouse/location dimension, (2) the full stock-state model from blueprint §19 (On Hand, Reserved, Available, Allocated, Picked, Packed, In Transit, Delivered, Returned) rather than the source's simpler receipt/consumption/transfer/adjustment set. Persistence moves to Postgres with row-level locking or conditional-UPDATE concurrency control (ADR-003).

## Consequences

- The ledger's *consumers* in `baseline` (`finished-goods-warehouse-engine.js`, `raw-material-engine.js`) are explicitly NOT reused — both are manufacturing-coupled (Class D/E) — only the ledger core.
- Corrections are new reversing movements, never edits to existing records (blueprint §18, immutable operational history).
- Reservation/Allocation is modeled as explicit ledger states, not a separate ad hoc mechanism.
