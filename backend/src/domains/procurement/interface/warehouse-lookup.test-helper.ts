import type { DataSource } from 'typeorm';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';

/**
 * Test wiring for the procurement services' warehouse-existence check. Production resolves `INVENTORY_RESERVATION_CONTRACT` through DI
 * (`useExisting: InventoryService`); specs that construct the procurement services by hand get the REAL `InventoryService.getWarehouse`
 * (a `findOne` on the manager it is handed, 404 when absent) — only its unused collaborators are inert, so the check is never stubbed away.
 */
export function makeWarehouseLookup(fallback: DataSource): InventoryService {
  const inert = {} as never;
  return new InventoryService(fallback, inert, inert, inert, inert, inert);
}
