import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BillOfMaterial } from '../infrastructure/bill-of-materials.entity';
import { BomComponent } from '../infrastructure/bom-component.entity';
import { ProductsService } from './products.service';
import { AuditService } from '../../../foundation/audit/audit.service';

export interface BomComponentInput {
  componentProductId: string;
  quantityPerUnit: number;
}

export interface BomComponentView extends BomComponentInput {
  sku: string;
  productName: string;
}

export interface BomView {
  id: string;
  finishedProductId: string;
  finishedProductSku: string;
  finishedProductName: string;
  components: BomComponentView[];
}

export interface BomListEntry {
  finishedProductId: string;
  sku: string;
  name: string;
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
export class BomService {
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
  async defineBom(finishedProductId: string, components: BomComponentInput[], actorUserId: string | null): Promise<BillOfMaterial> {
    if (components.length === 0) {
      throw new BadRequestException('A Bill of Materials must have at least one component.');
    }

    const finishedProduct = await this.products.getProductSnapshot(finishedProductId);
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
      const componentProduct = await this.products.getProductSnapshot(c.componentProductId);
      if (!componentProduct) throw new NotFoundException(`Component product "${c.componentProductId}" not found.`);
    }

    const bom = await this.dataSource.transaction(async (manager) => {
      const bomRepo = manager.getRepository(BillOfMaterial);
      const componentRepo = manager.getRepository(BomComponent);

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

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'commerce.bom.defined',
      resource: 'bill_of_materials',
      resourceId: bom.id,
      result: 'success',
      correlationId: null,
      after: { finishedProductId, components },
    });

    return bom;
  }

  async getBom(finishedProductId: string): Promise<BomView | null> {
    const bom = await this.dataSource.getRepository(BillOfMaterial).findOne({ where: { finishedProductId } });
    if (!bom) return null;
    const finishedProduct = await this.products.getProductSnapshot(finishedProductId);
    const rows = await this.dataSource.getRepository(BomComponent).find({ where: { billOfMaterialId: bom.id } });

    const components: BomComponentView[] = [];
    for (const row of rows) {
      const product = await this.products.getProductSnapshot(row.componentProductId);
      components.push({
        componentProductId: row.componentProductId,
        quantityPerUnit: row.quantityPerUnit,
        sku: product?.sku ?? row.componentProductId,
        productName: product?.name ?? row.componentProductId,
      });
    }

    return {
      id: bom.id,
      finishedProductId,
      finishedProductSku: finishedProduct?.sku ?? finishedProductId,
      finishedProductName: finishedProduct?.name ?? finishedProductId,
      components,
    };
  }

  /** Backs the BOM management screen's list — every finished product that currently has a defined recipe. */
  async listBoms(): Promise<BomListEntry[]> {
    const boms = await this.dataSource.getRepository(BillOfMaterial).find();
    const entries: BomListEntry[] = [];
    for (const bom of boms) {
      const product = await this.products.getProductSnapshot(bom.finishedProductId);
      entries.push({
        finishedProductId: bom.finishedProductId,
        sku: product?.sku ?? bom.finishedProductId,
        name: product?.name ?? bom.finishedProductId,
      });
    }
    return entries;
  }

  async deleteBom(finishedProductId: string, actorUserId: string | null): Promise<void> {
    const bom = await this.dataSource.getRepository(BillOfMaterial).findOne({ where: { finishedProductId } });
    if (!bom) throw new NotFoundException(`No Bill of Materials defined for product "${finishedProductId}".`);
    await this.dataSource.getRepository(BillOfMaterial).remove(bom); // cascades bom_components (ON DELETE CASCADE)

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'commerce.bom.deleted',
      resource: 'bill_of_materials',
      resourceId: bom.id,
      result: 'success',
      correlationId: null,
      before: { finishedProductId },
    });
  }

  /**
   * Cross-domain read contract for Inventory/Warehouse
   * (DAII_DOMAIN_BOUNDARIES.md Cross-Domain Rule) — same pattern as
   * `ProductsService.getProductSnapshot`. Returns null (never throws)
   * when no BOM is defined, so `InventoryService.assembleProduct` can
   * turn that straight into a clear "no recipe defined" business error
   * without a try/catch.
   */
  async getBomForAssembly(finishedProductId: string): Promise<BomComponentInput[] | null> {
    const bom = await this.dataSource.getRepository(BillOfMaterial).findOne({ where: { finishedProductId } });
    if (!bom) return null;
    const rows = await this.dataSource.getRepository(BomComponent).find({ where: { billOfMaterialId: bom.id } });
    return rows.map((r) => ({ componentProductId: r.componentProductId, quantityPerUnit: r.quantityPerUnit }));
  }
}
