import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { BillOfMaterial, BomStatus } from '../infrastructure/bill-of-materials.entity';
import { Product } from '../infrastructure/product.entity';
import { BomComponent } from '../infrastructure/bom-component.entity';
import { ProductsService } from './products.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { SalesBomContract } from '../../../foundation/module-registry/contracts/sales.contract';

export interface BomComponentInput {
  componentProductId: string;
  quantityPerUnit: number;
}

export interface BomComponentView extends BomComponentInput {
  sku: string;
  productName: string;
  /** Component Product's existing free-text `unit` label — display only. */
  unit: string | null;
}

export interface BomView {
  id: string;
  finishedProductId: string;
  finishedProductSku: string;
  finishedProductName: string;
  status: BomStatus;
  components: BomComponentView[];
}

export interface BomListEntry {
  finishedProductId: string;
  sku: string;
  name: string;
  status: BomStatus;
  componentCount: number;
}

/**
 * Commerce / Bill of Materials — Gap G-2
 * (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §3B/§4/§21;
 * CTO handover directive §15). Defines WHAT a finished product is built
 * from; `InventoryService.assembleProduct` (Inventory/Warehouse domain)
 * consumes `getBomForAssembly` — the one cross-domain read contract, same
 * pattern as `ProductsService.getProductSnapshot` — to perform the
 * actual stock movements. This service never touches `stock_movements`.
 *
 * Deliberately flat/V1: one BOM per finished product (no versioning, no
 * effective-date ranges, no alternate/optional components, no nested/
 * multi-level BOM resolution — a component that is itself a finished
 * product with its own BOM is not recursively expanded). Not a
 * full MRP/manufacturing ERP (CTO handover directive §15).
 */
