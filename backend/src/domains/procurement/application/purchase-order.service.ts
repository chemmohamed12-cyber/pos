import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { PurchaseOrder } from '../infrastructure/purchase-order.entity';
import { PurchaseOrderLine } from '../infrastructure/purchase-order-line.entity';
import { Supplier } from '../infrastructure/supplier.entity';
import { PURCHASE_ORDER_PROCESS } from '../domain/purchase-order-process';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ProcessInstance } from '../../../foundation/process-engine/process-instance.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProductLifecycleGate } from './product-lifecycle-gate.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { INVENTORY_RESERVATION_CONTRACT, InventoryReservationContract } from '../../../foundation/module-registry/contracts/inventory.contract';

const PO_DOCUMENT_TYPE = 'purchase_order';
const PO_ENTITY_TYPE = 'purchase_order';

export interface CreatePurchaseOrderLineInput {
  productId: string;
  quantity: string;
  unitCostBase: string;
}
export interface CreatePurchaseOrderInput {
  supplierId: string;
  warehouseId: string;
  notes?: string | null;
  lines: CreatePurchaseOrderLineInput[];
  /** ADR-048 Path B — set only by `RfqService`'s award flow; never client-settable (the controller DTO has no such field). */
  sourceRfqId?: string | null;
}

/**
 * ADR-048 — Purchase Order (the `purchasing` bounded context). No status
 * column on the entity itself (see `PurchaseOrder`'s doc comment); every
 * read that needs the current state resolves it from the Process Engine.
 */
