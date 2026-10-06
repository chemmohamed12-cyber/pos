import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { WorkCenter, WorkCenterStatus } from '../infrastructure/work-center.entity';
import { RoutingOperation } from '../infrastructure/routing-operation.entity';
import { WorkOrderOperation } from '../infrastructure/work-order-operation.entity';
import { AuditService } from '../../../foundation/audit/audit.service';

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

export interface WorkCenterListEntry extends WorkCenter {
  routingOperationCount: number;
}

/**
 * ADR-061 Addendum 1 (A1) — Work Center master data: assignment/sequencing only. No capacity,
 * labor/machine hours, rates or overhead (ADR-060 D2/D3). Company-scoped via the optional
 * `manager` on every method (Area 21 convention).
 */
@Injectable()
export class WorkCenterService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async list(manager?: EntityManager): Promise<WorkCenterListEntry[]> {
    const m = manager ?? this.dataSource;
    const rows = await m.getRepository(WorkCenter).find({ order: { code: 'ASC' } });
    if (rows.length === 0) return [];
    const counts: Array<{ id: string; n: string }> = await m
      .getRepository(RoutingOperation)
      .createQueryBuilder('o')
      .select('o.workCenterId', 'id')
      .addSelect('COUNT(*)', 'n')
      .groupBy('o.workCenterId')
      .getRawMany();
    const byId = new Map(counts.map((c) => [c.id, Number(c.n)]));
    return rows.map((r) => Object.assign(r, { routingOperationCount: byId.get(r.id) ?? 0 }));
  }

  async getOrThrow(id: string, manager?: EntityManager): Promise<WorkCenter> {
    const row = await (manager ?? this.dataSource).getRepository(WorkCenter).findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Work Center "${id}" not found.`);
    return row;
  }

  async create(input: { code: string; name: string; description?: string | null }, actorUserId: string | null, manager?: EntityManager): Promise<WorkCenter> {
    const code = (input.code ?? '').trim().toUpperCase();
    const name = (input.name ?? '').trim();
    if (!CODE_PATTERN.test(code)) {
      throw new BadRequestException('Work Center code must be 1-32 characters: A-Z, 0-9, ".", "_" or "-" (starting with a letter or digit).');
    }
    if (!name) throw new BadRequestException('Work Center name is required.');
    const repo = (manager ?? this.dataSource).getRepository(WorkCenter);
    if (await repo.findOne({ where: { code } })) throw new ConflictException(`Work Center code "${code}" already exists.`);
    const saved = await repo.save(repo.create({ code, name, description: input.description?.trim() || null, status: 'active', createdByUserId: actorUserId }));
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'manufacturing.work_center.created', resource: 'work_center', resourceId: saved.id, result: 'success', correlationId: null, after: { code, name } },
      manager,
    );
    return saved;
  }

  async update(
    id: string,
    patch: { name?: string; description?: string | null; status?: WorkCenterStatus },
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<WorkCenter> {
    const repo = (manager ?? this.dataSource).getRepository(WorkCenter);
    const row = await this.getOrThrow(id, manager);
    const before = { name: row.name, description: row.description, status: row.status };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new BadRequestException('Work Center name is required.');
      row.name = name;
    }
    if (patch.description !== undefined) row.description = patch.description?.trim() || null;
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'inactive') throw new BadRequestException('Work Center status must be "active" or "inactive".');
      row.status = patch.status;
    }
    const saved = await repo.save(row);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'manufacturing.work_center.updated',
        resource: 'work_center',
        resourceId: id,
        result: 'success',
        correlationId: null,
        before,
        after: { name: saved.name, description: saved.description, status: saved.status },
      },
      manager,
    );
    return saved;
  }

  /** A Work Center referenced by any routing operation or Work Order operation snapshot cannot be deleted — deactivate it instead (data is never orphaned). */
  async remove(id: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    const m = manager ?? this.dataSource;
    const row = await this.getOrThrow(id, manager);
    const [routingRefs, woRefs] = await Promise.all([
      m.getRepository(RoutingOperation).count({ where: { workCenterId: id } }),
      m.getRepository(WorkOrderOperation).count({ where: { workCenterId: id } }),
    ]);
    if (routingRefs + woRefs > 0) {
      throw new ConflictException(
        `Work Center "${row.code}" is used by ${routingRefs} routing operation(s) and ${woRefs} Work Order operation(s) — deactivate it instead of deleting.`,
      );
    }
    await m.getRepository(WorkCenter).remove(row);
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'manufacturing.work_center.deleted', resource: 'work_center', resourceId: id, result: 'success', correlationId: null, before: { code: row.code, name: row.name } },
      manager,
    );
  }
}
