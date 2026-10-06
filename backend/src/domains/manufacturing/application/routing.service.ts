import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { Routing, RoutingStatus } from '../infrastructure/routing.entity';
import { RoutingOperation } from '../infrastructure/routing-operation.entity';
import { WorkCenter } from '../infrastructure/work-center.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { SALES_PRODUCTS_CONTRACT, SalesProductsContract } from '../../../foundation/module-registry/contracts/sales.contract';

export interface RoutingOperationInput {
  sequence: number;
  name: string;
  description?: string | null;
  workCenterId: string;
}

export interface RoutingOperationView {
  id: string;
  sequence: number;
  name: string;
  description: string | null;
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  workCenterStatus: 'active' | 'inactive';
}

export interface RoutingView {
  id: string;
  finishedProductId: string;
  finishedProductSku: string;
  finishedProductName: string;
  status: RoutingStatus;
  operations: RoutingOperationView[];
}

export interface RoutingListEntry {
  finishedProductId: string;
  sku: string;
  name: string;
  status: RoutingStatus;
  operationCount: number;
}

/**
 * ADR-061 Addendum 1 (A1) — Routing master data: one routing per finished product, an ordered
 * list of operations each assigned to a Work Center. Sequencing only — NO labor/machine hours,
 * rates, overhead or cost (ADR-060 D2/D3). Work Order `release` snapshots the active routing
 * (`getActiveOperationsForRelease`); it publishes nothing and posts nothing.
 */
