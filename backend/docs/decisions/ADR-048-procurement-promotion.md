# ADR-048 — Promote `procurement` from Reserved to Built

**Status:** Accepted (CTO directive, 2026-09-17).
**Supersedes:** the "reserved, unbuilt-by-design" status `procurement` held under ADR-024 §2.1
(`backend/src/foundation/module-registry/module-manifest.type.ts`), the same mechanism used to
promote `hr` (ADR-029) and `accounting` (ADR-032) before they were built.

## Context

`procurement` has sat in `ReservedModuleCode` since ADR-024: a code the CI manifest validator
rejects if any manifest tries to declare it, reserved specifically so no one builds a Purchasing
module until the decision to do so is made explicitly. As of this ADR, **no Purchasing/Procurement
code exists anywhere in this repository** — no `Supplier` entity, no `PurchaseOrder`, no
`GoodsReceipt`, no `SupplierInvoice`, on either backend or frontend. The only adjacent code is:

- A placeholder `SUPPLIER_LEDGER_CONTRACT` (`backend/src/foundation/module-registry/contracts/ap-events.contract.ts`)
  — an `@Optional()` injection point in `AccountingModule`'s AP-adjustment/reconciliation services,
  unbound today, explicitly documented as "for the future OP-AP domain."
- A manual, human-entered AP-adjustment flow (`backend/src/domains/accounting/application/ap-adjustment.service.ts`)
  that lets Finance record supplier credit/debit notes against a free-text `supplierRef` — not a
  real Supplier master, not tied to any purchase document.
- A generic `receipt` `MovementType` on `StockMovement` (`backend/src/domains/inventory-warehouse`)
  used today only by the manual Warehouse Receipt transaction screen and by opening-stock Excel
  import — carries no PO/GR reference, no unit-cost field beyond what `InventoryService.recordMovement`'s
  optional `unitCostBase` parameter is explicitly handed by its caller.

## Decision

Promote `procurement` out of `ReservedModuleCode` into `ModuleCode`/`AuthoredModuleCode`, per direct
CTO instruction, to build a real, ERP-integrated Purchasing domain:

```
Supplier (master) → Purchase Order → Goods Receipt → Supplier Invoice/AP → 3-Way Match
  → Supplier Ledger → Supplier Payment (via the Treasury contract) → Treasury
```

integrated with the existing:
- `InventoryService.recordMovement` contract for the Goods-Receipt → Inventory bridge (never a raw
  warehouse-table write from Procurement),
- financial-event/outbox pattern (mirroring `InventoryCostingHandlerService`'s
  `inventory.movement.recorded` handler and `ap-adjustment.handler.ts`) for Supplier Finance →
  Accounting, rather than a direct cross-domain import,
- `TreasuryService` contract for Supplier Payment execution (mirroring how `PaymentsService` already
  calls `TreasuryService.cashIn` atomically for customer payments),
- the existing Moving-Average cost engine (`inventory-valuation`) for received-goods valuation —
  Procurement supplies `unitCostBase` per receipt line; no second costing method is introduced.

`procurement`'s `business_domains` will be `['procurement']` (a single new `backend/src/domains/procurement`
folder housing the three bounded contexts — supplier, purchasing, supplier-finance — as
sub-namespaces of one NestJS module tree, not three separate top-level domains, matching how
`accounting` already groups several sub-areas under one module).

## Consequences

- `RESERVED_MODULE_CODES` loses `procurement`; `V1_MODULE_CODES`/`ModuleCode` gains it. The CI
  manifest validator will now accept (and require) a manifest for it.
- A new `procurement`-tagged migration partition is added (ADR-025 convention), alongside `core`,
  `sales`, `inventory`, `logistics`, `finance`, `hr`, `accounting`.
- `SUPPLIER_LEDGER_CONTRACT` gets its first real implementation, bound from the new Procurement
  module; `AccountingModule`'s AP-reconciliation service (`ap-reconciliation.service.ts`) activates
  its "supplier-ledger source present" path for the first time — this is a live behavior change to
  existing Accounting code, called out explicitly so it is verified, not assumed, during Procurement's
  E2E gate.
- The manual `ap-adjustment.service.ts` flow (free-text `supplierRef`) is NOT removed — it remains
  the correction/adjustment mechanism (credit notes, debit notes) layered on top of the real
  Supplier Ledger once one exists, consistent with its own documented purpose.
- **Foundation-gate audit result (2026-09-17), binding on Supplier/PO/GR/Invoice/Payment's V1 schema:**
  - *Legal Entity* — **does not exist**. The platform is explicitly single-installation/single-tenant
    by design (ADR-023 §1: "'Tenant' collapses to this singleton" — `installation.entity.ts:6`,
    `limit-profile.entity.ts:16`). Procurement does not invent a Legal Entity concept; there is
    exactly one.
  - *Currency* — real multi-currency machinery exists, but only at the GL core
    (`Currency`/`ExchangeRate` entities, `JournalEntry`/`JournalLine`'s per-line `exchangeRateUsed`).
    Every operational subledger that actually creates business documents (`SalesInvoice`, `Payment`,
    `TreasuryAccount`/`TreasuryTransaction`, every accounting adjustment service) hardcodes `'EGP'`
    and carries no currency column at all. Supplier/PO/GR/Invoice/Payment follow the same convention:
    **single-currency (EGP), no currency column, no exchange-rate conversion** in V1 — mirroring AP's
    natural sibling AR/Treasury exactly, not a new precedent.
  - *Exchange Rate* — exists (`accounting/infrastructure/exchange-rate.entity.ts`) but unused outside
    GL posting. Not needed by Procurement V1 given the currency decision above.
  - *Organization/Branch* — `OrgUnit`/`OrgMembership` exist; the reusable, already-proven convention
    for "which branch owns this record" is a **nullable `orgUnitId` column + a `ScopeDerivationRegistry`
    entry** (used today by `TreasuryAccount.orgUnitId` and `JournalEntry/JournalLine.orgUnitId`; `null`
    = unscoped = visible to everyone, today's behavior for every existing installation). `Warehouse`
    itself does **not** use this pattern yet, so it is optional, not mandatory, for V1 — but `Supplier`
    adopts it from day one (cheap, zero behavior change while unused) so multi-branch supplier scoping
    is a later additive step, not a future schema migration.