@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly lifecycleGate: ProductLifecycleGate,
    @Inject(INVENTORY_RESERVATION_CONTRACT) private readonly warehouses: Pick<InventoryReservationContract, 'getWarehouse'>,
  ) {}

  private async statesFor(ids: string[], manager?: EntityManager): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await (manager ?? this.dataSource)
      .getRepository(ProcessInstance)
      .find({ where: { definitionKey: PURCHASE_ORDER_PROCESS.key, entityType: PO_ENTITY_TYPE, entityId: In(ids) } });
    return new Map(rows.map((r) => [r.entityId, r.currentState]));
  }

  async list(manager?: EntityManager, visibleWarehouseIds?: string[]): Promise<Array<PurchaseOrder & { state: string }>> {
    const pos = await (manager ?? this.dataSource).getRepository(PurchaseOrder).find({ where: visibleWarehouseIds ? { warehouseId: In(visibleWarehouseIds) } : undefined, order: { createdAt: 'DESC' } });
    const states = await this.statesFor(pos.map((p) => p.id), manager);
    return pos.map((p) => ({ ...p, state: states.get(p.id) ?? 'draft' }));
  }

  async getById(id: string, manager?: EntityManager): Promise<{ purchaseOrder: PurchaseOrder; state: string; lines: PurchaseOrderLine[] }> {
    const purchaseOrder = await (manager ?? this.dataSource).getRepository(PurchaseOrder).findOne({ where: { id } });
    if (!purchaseOrder) throw new NotFoundException(`Purchase Order "${id}" not found.`);
    const lines = await (manager ?? this.dataSource).getRepository(PurchaseOrderLine).find({ where: { purchaseOrderId: id } });
    const state = await this.processEngine.getState(PURCHASE_ORDER_PROCESS, PO_ENTITY_TYPE, id, manager);
    return { purchaseOrder, state, lines };
  }

  async create(input: CreatePurchaseOrderInput, actorUserId: string, externalManager?: EntityManager): Promise<PurchaseOrder> {
    if (input.lines.length === 0) throw new BadRequestException('A Purchase Order needs at least one line.');
    const supplier = await (externalManager ?? this.dataSource).getRepository(Supplier).findOne({ where: { id: input.supplierId } });
    if (!supplier) throw new NotFoundException(`Supplier "${input.supplierId}" not found.`);
    if (supplier.status !== 'active') throw new ConflictException(`Supplier "${supplier.legalName}" is inactive — cannot raise a Purchase Order against it.`);
    // `purchase_orders.warehouseId` has no FK — an unknown warehouse is rejected (404) before any mutation, same as an unknown supplier above.
    await this.warehouses.getWarehouse(input.warehouseId, externalManager);

    await this.lifecycleGate.assertNoneDraft(input.lines.map((l) => l.productId), 'Cannot create this Purchase Order', externalManager); // D7 gate (before any mutation)
    await this.numbering.registerDocumentType(PO_DOCUMENT_TYPE, 'PO', true, externalManager);

    const run = async (manager: EntityManager): Promise<PurchaseOrder> => {
      const poNumber = await this.numbering.getNextNumber(PO_DOCUMENT_TYPE, manager);
      const poRepo = manager.getRepository(PurchaseOrder);
      const lineRepo = manager.getRepository(PurchaseOrderLine);

      let totalAmountBase = 0;
      const lineEntities = input.lines.map((l) => {
        const qty = Number(l.quantity);
        const cost = Number(l.unitCostBase);
        if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('Every line quantity must be a positive number.');
        if (!Number.isFinite(cost) || cost < 0) throw new BadRequestException('Every line unit cost must be a non-negative number.');
        const lineTotal = qty * cost;
        totalAmountBase += lineTotal;
        return { productId: l.productId, quantity: l.quantity, unitCostBase: l.unitCostBase, lineTotalBase: lineTotal.toFixed(2) };
      });

      const saved = await poRepo.save(
        poRepo.create({
          poNumber,
          supplierId: input.supplierId,
          warehouseId: input.warehouseId,
          totalAmountBase: totalAmountBase.toFixed(2),
          notes: input.notes ?? null,
          sourceRfqId: input.sourceRfqId ?? null,
          createdByUserId: actorUserId,
        }),
      );
      await lineRepo.save(lineEntities.map((l) => lineRepo.create({ ...l, purchaseOrderId: saved.id })));
      await this.processEngine.start(PURCHASE_ORDER_PROCESS, PO_ENTITY_TYPE, saved.id, manager);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'purchase_order.created',
          resource: 'purchase_order',
          resourceId: saved.id,
          result: 'success',
          correlationId: saved.id,
          after: { poNumber, supplierId: input.supplierId, totalAmountBase: saved.totalAmountBase },
        },
        manager,
      );
      return saved;
    };

    // Join the caller's transaction only when one is actually active (RfqService's award flow); a Company-scoped
    // `dataSource.manager` (the controller path) is not a transaction, so open one on it.
    return externalManager?.queryRunner?.isTransactionActive ? run(externalManager) : (externalManager ?? this.dataSource).transaction(run);
  }

  async transition(
    id: string,
    action: 'submit' | 'approve' | 'reject' | 'cancel',
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ state: string }> {
    const exists = await (manager ?? this.dataSource).getRepository(PurchaseOrder).findOne({ where: { id } });
    if (!exists) throw new NotFoundException(`Purchase Order "${id}" not found.`);
    // ESC-3 (CTO, 2026-10-06, Option B) — maker != checker: the user who created the PO may not approve it. The approver must be another user who already
    // holds the existing approve permission (the permission model is unchanged). Checked BEFORE any state change. A PO with no recorded creator is not blocked.
    if (action === 'approve' && exists.createdByUserId && exists.createdByUserId === actorUserId) {
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'purchase_order.approve', resource: 'purchase_order', resourceId: id, result: 'failure', correlationId: id, after: { reason: 'maker_cannot_approve_own_order' } },
        manager,
      );
      throw new ForbiddenException('Maker/checker: the user who created this Purchase Order cannot approve it. Another authorized user must approve it.');
    }
    const instance = await this.processEngine.transition(PURCHASE_ORDER_PROCESS, PO_ENTITY_TYPE, id, action, actorUserId, manager);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: `purchase_order.${action}`,
        resource: 'purchase_order',
        resourceId: id,
        result: 'success',
        correlationId: id,
        after: { state: instance.currentState },
      },
      manager,
    );
    return { state: instance.currentState };
  }
}
