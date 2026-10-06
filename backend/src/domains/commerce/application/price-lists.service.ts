import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PriceList } from '../infrastructure/price-list.entity';
import { PriceListItem } from '../infrastructure/price-list-item.entity';
import { canTransitionPriceListStatus, PriceListStatus } from '../domain/price-list-status';
import { PriceListRole } from '../domain/price-list-role';
import { ProductsService } from './products.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

/** What actually supplied a resolved Sales Order line price, and which list (if any) — `null` `priceListId` means the caller's own fallback (the product's live base price) applies; nothing here matched. */
export interface ResolvedPrice {
  price: string | null;
  priceListId: string | null;
}

export interface PriceListItemView {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  price: string;
}

/**
 * Commerce / Price Lists — Gap G-3
 * (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4/§12, G-3).
 * `price_lists` is an explicitly listed Commerce-owned entity
 * (DAII_DOMAIN_BOUNDARIES.md §1). Deliberately NOT a general pricing/
 * discount engine (no effective-date ranges, no tiered/quantity-break
 * pricing, no customer-group hierarchy — Daii has no structured
 * customer-group concept yet, only free-text `Customer.classification`):
 * one named list of flat per-product override prices, assignable to a
 * customer. `getOverridePrice` is the one cross-domain read Sales Orders
 * consumes (`DAII_DOMAIN_BOUNDARIES.md` Cross-Domain Rule).
 */
