import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Product } from '../infrastructure/product.entity';
import { ProductBarcode } from '../infrastructure/product-barcode.entity';
import { canTransitionProductStatus, ProductStatus } from '../domain/product-status';
import { ProductSnapshot } from './product-snapshot.dto';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { SalesProductsContract } from '../../../foundation/module-registry/contracts/sales.contract';

@Injectable()
/** P4 Tranche-2 contract-conformance check (Task 2) — `implements` makes the compiler enforce that this class still satisfies `SalesProductsContract` on every change, instead of the `useExisting` DI binding trusting it silently. */
export class ProductsService implements SalesProductsContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
  ) {}

  /** D7 (2026-10-05) — published contract: a New Item Request's draft product (unit price 0 — pricing is set by the catalog owner). */
  async createDraftProduct(input: { sku: string; name: string; unit?: string | null }, actorUserId: string, manager?: EntityManager): Promise<ProductSnapshot> {
    const p = await this.createProduct(input.sku, input.name, '0', actorUserId, input.unit ?? null, manager);
    return { id: p.id, sku: p.sku, name: p.name, unitPrice: p.unitPrice, status: p.status };
  }

  /** D7 (2026-10-05) — published contract: the approved New Item Request's `draft → active` step. */
  async activateDraftProduct(productId: string, actorUserId: string, manager?: EntityManager): Promise<ProductSnapshot> {
    const p = await this.setStatus(productId, 'active', actorUserId, manager);
    return { id: p.id, sku: p.sku, name: p.name, unitPrice: p.unitPrice, status: p.status };
  }

  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added, threaded into the transaction, `audit.record`, and `events.dispatchPending`. */
  async createProduct(
    sku: string,
    name: string,
    unitPrice: string,
    actorUserId: string | null,
    unit: string | null = null,
    manager?: EntityManager,
  ): Promise<Product> {
    const repo = (manager ?? this.dataSource).getRepository(Product);
    const existing = await repo.findOne({ where: { sku } });
    if (existing) throw new ConflictException(`Product with SKU "${sku}" already exists.`);
    // Master data step 1 (D-MD11) — SKU and barcode share one lookup namespace, so a new SKU may not equal an existing barcode.
    if (await (manager ?? this.dataSource).getRepository(ProductBarcode).findOne({ where: { barcode: sku } })) {
      throw new ConflictException(`"${sku}" is already used as a barcode and cannot be an item code (SKU).`);
    }

    const product = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const saved = await txManager.getRepository(Product).save(txManager.getRepository(Product).create({ sku, name, unitPrice, unit, status: 'draft' }));
      // Outbox write in the SAME transaction as the insert (ADR-012) —
      // External Integrations (CTO handover directive: "Daii <-> QR Store
      // Integration") subscribes to this to auto-publish new products.
      await this.events.publish(txManager, 'commerce.product.created', { productId: saved.id, sku: saved.sku, name: saved.name });
      return saved;
    });

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.product.created',
        resource: 'product',
        resourceId: product.id,
        result: 'success',
        correlationId: null,
        after: { sku, name, unitPrice },
      },
      manager,
    );

    // Dispatched inline, not by a background worker — Background
    // Processing (foundation/background-processing/README.md) is
    // explicitly not built yet. Harmless to call unconditionally: any
    // topic with no subscriber is a no-op (EventBusService.dispatchPending).
    await this.events.dispatchPending(undefined, manager);

    return product;
  }

  async setStatus(productId: string, newStatus: Product['status'], actorUserId: string | null, manager?: EntityManager): Promise<Product> {
    const repo = (manager ?? this.dataSource).getRepository(Product);
    const product = await repo.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    if (!canTransitionProductStatus(product.status, newStatus)) {
      throw new ConflictException(`Cannot transition product from "${product.status}" to "${newStatus}".`);
    }
    const before = { status: product.status };

    const saved = await (manager ?? this.dataSource).transaction(async (txManager) => {
      product.status = newStatus;
      const updated = await txManager.getRepository(Product).save(product);
      await this.events.publish(txManager, 'commerce.product.status_changed', {
        productId: updated.id,
        sku: updated.sku,
        name: updated.name,
        status: updated.status,
      });
      return updated;
    });

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.product.status_changed',
        resource: 'product',
        resourceId: productId,
        result: 'success',
        correlationId: null,
        before,
        after: { status: newStatus },
      },
      manager,
    );

    await this.events.dispatchPending(undefined, manager);

    return saved;
  }

  /**
   * A real, small, genuinely-missing capability found via the QR
   * handshake verification (CTO directive: "Daii <-> QR Store
   * Integration" step 4, "change its price") — Daii had no way to
   * change a product's own base price after creation at all. Mirrors
   * `setStatus`'s exact shape (transaction + outbox event + audit +
   * inline dispatch) — this is Product's OWN base/list price, distinct
   * from a Price List override (Gap G-3), which stays untouched by this.
   */
  /** Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — the descriptive unit label shown on the Inventory Grid. */
  async updateUnit(productId: string, unit: string | null, actorUserId: string | null, manager?: EntityManager): Promise<Product> {
    const repo = (manager ?? this.dataSource).getRepository(Product);
    const product = await repo.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    const before = { unit: product.unit };
    product.unit = unit;
    const saved = await repo.save(product);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.product.unit_changed',
        resource: 'product',
        resourceId: productId,
        result: 'success',
        correlationId: null,
        before,
        after: { unit },
      },
      manager,
    );
    return saved;
  }

  async updatePrice(productId: string, unitPrice: string, actorUserId: string | null, manager?: EntityManager): Promise<Product> {
    const repo = (manager ?? this.dataSource).getRepository(Product);
    const product = await repo.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    if (Number.isNaN(Number(unitPrice)) || Number(unitPrice) < 0) {
      throw new ConflictException(`Invalid price "${unitPrice}" — must be a non-negative number.`);
    }
    const before = { unitPrice: product.unitPrice };

    const saved = await (manager ?? this.dataSource).transaction(async (txManager) => {
      product.unitPrice = unitPrice;
      const updated = await txManager.getRepository(Product).save(product);
      await this.events.publish(txManager, 'commerce.product.price_changed', {
        productId: updated.id,
        sku: updated.sku,
        name: updated.name,
        unitPrice: updated.unitPrice,
      });
      return updated;
    });

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.product.price_changed',
        resource: 'product',
        resourceId: productId,
        result: 'success',
        correlationId: null,
        before,
        after: { unitPrice },
      },
      manager,
    );

    await this.events.dispatchPending(undefined, manager);

    return saved;
  }

  async updateName(productId: string, name: string, actorUserId: string | null, manager?: EntityManager): Promise<Product> {
    const repo = (manager ?? this.dataSource).getRepository(Product);
    const product = await repo.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    if (name.trim().length === 0) {
      throw new ConflictException('Product name cannot be empty.');
    }
    const before = { name: product.name };

    const saved = await (manager ?? this.dataSource).transaction(async (txManager) => {
      product.name = name;
      const updated = await txManager.getRepository(Product).save(product);
      await this.events.publish(txManager, 'commerce.product.name_changed', {
        productId: updated.id,
        sku: updated.sku,
        name: updated.name,
      });
      return updated;
    });

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.product.name_changed',
        resource: 'product',
        resourceId: productId,
        result: 'success',
        correlationId: null,
        before,
        after: { name },
      },
      manager,
    );

    await this.events.dispatchPending(undefined, manager);

    return saved;
  }

  /** Published contract (Inventory domain only — it validates the warehouse and the D1 assignment first). */
  async setDefaultWarehouse(productId: string, warehouseId: string | null, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? this.dataSource).getRepository(Product);
    const product = await repo.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    const before = { defaultWarehouseId: product.defaultWarehouseId };
    await repo.update({ id: productId }, { defaultWarehouseId: warehouseId });
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'commerce.product.default_warehouse_changed', resource: 'product', resourceId: productId, result: 'success', correlationId: null, before, after: { defaultWarehouseId: warehouseId } },
      manager,
    );
  }

  /** Published contract — the item was unassigned from `warehouseId`; a default pointing at it would be stale. */
  async clearDefaultWarehouseIfMatches(productId: string, warehouseId: string, actorUserId: string | null, manager?: EntityManager): Promise<boolean> {
    const result = await (manager ?? this.dataSource).getRepository(Product).update({ id: productId, defaultWarehouseId: warehouseId }, { defaultWarehouseId: null });
    const cleared = (result.affected ?? 0) > 0;
    if (cleared) {
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'commerce.product.default_warehouse_changed', resource: 'product', resourceId: productId, result: 'success', correlationId: null, before: { defaultWarehouseId: warehouseId }, after: { defaultWarehouseId: null, reason: 'unassigned_from_warehouse' } },
        manager,
      );
    }
    return cleared;
  }

  async getProduct(productId: string, manager?: EntityManager): Promise<Product> {
    const product = await (manager ?? this.dataSource).getRepository(Product).findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    return product;
  }

  /** Catalog reads are broadly available (Stage 1: "reads broadly available, writes admin-gated"). */
  async listActiveProducts(manager?: EntityManager): Promise<Product[]> {
    return (manager ?? this.dataSource).getRepository(Product).find({ where: { status: 'active' } });
  }

  /** Backs the Products management screen — every status, not just active, so draft/discontinued products can still be managed and historical order-line name lookups always resolve. */
  async listAllProducts(manager?: EntityManager): Promise<Product[]> {
    return (manager ?? this.dataSource).getRepository(Product).find({ order: { sku: 'ASC' } });
  }

  /**
   * Excel import (CTO finalization directive §3/§4) — enters through the
   * exact same `createProduct`/`setStatus` calls the UI uses, per row.
   * Never writes to the `products` table directly. Each row's outcome
   * (created, or rejected with a reason) is independent — one bad row
   * cannot corrupt or block the others, and a row that fails never
   * leaves a half-created product (createProduct is one atomic insert;
   * a rejected row simply never calls it).
   */
  async importRows(
    rows: Array<{ sku: string; name: string; unitPrice: string; status: string }>,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<{ succeeded: Product[]; rejected: Array<{ row: number; errors: string[] }> }> {
    const succeeded: Product[] = [];
    const rejected: Array<{ row: number; errors: string[] }> = [];
    const seenSkusInFile = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2; // header is row 1
      const raw = rows[i];
      const errors: string[] = [];

      const sku = raw.sku.trim();
      const name = raw.name.trim();
      const unitPriceText = raw.unitPrice.trim();
      const statusText = raw.status.trim().toLowerCase();

      if (!sku) errors.push('Product Code is required.');
      if (!name) errors.push('Product Name is required.');
      if (!unitPriceText) errors.push('Price is required.');
      else if (Number.isNaN(Number(unitPriceText)) || Number(unitPriceText) < 0) {
        errors.push(`Price "${unitPriceText}" is not a valid non-negative number.`);
      }
      const status: ProductStatus = statusText ? (statusText as ProductStatus) : 'draft';
      if (statusText && !['draft', 'active', 'discontinued'].includes(statusText)) {
        errors.push(`Status "${raw.status}" must be one of: draft, active, discontinued.`);
      }
      if (sku && seenSkusInFile.has(sku)) {
        errors.push(`Duplicate Product Code "${sku}" within this file.`);
      }

      if (errors.length > 0) {
        rejected.push({ row: rowNumber, errors });
        continue;
      }
      seenSkusInFile.add(sku);

      try {
        const product = await this.createProduct(sku, name, unitPriceText, actorUserId, null, manager);
        // canTransitionProductStatus only allows one step at a time
        // (draft->active->discontinued) — a fresh product always starts
        // at 'draft', so reaching 'discontinued' from an import walks
        // through 'active' first, same as an operator would via the UI.
        if (status === 'active' || status === 'discontinued') {
          await this.setStatus(product.id, 'active', actorUserId, manager);
          product.status = 'active';
        }
        if (status === 'discontinued') {
          await this.setStatus(product.id, 'discontinued', actorUserId, manager);
          product.status = 'discontinued';
        }
        succeeded.push(product);
      } catch (err) {
        rejected.push({ row: rowNumber, errors: [err instanceof Error ? err.message : 'Unknown error creating product.'] });
      }
    }

    return { succeeded, rejected };
  }

  /**
   * Commerce's published contract for other domains
   * (DAII_DOMAIN_BOUNDARIES.md Cross-Domain Rule) — Sales Orders (and any
   * future consumer) calls this instead of importing Product's TypeORM
   * entity/repository directly.
   */
  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added — Product is Company-owned, and this cross-domain contract is called from Company-scoped flows (e.g. `SalesOrdersService.createOrder`). */
  async getProductSnapshot(productId: string, manager?: EntityManager): Promise<ProductSnapshot | null> {
    const product = await (manager ?? this.dataSource).getRepository(Product).findOne({ where: { id: productId } });
    if (!product) return null;
    return { id: product.id, sku: product.sku, name: product.name, unitPrice: product.unitPrice, status: product.status };
  }

  /** Same published contract, keyed by SKU — Inventory's opening-stock Excel import resolves a spreadsheet's SKU column through this, never through Product's raw table. */
  async getProductSnapshotBySku(sku: string, manager?: EntityManager): Promise<ProductSnapshot | null> {
    const product = await (manager ?? this.dataSource).getRepository(Product).findOne({ where: { sku } });
    if (!product) return null;
    return { id: product.id, sku: product.sku, name: product.name, unitPrice: product.unitPrice, status: product.status };
  }
}
