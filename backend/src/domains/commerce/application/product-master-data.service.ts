import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Product } from '../infrastructure/product.entity';
import { ProductCategory, ProductCategoryStatus } from '../infrastructure/product-category.entity';
import { ProductBarcode } from '../infrastructure/product-barcode.entity';
import { isItemType, ItemType } from '../domain/item-type';
import { AuditService } from '../../../foundation/audit/audit.service';

const CATEGORY_CODE = /^[A-Za-z0-9._-]{1,32}$/;
/** Printable scanner payloads: EAN/UPC digits, Code128/Code39 alphanumerics, plus `-` `.` `/`. */
const BARCODE = /^[A-Za-z0-9./-]{4,64}$/;
const MAX_DESCRIPTION = 2000;
const MAX_REORDER_LEVEL = 1e12;

export interface ProductMasterDataInput {
  itemType?: string;
  /** `null` clears the category. */
  categoryId?: string | null;
  /** Numeric string in the base unit; `null` clears it. */
  reorderLevel?: string | null;
  /** `null` or '' clears it. */
  description?: string | null;
}

export interface ProductLookupResult {
  matchedBy: 'sku' | 'barcode';
  barcode: string | null;
  product: { id: string; sku: string; name: string; unit: string | null; unitPrice: string; status: string; itemType: ItemType };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof QueryFailedError && (err as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === '23505';
}

/**
 * Master data step 1 (approved 2026-10-15 — MASTER-DATA-AUDIT-AND-GAP-MATRIX-2026-10-15.md §1, §2, M1–M3; D-MD2, D-MD3, D-MD11).
 * Item categories, the additive item master fields and barcodes. Every write is validated server-side, runs in one transaction
 * and is audited; uniqueness is guaranteed by the database (a race that slips past the pre-check becomes a controlled 409).
 * The default warehouse is deliberately NOT here — the Inventory domain owns it (it must validate the warehouse and the D1
 * assignment) and writes it through `SalesProductsContract.setDefaultWarehouse`.
 */
@Injectable()
export class ProductMasterDataService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  private runner(manager?: EntityManager) {
    return manager ?? this.dataSource;
  }

  // ---- Categories -------------------------------------------------------------------------------------------------------

  async listCategories(manager?: EntityManager): Promise<ProductCategory[]> {
    return this.runner(manager).getRepository(ProductCategory).find({ order: { code: 'ASC' } });
  }

