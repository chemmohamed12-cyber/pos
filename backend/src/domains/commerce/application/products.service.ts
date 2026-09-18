import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Product } from '../infrastructure/product.entity';
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

  async createProduct(
    sku: string,
    name: string,
    unitPrice: string,
    actorUserId: string | null,
    unit: string | null = null,
  ): Promise<Product> {
    const repo = this.dataSource.getRepository(Product);
    const existing = await repo.findOne({ where: { sku } });
    if (existing) throw new ConflictException(`Product with SKU "${sku}" already exists.`);

    const product = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.getRepository(Product).save(manager.getRepository(Product).create({ sku, name, unitPrice, unit, status: 'draft' }));
      // Outbox write in the SAME transaction as the insert (ADR-012) —
      // External Integrations (CTO handover directive: "Daii <-> QR Store
      // Integration") subscribes to this to auto-publish new products.
      await this.events.publish(manager, 'commerce.product.created', { productId: saved.id, sku: saved.sku, name: saved.name });
      return saved;
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'commerce.product.created',
      resource: 'product',
      resourceId: product.id,
      result: 'success',
      correlationId: null,
      after: { sku, name, unitPrice },
    });

    // Dispatched inline, not by a background worker — Background
    // Processing (foundation/background-processing/README.md) is
    // explicitly not built yet. Harmless to call unconditionally: any
    // topic with no subscriber is a no-op (EventBusService.dispatchPending).
    await this.events.dispatchPending();

    return product;
  }

  async setStatus(productId: string, newStatus: Product['status'], actorUserId: string | null): Promise<Product> {
    const repo = this.dataSource.getRepository(Product);
    const product = await repo.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    if (!canTransitionProductStatus(product.status, newStatus)) {
      throw new ConflictException(`Cannot transition product from "${product.status}" to "${newStatus}".`);
    }
    const before = { status: product.status };

    const saved = await this.dataSource.transaction(async (manager) => {
      product.status = newStatus;
      const updated = await manager.getRepository(Product).save(product);
      await this.events.publish(manager, 'commerce.product.status_changed', {
        productId: updated.id,
        sku: updated.sku,
        name: updated.name,
        status: updated.status,
      });
      return updated;
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'commerce.product.status_changed',
      resource: 'product',
      resourceId: productId,
      result: 'success',
      correlationId: null,
      before,
      after: { status: newStatus },
    });

    await this.events.dispatchPending();

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
  async updateUnit(productId: string, unit: string | null, actorUserId: string | null): Promise<Product> {
    const repo = this.dataSource.getRepository(Product);
    const product = await repo.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    const before = { unit: product.unit };
    product.unit = unit;
    const saved = await repo.save(product);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'commerce.product.unit_changed',
      resource: 'product',
      resourceId: productId,
      result: 'success',
      correlationId: null,
      before,
      after: { unit },
    });
    return saved;
  }

  async updatePrice(productId: string, unitPrice: string, actorUserId: string | null): Promise<Product> {
    const repo = this.dataSource.getRepository(Product);
    const product = await repo.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    if (Number.isNaN(Number(unitPrice)) || Number(unitPrice) < 0) {
      throw new ConflictException(`Invalid price "${unitPrice}" — must be a non-negative number.`);
    }
    const before = { unitPrice: product.unitPrice };

    const saved = await this.dataSource.transaction(async (manager) => {
      product.unitPrice = unitPrice;
      const updated = await manager.getRepository(Product).save(product);
      await this.events.publish(manager, 'commerce.product.price_changed', {
        productId: updated.id,
        sku: updated.sku,
        name: updated.name,
        unitPrice: updated.unitPrice,
      });
      return updated;
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'commerce.product.price_changed',
      resource: 'product',
      resourceId: productId,
      result: 'success',
      correlationId: null,
      before,
      after: { unitPrice },
    });

    await this.events.dispatchPending();

    return saved;
  }

  async updateName(productId: string, name: string, actorUserId: string | null): Promise<Product> {
    const repo = this.dataSource.getRepository(Product);
    const product = await repo.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    if (name.trim().length === 0) {
      throw new ConflictException('Product name cannot be empty.');
    }
    const before = { name: product.name };

    const saved = await this.dataSource.transaction(async (manager) => {
      product.name = name;
      const updated = await manager.getRepository(Product).save(product);
      await this.events.publish(manager, 'commerce.product.name_changed', {
        productId: updated.id,
        sku: updated.sku,
        name: updated.name,
      });
      return updated;
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'commerce.product.name_changed',
      resource: 'product',
      resourceId: productId,
      result: 'success',
      correlationId: null,
      before,
      after: { name },
    });

    await this.events.dispatchPending();

    return saved;
  }

  async getProduct(productId: string): Promise<Product> {
    const product = await this.dataSource.getRepository(Product).findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    return product;
  }

  /** Catalog reads are broadly available (Stage 1: "reads broadly available, writes admin-gated"). */
  async listActiveProducts(): Promise<Product[]> {
    return this.dataSource.getRepository(Product).find({ where: { status: 'active' } });
  }

  /** Backs the Products management screen — every status, not just active, so draft/discontinued products can still be managed and historical order-line name lookups always resolve. */
  async listAllProducts(): Promise<Product[]> {
    return this.dataSource.getRepository(Product).find({ order: { sku: 'ASC' } });
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
        const product = await this.createProduct(sku, name, unitPriceText, actorUserId);
        // canTransitionProductStatus only allows one step at a time
        // (draft->active->discontinued) — a fresh product always starts
        // at 'draft', so reaching 'discontinued' from an import walks
        // through 'active' first, same as an operator would via the UI.
        if (status === 'active' || status === 'discontinued') {
          await this.setStatus(product.id, 'active', actorUserId);
          product.status = 'active';
        }
        if (status === 'discontinued') {
          await this.setStatus(product.id, 'discontinued', actorUserId);
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
  async getProductSnapshot(productId: string): Promise<ProductSnapshot | null> {
    const product = await this.dataSource.getRepository(Product).findOne({ where: { id: productId } });
    if (!product) return null;
    return { id: product.id, sku: product.sku, name: product.name, unitPrice: product.unitPrice, status: product.status };
  }

  /** Same published contract, keyed by SKU — Inventory's opening-stock Excel import resolves a spreadsheet's SKU column through this, never through Product's raw table. */
  async getProductSnapshotBySku(sku: string): Promise<ProductSnapshot | null> {
    const product = await this.dataSource.getRepository(Product).findOne({ where: { sku } });
    if (!product) return null;
    return { id: product.id, sku: product.sku, name: product.name, unitPrice: product.unitPrice, status: product.status };
  }
}