@Injectable()
export class BomService implements SalesBomContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly products: ProductsService,
  ) {}

  /**
   * Create-or-replace: a BOM is edited as a whole recipe, not
   * incrementally per-line (matches how the real business's own
   * "تجميع صاله الانتاج" event is a single conceptual bill, per the
   * mapping package) — deletes any existing component rows and inserts
   * the new set, transactionally, so a caller never observes a
   * half-updated recipe.
   */
  async defineBom(
    finishedProductId: string,
    components: BomComponentInput[],
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<BillOfMaterial> {
    if (components.length === 0) {
      throw new BadRequestException('A Bill of Materials must have at least one component.');
    }

    const finishedProduct = await this.products.getProductSnapshot(finishedProductId, manager);
    if (!finishedProduct) throw new NotFoundException(`Product "${finishedProductId}" not found.`);

    const seen = new Set<string>();
    for (const c of components) {
      if (c.componentProductId === finishedProductId) {
        throw new BadRequestException('A product cannot be a component of its own Bill of Materials.');
      }
      if (seen.has(c.componentProductId)) {
        throw new BadRequestException(`Component "${c.componentProductId}" is listed more than once.`);
      }
      seen.add(c.componentProductId);
      if (!Number.isInteger(c.quantityPerUnit) || c.quantityPerUnit < 1) {
        throw new BadRequestException(`Quantity per unit for component "${c.componentProductId}" must be a positive whole number.`);
      }
      const componentProduct = await this.products.getProductSnapshot(c.componentProductId, manager);
      if (!componentProduct) throw new NotFoundException(`Component product "${c.componentProductId}" not found.`);
    }

    const bom = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const bomRepo = txManager.getRepository(BillOfMaterial);
      const componentRepo = txManager.getRepository(BomComponent);

      let record = await bomRepo.findOne({ where: { finishedProductId } });
      if (!record) {
        record = await bomRepo.save(bomRepo.create({ finishedProductId }));
      } else {
        await componentRepo.delete({ billOfMaterialId: record.id });
        // touch updatedAt
        record = await bomRepo.save({ ...record });
      }

      await componentRepo.save(
        components.map((c) =>
          componentRepo.create({ billOfMaterialId: record!.id, componentProductId: c.componentProductId, quantityPerUnit: c.quantityPerUnit }),
        ),
      );

      return record;
    });

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.bom.defined',
        resource: 'bill_of_materials',
        resourceId: bom.id,
        result: 'success',
        correlationId: null,
        after: { finishedProductId, components },
      },
      manager,
    );

    return bom;
  }

  async getBom(finishedProductId: string, manager?: EntityManager): Promise<BomView | null> {
    const m = manager ?? this.dataSource;
    const bom = await m.getRepository(BillOfMaterial).findOne({ where: { finishedProductId } });
    if (!bom) return null;
    const finishedProduct = await this.products.getProductSnapshot(finishedProductId, manager);
    const rows = await m.getRepository(BomComponent).find({ where: { billOfMaterialId: bom.id } });
    const productRows = rows.length ? await m.getRepository(Product).find({ where: { id: In(rows.map((r) => r.componentProductId)) } }) : [];
    const byId = new Map(productRows.map((p) => [p.id, p]));

    const components: BomComponentView[] = rows.map((row) => {
      const product = byId.get(row.componentProductId);
      return {
        componentProductId: row.componentProductId,
        quantityPerUnit: row.quantityPerUnit,
        sku: product?.sku ?? row.componentProductId,
        productName: product?.name ?? row.componentProductId,
        unit: product?.unit ?? null,
      };
    });

    return {
      id: bom.id,
      finishedProductId,
      finishedProductSku: finishedProduct?.sku ?? finishedProductId,
      finishedProductName: finishedProduct?.name ?? finishedProductId,
      status: bom.status,
      components,
    };
  }

  /** Backs the BOM management screens' list — every finished product that currently has a defined recipe (batched lookups, no N+1). */
  async listBoms(manager?: EntityManager): Promise<BomListEntry[]> {
    const m = manager ?? this.dataSource;
    const boms = await m.getRepository(BillOfMaterial).find();
    if (boms.length === 0) return [];
    const products = await m.getRepository(Product).find({ where: { id: In(boms.map((b) => b.finishedProductId)) } });
    const byId = new Map(products.map((p) => [p.id, p]));
    const counts: Array<{ id: string; n: string }> = await m
      .getRepository(BomComponent)
      .createQueryBuilder('c')
      .select('c.billOfMaterialId', 'id')
      .addSelect('COUNT(*)', 'n')
      .groupBy('c.billOfMaterialId')
      .getRawMany();
    const countById = new Map(counts.map((c) => [c.id, Number(c.n)]));
    return boms.map((bom) => ({
      finishedProductId: bom.finishedProductId,
      sku: byId.get(bom.finishedProductId)?.sku ?? bom.finishedProductId,
      name: byId.get(bom.finishedProductId)?.name ?? bom.finishedProductId,
      status: bom.status,
      componentCount: countById.get(bom.id) ?? 0,
    }));
  }

  /** ADR-061 Addendum 1 (A2) — BOM lifecycle: `inactive` BOMs cannot seed new Work Orders / assemblies; no versioning is introduced. */
  async setBomStatus(finishedProductId: string, status: BomStatus, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    if (status !== 'active' && status !== 'inactive') throw new BadRequestException('BOM status must be "active" or "inactive".');
    const repo = (manager ?? this.dataSource).getRepository(BillOfMaterial);
    const bom = await repo.findOne({ where: { finishedProductId } });
    if (!bom) throw new NotFoundException(`No Bill of Materials defined for product "${finishedProductId}".`);
    if (bom.status === status) return;
    const before = bom.status;
    bom.status = status;
    await repo.save(bom);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.bom.status_changed',
        resource: 'bill_of_materials',
        resourceId: bom.id,
        result: 'success',
        correlationId: null,
        before: { status: before },
        after: { finishedProductId, status },
      },
      manager,
    );
  }

  async deleteBom(finishedProductId: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? this.dataSource).getRepository(BillOfMaterial);
    const bom = await repo.findOne({ where: { finishedProductId } });
    if (!bom) throw new NotFoundException(`No Bill of Materials defined for product "${finishedProductId}".`);
    await repo.remove(bom); // cascades bom_components (ON DELETE CASCADE)

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.bom.deleted',
        resource: 'bill_of_materials',
        resourceId: bom.id,
        result: 'success',
        correlationId: null,
        before: { finishedProductId },
      },
      manager,
    );
  }

  /**
   * Cross-domain read contract for Inventory/Warehouse
   * (DAII_DOMAIN_BOUNDARIES.md Cross-Domain Rule) — same pattern as
   * `ProductsService.getProductSnapshot`. Returns null (never throws)
   * when no BOM is defined, so `InventoryService.assembleProduct` can
   * turn that straight into a clear "no recipe defined" business error
   * without a try/catch.
   */
  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added — `BillOfMaterial`/`BomComponent` are Company-owned, called from `InventoryService.assembleProduct`. */
  async getBomForAssembly(finishedProductId: string, manager?: EntityManager): Promise<BomComponentInput[] | null> {
    const bom = await (manager ?? this.dataSource).getRepository(BillOfMaterial).findOne({ where: { finishedProductId } });
    if (!bom || bom.status !== 'active') return null; // ADR-061 Addendum 1 (A2): an inactive BOM is "no usable recipe"
    const rows = await (manager ?? this.dataSource).getRepository(BomComponent).find({ where: { billOfMaterialId: bom.id } });
    return rows.map((r) => ({ componentProductId: r.componentProductId, quantityPerUnit: r.quantityPerUnit }));
  }
}