  async createCategory(input: { code: string; name: string; parentId?: string | null }, actorUserId: string, manager?: EntityManager): Promise<ProductCategory> {
    const code = (input.code ?? '').trim();
    const name = (input.name ?? '').trim();
    if (!CATEGORY_CODE.test(code)) throw new BadRequestException('Category code must be 1–32 characters: letters, digits, ".", "_" or "-".');
    if (name.length === 0 || name.length > 120) throw new BadRequestException('Category name is required (up to 120 characters).');
    const repo = this.runner(manager).getRepository(ProductCategory);
    if (await repo.findOne({ where: { code } })) throw new ConflictException(`Category code "${code}" already exists.`);
    if (input.parentId) await this.requireActiveCategory(input.parentId, manager, 'Parent category');
    try {
      const saved = await repo.save(repo.create({ code, name, parentId: input.parentId ?? null, status: 'active' }));
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'commerce.product_category.created', resource: 'product_category', resourceId: saved.id, result: 'success', correlationId: null, after: { code, name, parentId: saved.parentId } },
        manager,
      );
      return saved;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(`Category code "${code}" already exists.`);
      throw err;
    }
  }

  async updateCategory(id: string, input: { name?: string; parentId?: string | null }, actorUserId: string, manager?: EntityManager): Promise<ProductCategory> {
    const repo = this.runner(manager).getRepository(ProductCategory);
    const category = await repo.findOne({ where: { id } });
    if (!category) throw new NotFoundException(`Category "${id}" not found.`);
    const before = { name: category.name, parentId: category.parentId };
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0 || name.length > 120) throw new BadRequestException('Category name is required (up to 120 characters).');
      category.name = name;
    }
    if (input.parentId !== undefined) {
      if (input.parentId !== null) {
        await this.requireActiveCategory(input.parentId, manager, 'Parent category');
        // No cycles: the new parent may not be this category or one of its descendants.
        let cursor: string | null = input.parentId;
        for (let depth = 0; cursor && depth < 100; depth++) {
          if (cursor === id) throw new ConflictException('A category cannot be placed under itself or one of its own sub-categories.');
          cursor = (await repo.findOne({ where: { id: cursor } }))?.parentId ?? null;
        }
      }
      category.parentId = input.parentId;
    }
    const saved = await repo.save(category);
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'commerce.product_category.updated', resource: 'product_category', resourceId: id, result: 'success', correlationId: null, before, after: { name: saved.name, parentId: saved.parentId } },
      manager,
    );
    return saved;
  }

  async setCategoryStatus(id: string, status: ProductCategoryStatus, actorUserId: string, manager?: EntityManager): Promise<ProductCategory> {
    if (status !== 'active' && status !== 'inactive') throw new BadRequestException('Status must be active or inactive.');
    const repo = this.runner(manager).getRepository(ProductCategory);
    const category = await repo.findOne({ where: { id } });
    if (!category) throw new NotFoundException(`Category "${id}" not found.`);
    const before = { status: category.status };
    category.status = status;
    const saved = await repo.save(category);
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'commerce.product_category.status_changed', resource: 'product_category', resourceId: id, result: 'success', correlationId: null, before, after: { status } },
      manager,
    );
    return saved;
  }

  private async requireActiveCategory(id: string, manager: EntityManager | undefined, label: string): Promise<ProductCategory> {
    const category = await this.runner(manager).getRepository(ProductCategory).findOne({ where: { id } });
    if (!category) throw new NotFoundException(`${label} "${id}" not found.`);
    if (category.status !== 'active') throw new ConflictException(`${label} "${category.code} — ${category.name}" is inactive.`);
    return category;
  }

  // ---- Item master fields ---------------------------------------------------------------------------------------------

  /**
   * Updates only the fields present in `input` (absent = unchanged; `null` = cleared). A category must exist and be active to be
   * newly assigned; keeping an item on a category that was deactivated later is allowed (re-saving does not force a change).
   */
  async updateMasterData(productId: string, input: ProductMasterDataInput, actorUserId: string, manager?: EntityManager): Promise<Product> {
    const repo = this.runner(manager).getRepository(Product);
    const product = await repo.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    const before = { itemType: product.itemType, categoryId: product.categoryId, reorderLevel: product.reorderLevel, description: product.description };

    if (input.itemType !== undefined) {
      if (!isItemType(input.itemType)) throw new BadRequestException(`Unknown item type "${input.itemType}".`);
      product.itemType = input.itemType;
    }
    if (input.categoryId !== undefined) {
      if (input.categoryId !== null && input.categoryId !== product.categoryId) await this.requireActiveCategory(input.categoryId, manager, 'Category');
      product.categoryId = input.categoryId;
    }
    if (input.reorderLevel !== undefined) {
      if (input.reorderLevel === null || input.reorderLevel === '') {
        product.reorderLevel = null;
      } else {
        const value = Number(input.reorderLevel);
        if (!/^\d+(\.\d{1,3})?$/.test(String(input.reorderLevel).trim()) || !Number.isFinite(value) || value < 0 || value > MAX_REORDER_LEVEL) {
          throw new BadRequestException('Reorder level must be a non-negative number with at most 3 decimals.');
        }
        product.reorderLevel = String(input.reorderLevel).trim();
      }
    }
    if (input.description !== undefined) {
      const text = (input.description ?? '').trim();
      if (text.length > MAX_DESCRIPTION) throw new BadRequestException(`Description is limited to ${MAX_DESCRIPTION} characters.`);
      product.description = text.length ? text : null;
    }

    const saved = await repo.save(product);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.product.master_data_changed',
        resource: 'product',
        resourceId: productId,
        result: 'success',
        correlationId: null,
        before,
        after: { itemType: saved.itemType, categoryId: saved.categoryId, reorderLevel: saved.reorderLevel, description: saved.description },
      },
      manager,
    );
    return saved;
  }

  // ---- Barcodes -------------------------------------------------------------------------------------------------------

  async listBarcodes(productId: string, manager?: EntityManager): Promise<ProductBarcode[]> {
    await this.requireProduct(productId, manager);
    return this.runner(manager).getRepository(ProductBarcode).find({ where: { productId }, order: { isPrimary: 'DESC', createdAt: 'ASC' } });
  }

  /**
   * D-MD11 — unique per Company across all items, never equal to any SKU (the lookup resolves SKU-or-barcode). The first barcode of
   * an item becomes its primary; `isPrimary: true` moves the primary flag in the same transaction.
   */
  async addBarcode(productId: string, input: { barcode: string; packLabel?: string | null; isPrimary?: boolean }, actorUserId: string, manager?: EntityManager): Promise<ProductBarcode> {
    const barcode = (input.barcode ?? '').trim();
    if (!BARCODE.test(barcode)) throw new BadRequestException('Barcode must be 4–64 characters: letters, digits, ".", "/" or "-".');
    const packLabel = (input.packLabel ?? '').trim() || null;
    if (packLabel && packLabel.length > 64) throw new BadRequestException('Pack label is limited to 64 characters.');
    await this.requireProduct(productId, manager);
    const runner = this.runner(manager);
    const taken = await runner.getRepository(ProductBarcode).findOne({ where: { barcode } });
    if (taken) throw new ConflictException(`Barcode "${barcode}" is already assigned${taken.productId === productId ? ' to this item' : ' to another item'}.`);
    if (await runner.getRepository(Product).findOne({ where: { sku: barcode } })) throw new ConflictException(`"${barcode}" is an item code (SKU) and cannot be used as a barcode.`);

    const run = async (tx: EntityManager): Promise<ProductBarcode> => {
      const repo = tx.getRepository(ProductBarcode);
      const hasPrimary = (await repo.count({ where: { productId, isPrimary: true } })) > 0;
      const makePrimary = input.isPrimary === true || !hasPrimary;
      if (makePrimary && hasPrimary) await repo.update({ productId, isPrimary: true }, { isPrimary: false });
      const saved = await repo.save(repo.create({ productId, barcode, packLabel, isPrimary: makePrimary, createdByUserId: actorUserId }));
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'commerce.product_barcode.added', resource: 'product', resourceId: productId, result: 'success', correlationId: null, after: { barcode, packLabel, isPrimary: makePrimary } },
        tx,
      );
      return saved;
    };
    try {
      return manager?.queryRunner?.isTransactionActive ? await run(manager) : await runner.transaction(run);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(`Barcode "${barcode}" is already assigned.`);
      throw err;
    }
  }

  async removeBarcode(productId: string, barcodeId: string, actorUserId: string, manager?: EntityManager): Promise<{ removed: true }> {
    const repo = this.runner(manager).getRepository(ProductBarcode);
    const row = await repo.findOne({ where: { id: barcodeId, productId } });
    if (!row) throw new NotFoundException(`Barcode "${barcodeId}" not found on this item.`);
    await repo.delete({ id: barcodeId });
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'commerce.product_barcode.removed', resource: 'product', resourceId: productId, result: 'success', correlationId: null, before: { barcode: row.barcode, isPrimary: row.isPrimary } },
      manager,
    );
    return { removed: true };
  }

  /** SKU first (exact), then barcode (exact). 404 when nothing matches — callers apply their own eligibility rules (e.g. F11 gate). */
  async lookup(code: string, manager?: EntityManager): Promise<ProductLookupResult> {
    const value = (code ?? '').trim();
    if (!value) throw new BadRequestException('A code is required.');
    const runner = this.runner(manager);
    let product = await runner.getRepository(Product).findOne({ where: { sku: value } });
    let matchedBy: 'sku' | 'barcode' = 'sku';
    let barcode: string | null = null;
    if (!product) {
      const row = await runner.getRepository(ProductBarcode).findOne({ where: { barcode: value } });
      if (row) {
        product = await runner.getRepository(Product).findOne({ where: { id: row.productId } });
        matchedBy = 'barcode';
        barcode = row.barcode;
      }
    }
    if (!product) throw new NotFoundException(`No item has the code or barcode "${value}".`);
    return {
      matchedBy,
      barcode,
      product: { id: product.id, sku: product.sku, name: product.name, unit: product.unit, unitPrice: product.unitPrice, status: product.status, itemType: product.itemType },
    };
  }

  private async requireProduct(productId: string, manager?: EntityManager): Promise<Product> {
    const product = await this.runner(manager).getRepository(Product).findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    return product;
  }
}
