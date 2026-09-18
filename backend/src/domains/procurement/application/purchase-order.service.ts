import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { PurchaseOrder } from '../infrastructure/purchase-order.entity';
import { PurchaseOrderLine } from '../infrastructure/purchase-order-line.entity';
import { Supplier } from '../infrastructure/supplier.entity';
import { PURCHASE_ORDER_PROCESS } from '../domain/purchase-order-process';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ProcessInstance } from '../../../foundation/process-engine/process-instance.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';

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
  ) {}

  private async statesFor(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.dataSource
      .getRepository(ProcessInstance)
      .find({ where: { definitionKey: PURCHASE_ORDER_PROCESS.key, entityType: PO_ENTITY_TYPE, entityId: In(ids) } });
    return new Map(rows.map((r) => [r.entityId, r.currentState]));
  }

  async list(): Promise<Array<PurchaseOrder & { state: string }>> {
    const pos = await this.dataSource.getRepository(PurchaseOrder).find({ order: { createdAt: 'DESC' } });
    const states = await this.statesFor(pos.map((p) => p.id));
    return pos.map((p) => ({ ...p, state: states.get(p.id) ?? 'draft' }));
  }

  async getById(id: string): Promise<{ purchaseOrder: PurchaseOrder; state: string; lines: PurchaseOrderLine[] }> {
    const purchaseOrder = await this.dataSource.getRepository(PurchaseOrder).findOne({ where: { id } });
    if (!purchaseOrder) throw new NotFoundException(`Purchase Order "${id}" not found.`);
    const lines = await this.dataSource.getRepository(PurchaseOrderLine).find({ where: { purchaseOrderId: id } });
    const state = await this.processEngine.getState(PURCHASE_ORDER_PROCESS, PO_ENTITY_TYPE, id);
    return { purchaseOrder, state, lines };
  }

  async create(input: CreatePurchaseOrderInput, actorUserId: string, externalManager?: EntityManager): Promise<PurchaseOrder> {
    if (input.lines.length === 0) throw new BadRequestException('A Purchase Order needs at least one line.');
    const supplier = await this.dataSource.getRepository(Supplier).findOne({ where: { id: input.supplierId } });
    if (!supplier) throw new NotFoundException(`Supplier "${input.supplierId}" not found.`);
    if (supplier.status !== 'active') throw new ConflictException(`Supplier "${supplier.legalName}" is inactive — cannot raise a Purchase Order against it.`);

    await this.numbering.registerDocumentType(PO_DOCUMENT_TYPE, 'PO');

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

    return externalManager ? run(externalManager) : this.dataSource.transaction(run);
  }

  async transition(id: string, action: 'submit' | 'approve' | 'reject' | 'cancel', actorUserId: string): Promise<{ state: string }> {
    const exists = await this.dataSource.getRepository(PurchaseOrder).findOne({ where: { id } });
    if (!exists) throw new NotFoundException(`Purchase Order "${id}" not found.`);
    const instance = await this.processEngine.transition(PURCHASE_ORDER_PROCESS, PO_ENTITY_TYPE, id, action, actorUserId);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: `purchase_order.${action}`,
      resource: 'purchase_order',
      resourceId: id,
      result: 'success',
      correlationId: id,
      after: { state: instance.currentState },
    });
    return { state: instance.currentState };
  }
}
