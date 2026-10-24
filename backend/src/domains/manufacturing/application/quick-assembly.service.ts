import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { WorkOrderService } from './work-order.service';

/**
 * Manufacturing Engine S6 (decision D-ME-5) - quick assembly is NOT a second engine. One call creates, releases, issues every component, receives the output and completes a
 * real Work Order, all in ONE transaction: the production floor gets the instant "assemble N" gesture, while the books, the stock, the cost pool and the audit trail are exactly
 * those of a Work Order (an order number, an events trail, WIP that returns to zero). Any failure rolls the whole thing back - nothing half-assembled is left behind.
 */
@Injectable()
export class QuickAssemblyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly workOrders: WorkOrderService,
  ) {}

  async quickAssemble(warehouseId: string, finishedProductId: string, quantity: number, actorUserId: string | null, manager?: EntityManager): Promise<{ workOrderId: string; workOrderNumber: string }> {
    const result = await (manager ?? this.dataSource).transaction(async (tx) => {
      const order = await this.workOrders.createWorkOrder(finishedProductId, quantity, warehouseId, actorUserId, tx);
      await this.workOrders.release(order.id, actorUserId, tx);
      for (const c of await this.workOrders.getWorkOrderComponents(order.id, tx)) {
        await this.workOrders.materialIssue(order.id, c.componentProductId, c.quantityRequired, actorUserId, `qa-${order.id}-${c.componentProductId}`, tx);
      }
      await this.workOrders.finishedGoodsOutput(order.id, quantity, actorUserId, `qa-out-${order.id}`, tx);
      await this.workOrders.complete(order.id, actorUserId, tx);
      return { workOrderId: order.id, workOrderNumber: order.workOrderNumber };
    });
    return result;
  }
}