@Injectable()
export class PriceListsService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly products: ProductsService,
    private readonly events: EventBusService,
  ) {}

  /**
   * Post-v1.0.2 Hotfix 3 — every new product gets added to the General
   * list at its own creation-time price automatically, same event
   * `IntegrationsService` already subscribes to for the QR connector
   * (dispatch runs after the product's own write transaction has already
   * committed, so `getProductSnapshot` always finds it here).
   *
   * Area 21 / ADR-075 (D10, 2026-10-04): this handler is Company-scope —
   * it receives the Company's `EventContext` and routes every
   * `getProductSnapshot`/`getOrCreateGeneralList`/`upsertItem` call through
   * `ctx.manager` (the previously documented ambient-connection gap, Matrix
   * §50, is closed for this subscriber).
   */
  onModuleInit(): void {
    // ADR-075 (D10): Company-scope — reads/writes go through `ctx.manager` (null under ambient dispatch ⇒ unchanged).
    this.events.subscribe(
      'commerce.product.created',
      async (payload, ctx) => {
        const manager = ctx.manager ?? undefined;
        const productId = payload.productId as string;
        const product = await this.products.getProductSnapshot(productId, manager);
        if (!product) return; // defensive only — the event always names a product that was just committed
        const generalList = await this.getOrCreateGeneralList(manager);
        await this.upsertItem(generalList.id, productId, product.unitPrice, null, manager);
      },
      { scope: 'company' },
    );
  }

  async createPriceList(name: string, actorUserId: string | null, manager?: EntityManager): Promise<PriceList> {
    const code = await this.numbering.getNextNumber('price_list', manager);
    const repo = (manager ?? this.dataSource).getRepository(PriceList);
    const saved = await repo.save(repo.create({ code, name, status: 'active' }));

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.price_list.created',
        resource: 'price_list',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { code: saved.code, name: saved.name },
      },
      manager,
    );

    return saved;
  }

  async setStatus(priceListId: string, newStatus: PriceListStatus, actorUserId: string | null, manager?: EntityManager): Promise<PriceList> {
    const repo = (manager ?? this.dataSource).getRepository(PriceList);
    const priceList = await repo.findOne({ where: { id: priceListId } });
    if (!priceList) throw new NotFoundException(`Price list "${priceListId}" not found.`);
    if (!canTransitionPriceListStatus(priceList.status, newStatus)) {
      throw new ConflictException(`Cannot transition price list from "${priceList.status}" to "${newStatus}".`);
    }
    const before = { status: priceList.status };
    priceList.status = newStatus;
    const saved = await repo.save(priceList);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.price_list.status_changed',
        resource: 'price_list',
        resourceId: priceListId,
        result: 'success',
        correlationId: null,
        before,
        after: { status: newStatus },
      },
      manager,
    );

    return saved;
  }

  /**
   * Post-v1.0.2 Hotfix 3 — marks (or clears, when `role` is `null`) a
   * list's role in the priority chain. Only `'main'` is ever set through
   * this from the admin UI (`'general'` is system-managed, see
   * `onModuleInit`/`getOrCreateGeneralList` above). Auto-clears whichever
   * OTHER list previously held this role — "the Main list" is singular by
   * definition, so setting a new one un-sets the old one rather than
   * requiring a separate confirmation step; `IDX_price_lists_role` is the
   * DB-level backstop for this same invariant.
   */
  async setRole(priceListId: string, role: PriceListRole, actorUserId: string | null, manager?: EntityManager): Promise<PriceList> {
    const priceList = await this.getPriceList(priceListId, manager);
    const repo = (manager ?? this.dataSource).getRepository(PriceList);

    if (role !== null) {
      const previousHolder = await repo.findOne({ where: { role } });
      if (previousHolder && previousHolder.id !== priceListId) {
        previousHolder.role = null;
        await repo.save(previousHolder);
      }
    }

    const before = { role: priceList.role };
    priceList.role = role;
    const saved = await repo.save(priceList);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.price_list.role_changed',
        resource: 'price_list',
        resourceId: priceListId,
        result: 'success',
        correlationId: null,
        before,
        after: { role },
      },
      manager,
    );

    return saved;
  }

  /** The single system-owned General list — created on first use if it doesn't exist yet (normally already created by the `AddPriceListRoleAndGeneralList` migration; this is a defensive fallback, not the primary bootstrap path). */
  private async getOrCreateGeneralList(manager?: EntityManager): Promise<PriceList> {
    const repo = (manager ?? this.dataSource).getRepository(PriceList);
    const existing = await repo.findOne({ where: { role: 'general' } });
    if (existing) return existing;
    const code = await this.numbering.getNextNumber('price_list', manager);
    return repo.save(repo.create({ code, name: 'General Price List', status: 'active', role: 'general' }));
  }

  /**
   * Post-v1.0.2 Hotfix 3 — the real Customer -> Main -> General priority
   * chain, replacing the old single-tier (customer-list-or-nothing)
   * lookup `SalesOrdersService.resolveLineInput` used before. Returns
   * which list (if any) actually supplied the price, for
   * `SalesOrderLine.priceListId`'s traceability — a `null` `priceListId`
   * means none of the three tiers had an override for this product, and
   * the caller falls back to the product's own live base price, exactly
   * as before this hotfix (never a broken order over incomplete pricing
   * data).
   */
  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added — PriceList/PriceListItem are Company-owned, called from Company-scoped flows (e.g. `SalesOrdersService.createOrder`). */
  async resolvePrice(customerPriceListId: string | null, productId: string, manager?: EntityManager): Promise<ResolvedPrice> {
    if (customerPriceListId) {
      const price = await this.getOverridePrice(customerPriceListId, productId, manager);
      if (price !== null) return { price, priceListId: customerPriceListId };
    }

    const repo = (manager ?? this.dataSource).getRepository(PriceList);
    const main = await repo.findOne({ where: { role: 'main' } });
    if (main) {
      const price = await this.getOverridePrice(main.id, productId, manager);
      if (price !== null) return { price, priceListId: main.id };
    }

    const general = await repo.findOne({ where: { role: 'general' } });
    if (general) {
      const price = await this.getOverridePrice(general.id, productId, manager);
      if (price !== null) return { price, priceListId: general.id };
    }

    return { price: null, priceListId: null };
  }

  async listPriceLists(manager?: EntityManager): Promise<PriceList[]> {
    return (manager ?? this.dataSource).getRepository(PriceList).find({ order: { code: 'ASC' } });
  }

  async getPriceList(priceListId: string, manager?: EntityManager): Promise<PriceList> {
    const priceList = await (manager ?? this.dataSource).getRepository(PriceList).findOne({ where: { id: priceListId } });
    if (!priceList) throw new NotFoundException(`Price list "${priceListId}" not found.`);
    return priceList;
  }

  /** Backs the Price List detail screen — items joined with the product's own SKU/name for display, resolved through ProductsService (same domain, not a cross-domain violation). */
  async listItems(priceListId: string, manager?: EntityManager): Promise<PriceListItemView[]> {
    await this.getPriceList(priceListId, manager); // 404s for an unknown price list before listing its (empty) items
    const items = await (manager ?? this.dataSource).getRepository(PriceListItem).find({ where: { priceListId } });
    const views: PriceListItemView[] = [];
    for (const item of items) {
      const product = await this.products.getProductSnapshot(item.productId, manager);
      views.push({
        id: item.id,
        productId: item.productId,
        sku: product?.sku ?? item.productId,
        productName: product?.name ?? item.productId,
        price: item.price,
      });
    }
    return views;
  }

  /** Create-or-update a product's override price within a price list — one price per product per list, never duplicated. */
  async upsertItem(priceListId: string, productId: string, price: string, actorUserId: string | null, manager?: EntityManager): Promise<PriceListItem> {
    await this.getPriceList(priceListId, manager);
    const product = await this.products.getProductSnapshot(productId, manager);
    if (!product) throw new NotFoundException(`Product "${productId}" not found.`);
    if (Number.isNaN(Number(price)) || Number(price) < 0) {
      throw new ConflictException(`Invalid price "${price}" — must be a non-negative number.`);
    }

    const repo = (manager ?? this.dataSource).getRepository(PriceListItem);
    const existing = await repo.findOne({ where: { priceListId, productId } });
    const saved = existing
      ? await repo.save({ ...existing, price })
      : await repo.save(repo.create({ priceListId, productId, price }));

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: existing ? 'commerce.price_list_item.updated' : 'commerce.price_list_item.added',
        resource: 'price_list_item',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { priceListId, productId, price },
      },
      manager,
    );

    return saved;
  }

  async removeItem(priceListId: string, itemId: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? this.dataSource).getRepository(PriceListItem);
    const item = await repo.findOne({ where: { id: itemId, priceListId } });
    if (!item) throw new NotFoundException(`Price list item "${itemId}" not found in price list "${priceListId}".`);
    await repo.remove(item);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'commerce.price_list_item.removed',
        resource: 'price_list_item',
        resourceId: itemId,
        result: 'success',
        correlationId: null,
        before: { priceListId, productId: item.productId, price: item.price },
      },
      manager,
    );
  }

  /**
   * Cross-domain read contract for Sales Orders (DAII_DOMAIN_BOUNDARIES.md
   * Cross-Domain Rule) — same pattern as `ProductsService.getProductSnapshot`.
   * Returns null (never throws) whenever no override applies — an unknown
   * or inactive price list, or a product simply not listed in it — so the
   * caller's fallback to the product's own base price is always a plain
   * `?? product.unitPrice`, never a try/catch.
   */
  async getOverridePrice(priceListId: string, productId: string, manager?: EntityManager): Promise<string | null> {
    const priceList = await (manager ?? this.dataSource).getRepository(PriceList).findOne({ where: { id: priceListId } });
    if (!priceList || priceList.status !== 'active') return null;
    const item = await (manager ?? this.dataSource).getRepository(PriceListItem).findOne({ where: { priceListId, productId } });
    return item?.price ?? null;
  }

  /**
   * Excel import for one price list's items (CTO handover directive §13 —
   * Excel import/export integration where the existing capability
   * supports it). Enters through the same `upsertItem` call the UI uses,
   * per row — never writes to `price_list_items` directly. Rows reference
   * a product by SKU (stable, human-entered identifier), resolved via
   * Commerce's own published snapshot contract.
   */
  async importItemRows(
    priceListId: string,
    rows: Array<{ sku: string; price: string }>,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<{ succeededCount: number; rejected: Array<{ row: number; errors: string[] }> }> {
    await this.getPriceList(priceListId, manager);
    let succeededCount = 0;
    const rejected: Array<{ row: number; errors: string[] }> = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const sku = rows[i].sku.trim();
      const priceText = rows[i].price.trim();
      const errors: string[] = [];

      if (!sku) errors.push('Product Code is required.');
      if (!priceText) errors.push('Price is required.');
      else if (Number.isNaN(Number(priceText)) || Number(priceText) < 0) {
        errors.push(`Price "${priceText}" is not a valid non-negative number.`);
      }

      let productId: string | null = null;
      if (sku) {
        const product = await this.products.getProductSnapshotBySku(sku, manager);
        if (!product) errors.push(`Product with code "${sku}" was not found.`);
        else productId = product.id;
      }

      if (errors.length > 0) {
        rejected.push({ row: rowNumber, errors });
        continue;
      }

      try {
        await this.upsertItem(priceListId, productId as string, priceText, actorUserId, manager);
        succeededCount++;
      } catch (err) {
        rejected.push({ row: rowNumber, errors: [err instanceof Error ? err.message : 'Unknown error importing row.'] });
      }
    }

    return { succeededCount, rejected };
  }
}
