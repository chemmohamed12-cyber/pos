# Ownership attestations received (WP-0.4)

**Rule:** an attestation establishes ownership only — it does not assert correctness, verification or approval. **Attribution is frozen:** no file was reclassified; attested files stay `UNATTRIBUTED` in the manifests and OUT of the execution baseline until the CTO rules otherwise.

## From session "Multi-Company front" (local_0f4192f6…), reply on 2026-10-05
Reason it left no Write/Edit evidence: it applies most edits through node/python scripts, not the Edit tool.

### High confidence (32 files; authored in its D1/D3-B/D4/D5/D7/D8 stages; named in its edit scripts and decision records)
- `backend/src/database/migrations/core/1789920000000-SeedSupplierInvoiceVatTerminology.ts`
- `backend/src/database/migrations/core/1789950000000-SeedWarehouseItemAssignmentTerminology.ts`
- `backend/src/database/migrations/core/1789960000000-SeedFixedAssetAcquisitionLinkTerminology.ts`
- `backend/src/database/migrations/inventory/1789940000000-CreateWarehouseItems.ts`
- `backend/src/domains/accounting/application/fixed-asset.service.ts`
- `backend/src/domains/accounting/interface/fixed-asset.controller.ts`
- `backend/src/domains/commerce/application/products.service.ts`
- `backend/src/domains/inventory-warehouse/application/warehouse-transactions.service.ts`
- `backend/src/domains/inventory-warehouse/infrastructure/warehouse-item.entity.ts`
- `backend/src/domains/inventory-warehouse/infrastructure/warehouse-transaction-line.entity.ts`
- `backend/src/domains/inventory-warehouse/infrastructure/warehouse-transaction.entity.ts`
- `backend/src/domains/inventory-warehouse/interface/inventory.company-isolation.spec.ts`
- `backend/src/domains/inventory-warehouse/interface/inventory.controller.ts`
- `backend/src/domains/inventory-warehouse/interface/warehouse-transactions.company-isolation.spec.ts`
- `backend/src/domains/inventory-warehouse/interface/warehouse-transactions.controller.ts`
- `backend/src/domains/inventory-warehouse/inventory-warehouse-company-entities.ts`
- `backend/src/domains/inventory-warehouse/inventory-warehouse.module.ts`
- `backend/src/domains/procurement/interface/goods-receipt.company-isolation.spec.ts`
- `backend/src/domains/procurement/interface/purchase-order.company-isolation.spec.ts`
- `backend/src/domains/procurement/interface/purchase-request.company-isolation.spec.ts`
- `backend/src/domains/procurement/procurement-company-entities.ts`
- `backend/src/domains/returns/application/sales-returns.service.ts`
- `backend/src/domains/returns/infrastructure/sales-return-line.entity.ts`
- `backend/src/domains/returns/infrastructure/sales-return.entity.ts`
- `backend/src/domains/returns/infrastructure/shipment-return-line.entity.ts`
- `backend/src/domains/returns/infrastructure/shipment-return.entity.ts`
- `backend/src/domains/returns/interface/sales-returns.company-isolation.spec.ts`
- `backend/src/domains/returns/interface/shipment-returns.company-isolation.spec.ts`
- `backend/src/domains/returns/returns.module.ts`
- `backend/src/foundation/module-registry/contracts/ar-events.contract.ts`
- `backend/src/foundation/module-registry/contracts/inventory.contract.ts`
- `backend/src/foundation/module-registry/contracts/sales.contract.ts`

### Medium confidence (8 files; D10/D2 era 2026-10-04; it states it cannot re-verify each one now; withdrawn for any file shown to be written by another lane)
- `backend/src/domains/accounting/interface/event-engine.company-isolation.spec.ts`
- `backend/src/domains/customer-finance/application/payments.service.ts`
- `backend/src/domains/customer-finance/interface/payments.controller.ts`
- `backend/src/domains/delivery/application/delivery.service.ts`
- `backend/src/domains/deposit-control/application/deposits.service.ts`
- `backend/src/domains/fulfillment/application/fulfillment.service.ts`
- `backend/src/domains/treasury/interface/treasury.company-isolation.spec.ts`
- `backend/src/foundation/module-registry/manifests/logistics.manifest.ts`

**DISCLAIM:** none.

## From "DAII HR (fork)" and continuation 82ce681b…
**Received 2026-10-06: all 41 files ATTESTED as DAII HR (fork)'s changes; none disclaimed.** Ownership only, no claim of correctness. No Write/Edit evidence exists because the changes were made with scripted commands (node transformer scripts, sed, `node /tmp/addmod.js`); mtimes match those commands to the second (per the sender).
Groups: Area 21 retrofit (accounting adjustment/reconciliation/tax/depreciation services, ap.controller, customer-finance, returns, sales, hr entities, approval-engine service/module/controller, authorization.service, tax-engine.contract); ADR-073 extension (`company-authorization-schema-adjustment.ts` + appended addendum in the ADR-073 doc); generated `MODULE_ENFORCEMENT_COVERAGE.md`; Plans/package enforcement (Plans migration, `plan.entity.ts`, `entitlement-resolver.token.ts`, `entitlement.controller.ts`, navigation controller/service); guard-line-only additions to `customer-ledger`, `fulfillment`, `sales-orders` controllers.
**Caveat from the sender (recorded as stated):** attestation covers the sender's changes only, not whole-file authorship. Shared, with earlier uncommitted work by other sessions: `accounting-company-entities.ts`, `gl-account.service.ts`, `authorization.service.ts`, `invoices.service.ts`, `company-authorization-schema-adjustment.ts`, the ADR-073 doc body. These stay FOREIGN / NEEDS RE-PROOF.
**Sender pointers for the re-proof lane (their evidence, not verified here):** `docs/acceptance/AREA21_CLOSURE_2026-10-05.md`, Matrix §57.
**Sender note:** `domains/procurement/interface/rfq-award-visibility.company-isolation.spec.ts` is untracked and not theirs; it expects an `awardApproval` field on `RfqService.getById` that does not exist (compile error in that spec only).

## From this lane (Multi-Company back21)
This lane's own records (command history / scripts) support ownership of: 6 Area 21 documents under `docs/decisions/area21/` (GL ratification package, patch, snapshots), `domains/accounting/application/ledger.service.ts` (§43) and `domains/returns/returns-company-entities.ts` (§45). **Not reclassified (freeze); recorded here for the CTO.** This lane disclaims `accounting/interface/event-engine.company-isolation.spec.ts` and the three `approval-engine` files (named by this lane's commands only as read/diff targets).

## Status (2026-10-06)
Attestations: **COMPLETE** — all 98 unattributed files now have an owner attestation and no file is disputed.
- Multi-Company front: 40 (earlier) + 1 (RFQ seed migration) = 41
- DAII HR (fork): 41 (earlier) + 8 = 49
- This lane: 8 (6 `area21/*` documents, `ledger.service.ts`, `returns-company-entities.ts`), from its own command history and Matrix §43/§45; recorded, not reclassified
- Disclaimed with no competing claim: none left
Attestation proves ownership only, not correctness or approval. Attribution is frozen: no status in the pinned baseline was changed. All 98 stay excluded from the Execution Baseline (UNATTRIBUTED, or FOREIGN / NEEDS RE-PROOF where the sender stated shared content: `accounting-company-entities.ts`, `gl-account.service.ts`, `authorization.service.ts`, `invoices.service.ts`, `company-authorization-schema-adjustment.ts`, the ADR-073 doc body, `company-entity-registry.ts`) pending a CTO ruling and re-proof.