@Injectable()
export class RoutingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    @Inject(SALES_PRODUCTS_CONTRACT) private readonly products: SalesProductsContract,
  ) {}

  async list(manager?: EntityManager): Promise<RoutingListEntry[]> {
    const m = manager ?? this.dataSource;
    const routings = await m.getRepository(Routing).find();
    const entries: RoutingListEntry[] = [];
    for (const r of routings) {
      const [product, operationCount] = await Promise.all([
        this.products.getProductSnapshot(r.finishedProductId, manager),
        m.getRepository(RoutingOperation).count({ where: { routingId: r.id } }),
      ]);
      entries.push({
        finishedProductId: r.finishedProductId,
        sku: product?.sku ?? r.finishedProductId,
        name: product?.name ?? r.finishedProductId,
        status: r.status,
        operationCount,
      });
    }
    return entries.sort((a, b) => a.sku.localeCompare(b.sku));
  }

  async get(finishedProductId: string, manager?: EntityManager): Promise<RoutingView | null> {
    const m = manager ?? this.dataSource;
    const routing = await m.getRepository(Routing).findOne({ where: { finishedProductId } });
    if (!routing) return null;
    const product = await this.products.getProductSnapshot(finishedProductId, manager);
    const operations = await this.loadOperations(routing.id, manager);
    return {
      id: routing.id,
      finishedProductId,
      finishedProductSku: product?.sku ?? finishedProductId,
      finishedProductName: product?.name ?? finishedProductId,
      status: routing.status,
      operations,
    };
  }

  /** Create-or-replace as a whole routing (same semantics as BOM), preserving its status. */
  async define(finishedProductId: string, operations: RoutingOperationInput[], actorUserId: string | null, manager?: EntityManager): Promise<Routing> {
    if (!operations || operations.length === 0) throw new BadRequestException('A routing must have at least one operation.');
    const product = await this.products.getProductSnapshot(finishedProductId, manager);
    if (!product) throw new NotFoundException(`Product "${finishedProductId}" not found.`);

    const seen = new Set<number>();
    for (const op of operations) {
      if (!Number.isInteger(op.sequence) || op.sequence < 1) throw new BadRequestException('Operation sequence must be a positive whole number.');
      if (seen.has(op.sequence)) throw new BadRequestException(`Operation sequence ${op.sequence} is used more than once.`);
      seen.add(op.sequence);
      if (!op.name || !op.name.trim()) throw new BadRequestException(`Operation ${op.sequence} needs a name.`);
    }
    const workCenterIds = [...new Set(operations.map((o) => o.workCenterId))];
    const centers = await (manager ?? this.dataSource).getRepository(WorkCenter).find({ where: { id: In(workCenterIds) } });
    const byId = new Map(centers.map((c) => [c.id, c]));
    for (const op of operations) {
      const wc = byId.get(op.workCenterId);
      if (!wc) throw new NotFoundException(`Work Center "${op.workCenterId}" (operation ${op.sequence}) not found.`);
      if (wc.status !== 'active') throw new ConflictException(`Work Center "${wc.code}" (operation ${op.sequence}) is inactive.`);
    }

    const saved = await (manager ?? this.dataSource).transaction(async (tx) => {
      const routingRepo = tx.getRepository(Routing);
      const opRepo = tx.getRepository(RoutingOperation);
      let routing = await routingRepo.findOne({ where: { finishedProductId } });
      if (!routing) {
        routing = await routingRepo.save(routingRepo.create({ finishedProductId, status: 'active', createdByUserId: actorUserId }));
      } else {
        await opRepo.delete({ routingId: routing.id });
        routing = await routingRepo.save({ ...routing });
      }
      await opRepo.save(
        [...operations]
          .sort((a, b) => a.sequence - b.sequence)
          .map((o) =>
            opRepo.create({ routingId: routing!.id, sequence: o.sequence, name: o.name.trim(), description: o.description?.trim() || null, workCenterId: o.workCenterId }),
          ),
      );
      return routing;
    });

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'manufacturing.routing.defined',
        resource: 'routing',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { finishedProductId, operations: operations.map((o) => ({ sequence: o.sequence, name: o.name, workCenterId: o.workCenterId })) },
      },
      manager,
    );
    return saved;
  }

  async setStatus(finishedProductId: string, status: RoutingStatus, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    if (status !== 'active' && status !== 'inactive') throw new BadRequestException('Routing status must be "active" or "inactive".');
    const repo = (manager ?? this.dataSource).getRepository(Routing);
    const routing = await repo.findOne({ where: { finishedProductId } });
    if (!routing) throw new NotFoundException(`No routing defined for product "${finishedProductId}".`);
    if (routing.status === status) return;
    const before = routing.status;
    routing.status = status;
    await repo.save(routing);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'manufacturing.routing.status_changed',
        resource: 'routing',
        resourceId: routing.id,
        result: 'success',
        correlationId: null,
        before: { status: before },
        after: { finishedProductId, status },
      },
      manager,
    );
  }

  /** Released Work Orders keep their own operation snapshot, so deleting a routing never affects them. */
  async remove(finishedProductId: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? this.dataSource).getRepository(Routing);
    const routing = await repo.findOne({ where: { finishedProductId } });
    if (!routing) throw new NotFoundException(`No routing defined for product "${finishedProductId}".`);
    await repo.remove(routing); // cascades routing_operations
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'manufacturing.routing.deleted', resource: 'routing', resourceId: routing.id, result: 'success', correlationId: null, before: { finishedProductId } },
      manager,
    );
  }

  /**
   * Work Order release hook: the finished product's ACTIVE routing, flattened with Work Center
   * identity (snapshot fields). `null` => no routing => the Work Order has no operations and behaves
   * exactly as the verified Phase 1 lifecycle. Throws if an operation points at an inactive Work
   * Center — the routing must be corrected first (called before any release side effect).
   */
  async getActiveOperationsForRelease(finishedProductId: string, manager?: EntityManager): Promise<RoutingOperationView[] | null> {
    const routing = await (manager ?? this.dataSource).getRepository(Routing).findOne({ where: { finishedProductId } });
    if (!routing || routing.status !== 'active') return null;
    const operations = await this.loadOperations(routing.id, manager);
    if (operations.length === 0) return null;
    const inactive = operations.find((o) => o.workCenterStatus !== 'active');
    if (inactive) {
      throw new ConflictException(`Routing operation ${inactive.sequence} uses inactive Work Center "${inactive.workCenterCode}" — reactivate it or edit the routing before releasing.`);
    }
    return operations;
  }

  private async loadOperations(routingId: string, manager?: EntityManager): Promise<RoutingOperationView[]> {
    const m = manager ?? this.dataSource;
    const ops = await m.getRepository(RoutingOperation).find({ where: { routingId }, order: { sequence: 'ASC' } });
    const centers = ops.length ? await m.getRepository(WorkCenter).find({ where: { id: In([...new Set(ops.map((o) => o.workCenterId))]) } }) : [];
    const byId = new Map(centers.map((c) => [c.id, c]));
    return ops.map((o) => ({
      id: o.id,
      sequence: o.sequence,
      name: o.name,
      description: o.description,
      workCenterId: o.workCenterId,
      workCenterCode: byId.get(o.workCenterId)?.code ?? '?',
      workCenterName: byId.get(o.workCenterId)?.name ?? '?',
      workCenterStatus: byId.get(o.workCenterId)?.status ?? 'inactive',
    }));
  }
}
