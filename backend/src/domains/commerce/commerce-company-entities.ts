import { Product } from './infrastructure/product.entity';
import { PriceList } from './infrastructure/price-list.entity';
import { PriceListItem } from './infrastructure/price-list-item.entity';
import { BillOfMaterial } from './infrastructure/bill-of-materials.entity';
import { BomComponent } from './infrastructure/bom-component.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Commerce's own
 * Company-connection-capable entities — added 2026-09-27 (Area 21
 * Operational Company Scoping Retrofit) when `ProductsService.getProductSnapshot`/
 * `getProductSnapshotBySku` and `PriceListsService.resolvePrice`/
 * `getOverridePrice` became `manager?`-capable (needed by
 * `SalesOrdersService.createOrder`/`editDraftOrder`'s own retrofit).
 * `BillOfMaterial`/`BomComponent` added during `inventory.controller.ts`'s
 * own retrofit (same date) — `BomService.getBomForAssembly` became
 * `manager?`-capable there (needed by `InventoryService.assembleProduct`).
 * `bom.controller.ts` itself (Tier 2, not yet retrofitted) still uses its
 * OWN un-scoped methods for everything else on that controller.
 */
export const COMMERCE_COMPANY_ENTITIES = [Product, PriceList, PriceListItem, BillOfMaterial, BomComponent];
