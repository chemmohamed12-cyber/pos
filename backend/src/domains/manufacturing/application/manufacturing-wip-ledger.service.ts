import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ManufacturingWipContract, WipBalanceEntry } from '../../../foundation/module-registry/contracts/manufacturing-wip.contract';
import { INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';

/**
 * `MANUFACTURING_WIP_CONTRACT`'s real implementation — read-only, and
 * strictly a reconciliation-reporting surface: it introduces no new
 * costing, GL, or lifecycle behavior, and neither reads nor writes
 * anything `WorkOrderService`'s own already-verified methods don't already
 * expose. Mirrors `GrniLedgerService`'s role for Procurement exactly (same
 * "no dedicated ledger table — read straight from the existing source of
 * truth" shape): `work_orders.wipWarehouseId` is the one place a WIP
 * sub-warehouse's identity lives (ADR-061 §6); F08's own
 * `getValuedOnHandTotal` (already how `WorkOrderService.computeWipValue`
 * reads WIP value — see its doc comment) is the one place its current
 * value lives. This service only joins the two, exactly as the
 * independent Manufacturing review's Phase 1 finding required.
 */
@Injectable()
export class ManufacturingWipLedgerService implements ManufacturingWipContract {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(INVENTORY_VALUATION_CONTRACT) private readonly valuation: InventoryValuationContract,
  ) {}

  /** Multi-Company Area 9 (2026-09-22) — `manager?` added so a company-scoped caller (`ClosingSnapshotService`) can run this, AND the internal `valuation.getValuedOnHandTotal` call it depends on, against that Company's own connection instead of the ambient one. Falls back to the ambient `this.dataSource` when omitted, unchanged for every existing caller. */
  async getAllWipBalances(_asOfDate?: string, manager?: EntityManager): Promise<{ balances: WipBalanceEntry[]; total: string }> {
    const runner = manager ?? this.dataSource;
    const workOrders: Array<{ id: string; workOrderNumber: string; wipWarehouseId: string }> = await runner.query(
      `SELECT "id", "workOrderNumber", "wipWarehouseId" FROM "work_orders" WHERE "wipWarehouseId" IS NOT NULL ORDER BY "workOrderNumber"`,
    );
    if (workOrders.length === 0) return { balances: [], total: '0.0000' };

    const valued = await this.valuation.getValuedOnHandTotal(undefined, manager);
    const valueByWarehouse = new Map(valued.map((v) => [v.warehouseId, v.totalValueBase]));

    const balances: WipBalanceEntry[] = workOrders.map((wo) => ({
      workOrderId: wo.id,
      workOrderNumber: wo.workOrderNumber,
      wipWarehouseId: wo.wipWarehouseId,
      valueBase: valueByWarehouse.get(wo.wipWarehouseId) ?? '0.0000',
    }));
    const total = balances.reduce((sum, b) => sum + Number(b.valueBase), 0).toFixed(4);

    return { balances, total };
  }
}
