import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Like } from 'typeorm';
import { StockMovement } from '../infrastructure/stock-movement.entity';
import { StockReservation, ReservationStatus } from '../infrastructure/stock-reservation.entity';
import { Warehouse } from '../infrastructure/warehouse.entity';
import { MovementType } from '../domain/movement-type';
import { canTransitionWarehouseStatus, WarehouseStatus } from '../domain/warehouse-status';
import { AuditService } from '../../../foundation/audit/audit.service';
import { ProductsService } from '../../commerce/application/products.service';
import { BomService } from '../../commerce/application/bom.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';

/**
 * Inventory & Warehouse — Stage 2 build-order item 27. The concurrency-
 * critical domain Stage 1 explicitly flagged (DAII_DATA_ARCHITECTURE.md
 * §4: "two orders competing for the same limited stock").
 *
 * There is no single lockable "stock balance" row — by design, stock is
 * a SUM over the ledger (blueprint §17, ADR-007), never a mutable
 * column. `reserveStock` therefore uses a transaction-scoped Postgres
 * advisory lock keyed on (warehouseId, productId) to serialize
 * concurrent reservation attempts against the same product/warehouse —
 * the real DB-transactional equivalent of the row-lock pattern used
 * elsewhere in this codebase (Audit, Numbering, Process Engine), adapted
 * for a case with no natural row to lock. Released automatically at
 * transaction end (`pg_advisory_xact_lock`), no explicit unlock needed.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly products: ProductsService,
    private readonly bom: BomService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * `parentWarehouseId`/`kind` optional and appended last (backward
   * compatible with every existing caller, which all create ordinary
   * top-level warehouses) — CTO directive ("SHIPPING & CUSTODY
   * MANAGEMENT" §4): a Shipping Company / Company Vehicle's
   * auto-created Operational Sub-location is created through this SAME
   * method (`ShipmentService.createShippingCompany`/`createVehicle`),
   * never a parallel warehouse-creation path.
   */
  async createWarehouse(
    code: string,
    name: string,
    location: string | null = null,
    responsibleUserId: string | null = null,
    parentWarehouseId: string | null = null,
    kind: 'main' | 'operational' = 'main',
  ): Promise<Warehouse> {
    const repo = this.dataSource.getRepository(Warehouse);
    const existing = await repo.findOne({ where: { code } });
    if (existing) throw new ConflictException(`Warehouse with code "${code}" already exists.`);
    return repo.save(repo.create({ code, name, location, responsibleUserId, parentWarehouseId, kind, status: 'active' }));
  }

  async listWarehouses(): Promise<Warehouse[]> {
    return this.dataSource.getRepository(Warehouse).find();
  }

  async getWarehouse(warehouseId: string): Promise<Warehouse> {
    const warehouse = await this.dataSource.getRepository(Warehouse).findOne({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException(`Warehouse "${warehouseId}" not found.`);
    return warehouse;
  }

  /** Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — active/inactive toggle, audited like every other status change in this codebase. */
  async setWarehouseStatus(warehouseId: string, status: WarehouseStatus, actorUserId: string | null): Promise<Warehouse> {
    const warehouse = await this.getWarehouse(warehouseId);
    if (!canTransitionWarehouseStatus(warehouse.status, status)) {
      throw new ConflictException(`Cannot transition warehouse from "${warehouse.status}" to "${status}".`);
    }
    const before = { status: warehouse.status };
    warehouse.status = status;
    const saved = await this.dataSource.getRepository(Warehouse).save(warehouse);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'inventory.warehouse.status_changed',
      resource: 'warehouse',
      resourceId: warehouseId,
      result: 'success',
      correlationId: null,
      before,
      after: { status },
    });
    return saved;
  }

  /** Excel import (CTO finalization directive §3/§4) — enters through the same `createWarehouse` call the UI uses, per row. */
  async importWarehouseRows(
    rows: Array<{ code: string; name: string }>,
  ): Promise<{ succeeded: Warehouse[]; rejected: Array<{ row: number; errors: string[] }> }> {
    const succeeded: Warehouse[] = [];
    const rejected: Array<{ row: number; errors: string[] }> = [];
    const seenCodesInFile = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const code = rows[i].code.trim();
      const name = rows[i].name.trim();
      const errors: string[] = [];
      if (!code) errors.push('Warehouse Code is required.');
      if (!name) errors.push('Warehouse Name is required.');
      if (code && seenCodesInFile.has(code)) errors.push(`Duplicate Warehouse Code "${code}" within this file.`);

      if (errors.length > 0) {
        rejected.push({ row: rowNumber, errors });
        continue;
      }
      seenCodesInFile.add(code);

      try {
        succeeded.push(await this.createWarehouse(code, name));
      } catch (err) {
        rejected.push({ row: rowNumber, errors: [err instanceof Error ? err.message : 'Unknown error creating warehouse.'] });
      }
    }

    return { succeeded, rejected };
  }

  /**
   * `manager` is optional and appended last (backward compatible with
   * every existing caller) — pass a caller-owned transaction's own
   * manager (same idiom as `AuditService.record`'s manager parameter,
   * already used by `reserveStock`) when this movement must commit or
   * roll back atomically together with OTHER movements/reads in the same
   * transaction. `WarehouseTransactionsService.postTransaction` (Gap:
   * multi-line stock validation) is the reference caller — a whole
   * document's movements post together or not at all, never partially.
   */
  async recordMovement(
    warehouseId: string,
    productId: string,
    quantity: number,
    movementType: MovementType,
    referenceType: string | null,
    referenceId: string | null,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<StockMovement> {
    const repo = (manager ?? this.dataSource).getRepository(StockMovement);
    const movement = await repo.save(
      repo.create({ warehouseId, productId, quantity, movementType, referenceType, referenceId, createdByUserId: actorUserId }),
    );
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: `inventory.movement.${movementType}`,
        resource: 'stock_movement',
        resourceId: movement.id,
        result: 'success',
        correlationId: null,
        after: { warehouseId, productId, quantity, movementType },
      },
      manager,
    );
    return movement;
  }

  /**
   * Manager-aware `getAvailable` — reads current on-hand minus active
   * reservations THROUGH the caller's own transaction/connection, so an
   * advisory lock taken on that same connection (see `reserveStock`,
   * `assembleProduct`) actually serializes this read against a
   * concurrent writer, closing the exact race the plain (non-transactional)
   * `getAvailable` cannot: two simultaneous postings both reading the
   * same stale "available" snapshot and both proceeding.
   */
  async getAvailableInTransaction(manager: EntityManager, warehouseId: string, productId: string): Promise<number> {
    const onHandRows: Array<{ sum: string | null }> = await manager.query(
      'SELECT SUM(quantity) as sum FROM stock_movements WHERE "warehouseId" = $1 AND "productId" = $2',
      [warehouseId, productId],
    );
    const reservedRows: Array<{ sum: string | null }> = await manager.query(
      `SELECT SUM(quantity) as sum FROM stock_reservations WHERE "warehouseId" = $1 AND "productId" = $2 AND status IN ('active', 'preliminary')`,
      [warehouseId, productId],
    );
    return Number(onHandRows[0]?.sum ?? 0) - Number(reservedRows[0]?.sum ?? 0);
  }

  /** Backs the Inventory Movement print document — single-movement read, didn't exist before (movements were only ever summed, never fetched individually). */
  async getMovement(movementId: string): Promise<StockMovement> {
    const movement = await this.dataSource.getRepository(StockMovement).findOne({ where: { id: movementId } });
    if (!movement) throw new NotFoundException(`Stock movement "${movementId}" not found.`);
    return movement;
  }

  /**
   * Backs the Warehouse Movements operational report — the ledger already
   * has every fact this report needs (blueprint §17/§18, ADR-007); this
   * is purely a filtered read, no new business logic. Reads broadly
   * available, matching `getStock`'s existing policy (no role gate
   * beyond authentication).
   */
  async listMovements(filters: {
    warehouseId?: string;
    productId?: string;
    movementType?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<StockMovement[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const addCondition = (column: string, value: string | undefined) => {
      if (!value) return;
      params.push(value);
      conditions.push(`"${column}" = $${params.length}`);
    };
    addCondition('warehouseId', filters.warehouseId);
    addCondition('productId', filters.productId);
    addCondition('movementType', filters.movementType);
    if (filters.dateFrom) {
      params.push(filters.dateFrom);
      conditions.push(`"createdAt" >= $${params.length}`);
    }
    if (filters.dateTo) {
      params.push(filters.dateTo);
      conditions.push(`"createdAt" <= $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.dataSource.query(
      `SELECT * FROM stock_movements ${where} ORDER BY "createdAt" DESC`,
      params,
    );
  }

  /**
   * Backs the Inventory/Stock operational report — the same on-hand/
   * reserved/available formula `getOnHand`/`getReserved`/`getAvailable`
   * already use (ADR-007), vectorized across every product that has EVER
   * moved in the given warehouse (or every warehouse, if none given)
   * instead of one (warehouseId, productId) pair at a time — avoids an
   * N-products x M-warehouses round-trip storm from the report screen.
   */
  async getStockReport(
    warehouseId?: string,
  ): Promise<Array<{ warehouseId: string; productId: string; onHand: number; reserved: number; available: number }>> {
    const onHandRows: Array<{ warehouseId: string; productId: string; sum: string }> = await this.dataSource.query(
      `SELECT "warehouseId", "productId", SUM(quantity) as sum FROM stock_movements
       ${warehouseId ? 'WHERE "warehouseId" = $1' : ''}
       GROUP BY "warehouseId", "productId"`,
      warehouseId ? [warehouseId] : [],
    );
    const reservedRows: Array<{ warehouseId: string; productId: string; sum: string }> = await this.dataSource.query(
      `SELECT "warehouseId", "productId", SUM(quantity) as sum FROM stock_reservations
       WHERE status IN ('active', 'preliminary') ${warehouseId ? 'AND "warehouseId" = $1' : ''}
       GROUP BY "warehouseId", "productId"`,
      warehouseId ? [warehouseId] : [],
    );
    const reservedMap = new Map(reservedRows.map((r) => [`${r.warehouseId}:${r.productId}`, Number(r.sum)]));

    return onHandRows.map((row) => {
      const onHand = Number(row.sum);
      const reserved = reservedMap.get(`${row.warehouseId}:${row.productId}`) ?? 0;
      return { warehouseId: row.warehouseId, productId: row.productId, onHand, reserved, available: onHand - reserved };
    });
  }

  /**
   * Warehouse & Inventory Control — Inventory Grid (CTO decision:
   * "KEEP THE EXISTING WAREHOUSE & INVENTORY DOMAIN + REBUILD ITS
   * OPERATIONAL UX"). Unlike `getStockReport` (used only by the Excel
   * export, kept as-is to avoid touching a working path), this is
   * server-side paginated/searched/sorted — the directive's explicit
   * performance requirement ("ممنوع تحميل كل Inventory records مرة
   * واحدة"). Always scoped to ONE warehouse (the directive's own flow:
   * select a warehouse -> see ITS inventory), via a LEFT JOIN from
   * `products` so a product with zero movements in this warehouse still
   * appears as an explicit on-hand-0 row, never silently missing.
   */
  /**
   * `preliminaryHold`/`reserved` are reported as separate columns (CTO
   * directive — Preliminary Hold: "Total Stock / Free / Preliminary
   * Hold / Reserved / Available") even though both count identically
   * toward `available` — a new order can't consume either. The split is
   * purely for visibility: `preliminaryHold` = orders awaiting deposit
   * approval, `reserved` = deposit-confirmed orders.
   */
  async getWarehouseInventoryPage(
    warehouseId: string,
    options: { search?: string; page: number; pageSize: number; sortBy?: string; sortDir?: 'asc' | 'desc' },
  ): Promise<{
    rows: Array<{
      productId: string;
      sku: string;
      name: string;
      unit: string | null;
      status: string;
      onHand: number;
      preliminaryHold: number;
      reserved: number;
      available: number;
      lastMovementAt: string | null;
    }>;
    total: number;
  }> {
    const SORTABLE_COLUMNS: Record<string, string> = {
      sku: 'p.sku',
      name: 'p.name',
      status: 'p.status',
      onHand: '"onHand"',
      reserved: 'reserved',
      available: 'available',
      lastMovementAt: '"lastMovementAt"',
    };
    const orderColumn = SORTABLE_COLUMNS[options.sortBy ?? ''] ?? SORTABLE_COLUMNS.sku;
    const orderDir = options.sortDir === 'desc' ? 'DESC' : 'ASC';
    const search = options.search?.trim() || null;
    const offset = (options.page - 1) * options.pageSize;

    const fromAndWhere = `
      FROM products p
      LEFT JOIN (
        SELECT "productId", SUM(quantity) as on_hand, MAX("createdAt") as last_movement_at
        FROM stock_movements WHERE "warehouseId" = $1
        GROUP BY "productId"
      ) m ON m."productId" = p.id
      LEFT JOIN (
        SELECT "productId",
               SUM(CASE WHEN status = 'preliminary' THEN quantity ELSE 0 END) as preliminary_hold,
               SUM(CASE WHEN status = 'active' THEN quantity ELSE 0 END) as reserved
        FROM stock_reservations WHERE "warehouseId" = $1 AND status IN ('active', 'preliminary')
        GROUP BY "productId"
      ) r ON r."productId" = p.id
      WHERE ($2::text IS NULL OR p.sku ILIKE '%' || $2 || '%' OR p.name ILIKE '%' || $2 || '%')
    `;

    const countRows: Array<{ count: string }> = await this.dataSource.query(`SELECT COUNT(*) as count ${fromAndWhere}`, [warehouseId, search]);

    const rows: Array<{
      productId: string;
      sku: string;
      name: string;
      unit: string | null;
      status: string;
      onHand: string;
      preliminaryHold: string;
      reserved: string;
      available: string;
      lastMovementAt: string | null;
    }> = await this.dataSource.query(
      `SELECT p.id as "productId", p.sku, p.name, p.unit, p.status,
              COALESCE(m.on_hand, 0) as "onHand",
              COALESCE(r.preliminary_hold, 0) as "preliminaryHold",
              COALESCE(r.reserved, 0) as reserved,
              COALESCE(m.on_hand, 0) - COALESCE(r.preliminary_hold, 0) - COALESCE(r.reserved, 0) as available,
              m.last_movement_at as "lastMovementAt"
       ${fromAndWhere}
       ORDER BY ${orderColumn} ${orderDir}
       LIMIT $3 OFFSET $4`,
      [warehouseId, search, options.pageSize, offset],
    );

    return {
      total: Number(countRows[0]?.count ?? 0),
      rows: rows.map((r) => ({
        productId: r.productId,
        sku: r.sku,
        name: r.name,
        unit: r.unit,
        status: r.status,
        onHand: Number(r.onHand),
        preliminaryHold: Number(r.preliminaryHold),
        reserved: Number(r.reserved),
        available: Number(r.available),
        lastMovementAt: r.lastMovementAt,
      })),
    };
  }

  async getOnHand(warehouseId: string, productId: string): Promise<number> {
    const result: Array<{ sum: string | null }> = await this.dataSource.query(
      'SELECT SUM(quantity) as sum FROM stock_movements WHERE "warehouseId" = $1 AND "productId" = $2',
      [warehouseId, productId],
    );
    return Number(result[0]?.sum ?? 0);
  }

  async getReserved(warehouseId: string, productId: string): Promise<number> {
    const result: Array<{ sum: string | null }> = await this.dataSource.query(
      `SELECT SUM(quantity) as sum FROM stock_reservations WHERE "warehouseId" = $1 AND "productId" = $2 AND status IN ('active', 'preliminary')`,
      [warehouseId, productId],
    );
    return Number(result[0]?.sum ?? 0);
  }

  /**
   * Cross-domain read contract for External Integrations (CTO handover
   * directive, "Daii <-> QR Store Integration" §6/§20 "Availability
   * publication") — total available stock for a product across EVERY
   * warehouse, since a public storefront shows one figure, not a
   * per-warehouse breakdown. Daii remains the authority (directive §15:
   * "Do not trust stale QR inventory... as the final authority") — this
   * is always computed fresh from the ledger, never cached here.
   */
  async getTotalAvailable(productId: string): Promise<number> {
    const onHandRows: Array<{ sum: string | null }> = await this.dataSource.query(
      'SELECT SUM(quantity) as sum FROM stock_movements WHERE "productId" = $1',
      [productId],
    );
    const reservedRows: Array<{ sum: string | null }> = await this.dataSource.query(
      `SELECT SUM(quantity) as sum FROM stock_reservations WHERE "productId" = $1 AND status IN ('active', 'preliminary')`,
      [productId],
    );
    return Number(onHandRows[0]?.sum ?? 0) - Number(reservedRows[0]?.sum ?? 0);
  }

  async getAvailable(warehouseId: string, productId: string): Promise<number> {
    const [onHand, reserved] = await Promise.all([
      this.getOnHand(warehouseId, productId),
      this.getReserved(warehouseId, productId),
    ]);
    return onHand - reserved;
  }

  /**
   * Manager-aware counterpart to `reserveStock` — same idiom as
   * `recordMovement`'s optional `manager` param — so a caller with its
   * OWN transaction (Sales Order creation: CTO directive, "prevent both
   * users from consuming the same available stock", "do NOT implement a
   * simple GET stock -> compare -> save pattern") can reserve every line
   * atomically together with the order/line writes: either the whole
   * order and every line's reservation commits, or none of it does —
   * never a partially-reserved order. `reserveStock` below is now a thin
   * wrapper opening its own transaction, so its existing behavior/tests
   * are unchanged.
   */
  async reserveStockInTransaction(
    manager: EntityManager,
    warehouseId: string,
    productId: string,
    quantity: number,
    salesOrderId: string,
    actorUserId: string | null,
    status: ReservationStatus = 'active',
  ): Promise<StockReservation> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${warehouseId}:${productId}`]);

    const available = await this.getAvailableInTransaction(manager, warehouseId, productId);

    if (available < quantity) {
      throw new ConflictException(
        `Insufficient available stock for product "${productId}" in warehouse "${warehouseId}": requested ${quantity}, available ${available}.`,
      );
    }

    const repo = manager.getRepository(StockReservation);
    const reservation = await repo.save(
      repo.create({ warehouseId, productId, quantity, salesOrderId, status }),
    );

    // Pass this transaction's own manager through — see the pool-
    // exhaustion deadlock this fixed, documented on AuditService.record().
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'inventory.stock.reserved',
        resource: 'stock_reservation',
        resourceId: reservation.id,
        result: 'success',
        correlationId: null,
        after: { warehouseId, productId, quantity, salesOrderId },
      },
      manager,
    );

    return reservation;
  }

  /**
   * The release half of `adjustReservationQuantityInTransaction` below,
   * without a replacement reservation — used when a line is REMOVED
   * entirely from an order (CTO directive — Order Edit at draft: "امكانية
   * اضافة صنف حذف صنف"), not just resized. No-ops if no active/preliminary
   * reservation exists for this (order, product) pair — a line that was
   * never actually reserved (shouldn't happen, but never a hard failure
   * on cleanup) simply has nothing to release.
   */
  async releaseReservationForOrderProductInTransaction(
    manager: EntityManager,
    productId: string,
    salesOrderId: string,
    actorUserId: string | null,
  ): Promise<void> {
    const repo = manager.getRepository(StockReservation);
    const existing = await repo.findOne({
      where: [
        { salesOrderId, productId, status: 'preliminary' },
        { salesOrderId, productId, status: 'active' },
      ],
    });
    if (!existing) return;
    const before = existing.status;
    existing.status = 'released';
    await repo.save(existing);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'inventory.reservation.released',
        resource: 'stock_reservation',
        resourceId: existing.id,
        result: 'success',
        correlationId: null,
        before: { status: before },
        after: { status: 'released', reason: 'order_line_removed' },
      },
      manager,
    );
  }

  /**
   * Order Edit During Review (CTO directive §1: "أي تعديل على الكمية
   * يجب أن يعيد حساب Reservation / Available Stock / Reserved Stock") —
   * releases the line's existing reservation and reserves the new
   * quantity, atomically: both happen under the same advisory lock in
   * the SAME transaction as `reserveStockInTransaction` uses, so if the
   * new quantity isn't available the whole transaction rolls back and
   * the original reservation is restored untouched, never left released
   * with nothing to replace it. Preserves whatever status (preliminary
   * or active) the existing reservation had — an edit never silently
   * promotes or demotes a hold's confirmation state.
   */
  async adjustReservationQuantityInTransaction(
    manager: EntityManager,
    warehouseId: string,
    productId: string,
    salesOrderId: string,
    newQuantity: number,
    actorUserId: string | null,
  ): Promise<StockReservation> {
    const repo = manager.getRepository(StockReservation);
    const existing = await repo.findOne({
      where: [
        { salesOrderId, productId, status: 'preliminary' },
        { salesOrderId, productId, status: 'active' },
      ],
    });
    const previousStatus: ReservationStatus = existing?.status ?? 'preliminary';

    if (existing) {
      existing.status = 'released';
      await repo.save(existing);
    }

    return this.reserveStockInTransaction(manager, warehouseId, productId, newQuantity, salesOrderId, actorUserId, previousStatus);
  }

  /**
   * The concurrency-critical operation: check-then-reserve, serialized
   * per (warehouseId, productId) via advisory lock so two concurrent
   * orders cannot both succeed in reserving stock that isn't jointly
   * available.
   */
  async reserveStock(
    warehouseId: string,
    productId: string,
    quantity: number,
    salesOrderId: string,
    actorUserId: string | null,
    status: ReservationStatus = 'active',
  ): Promise<StockReservation> {
    return this.dataSource.transaction((manager) =>
      this.reserveStockInTransaction(manager, warehouseId, productId, quantity, salesOrderId, actorUserId, status),
    );
  }

  /**
   * Opening-stock Excel import (CTO finalization directive §4: "Any
   * opening stock/import operation must use the appropriate Inventory
   * domain operation") — resolves Warehouse Code / Product SKU to their
   * real ids, then calls `recordMovement` with `movementType: 'receipt'`,
   * the exact same ledger-append operation the Inventory screen's
   * "Record Movement" panel uses. Never writes `stock_movements`
   * directly, and never bypasses the append-only ledger model (ADR-007)
   * just because the entry point is a spreadsheet instead of a form.
   */
  async importOpeningStockRows(
    rows: Array<{ warehouseCode: string; productSku: string; quantity: string }>,
    actorUserId: string | null,
  ): Promise<{ succeeded: StockMovement[]; rejected: Array<{ row: number; errors: string[] }> }> {
    const succeeded: StockMovement[] = [];
    const rejected: Array<{ row: number; errors: string[] }> = [];
    const warehouses = await this.dataSource.getRepository(Warehouse).find();

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const warehouseCode = rows[i].warehouseCode.trim();
      const productSku = rows[i].productSku.trim();
      const quantityText = rows[i].quantity.trim();
      const errors: string[] = [];

      const warehouse = warehouses.find((w) => w.code === warehouseCode);
      const product = productSku ? await this.products.getProductSnapshotBySku(productSku) : null;
      if (!warehouseCode) errors.push('Warehouse Code is required.');
      else if (!warehouse) errors.push(`Warehouse Code "${warehouseCode}" was not found.`);
      if (!productSku) errors.push('Product SKU is required.');
      else if (!product) errors.push(`Product SKU "${productSku}" was not found.`);
      if (!quantityText) errors.push('Quantity is required.');
      else if (!Number.isInteger(Number(quantityText)) || Number(quantityText) <= 0) {
        errors.push(`Quantity "${quantityText}" must be a positive whole number.`);
      }

      if (errors.length > 0) {
        rejected.push({ row: rowNumber, errors });
        continue;
      }

      try {
        succeeded.push(
          await this.recordMovement(warehouse!.id, product!.id, Number(quantityText), 'receipt', 'excel_import', null, actorUserId),
        );
      } catch (err) {
        rejected.push({ row: rowNumber, errors: [err instanceof Error ? err.message : 'Unknown error recording movement.'] });
      }
    }

    return { succeeded, rejected };
  }

  /**
   * Backs the Fulfillment screen's "create fulfillment order" step, AND
   * Fulfillment's own multi-line fix (Foundation Contract note below) —
   * a sales order can have one reservation PER LINE, so this returns
   * every active one, not a single row. Fulfillment derives the
   * fulfillment order's warehouse from these (see FulfillmentService)
   * and fulfills every one of them at pack-verification time.
   */
  async getActiveReservationsForOrder(salesOrderId: string): Promise<StockReservation[]> {
    return this.dataSource
      .getRepository(StockReservation)
      .find({ where: { salesOrderId, status: 'active' }, order: { createdAt: 'ASC' } });
  }

  /**
   * Preliminary Hold -> Reserved (CTO directive §6, "DEPOSIT APPROVAL"):
   * called once by `SalesOrdersService.releaseAfterDepositVerified`,
   * itself called only from `DepositsService.approveDeposit` — Finance
   * approving the deposit IS the control point, no second approval on
   * the Inventory side. Every preliminary reservation for the order is
   * promoted together (an order's lines all confirm atomically, never
   * some lines still on hold while others are reserved).
   */
  async confirmReservationsForOrder(salesOrderId: string, actorUserId: string | null): Promise<void> {
    const repo = this.dataSource.getRepository(StockReservation);
    const holds = await repo.find({ where: { salesOrderId, status: 'preliminary' } });
    for (const hold of holds) {
      hold.status = 'active';
      await repo.save(hold);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'inventory.reservation.confirmed',
        resource: 'stock_reservation',
        resourceId: hold.id,
        result: 'success',
        correlationId: null,
        before: { status: 'preliminary' },
        after: { status: 'active' },
      });
    }
  }

  /**
   * Preliminary Hold -> Free (CTO directive §7, "PRELIMINARY HOLD
   * TIMEOUT"): releases every preliminary reservation for an order,
   * freeing the stock for other orders. Used both by the 24-hour expiry
   * job (`SalesOrdersService.expireHoldForOrder`) and available for a
   * manual release path later — deliberately takes a `reason` so the
   * audit trail always says WHY a hold ended, not just that it did.
   */
  async releasePreliminaryHoldsForOrder(salesOrderId: string, actorUserId: string | null, reason: string): Promise<void> {
    const repo = this.dataSource.getRepository(StockReservation);
    const holds = await repo.find({ where: { salesOrderId, status: 'preliminary' } });
    for (const hold of holds) {
      hold.status = 'released';
      await repo.save(hold);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'inventory.reservation.hold_expired',
        resource: 'stock_reservation',
        resourceId: hold.id,
        result: 'success',
        correlationId: null,
        before: { status: 'preliminary' },
        after: { status: 'released', reason },
      });
    }
  }

  /**
   * Scan side of the 24-hour Preliminary Hold expiry (CTO directive §7:
   * "يجب تنفيذ الـ24 ساعة Server-side وليس بواسطة Frontend Timer") — a
   * pure Inventory-domain read (distinct `salesOrderId`s with at least
   * one preliminary hold older than `olderThan`); the orchestration
   * (releasing the holds + transitioning the order back to draft) lives
   * in `SalesOrdersService`, which already knows the order's process
   * definition — Inventory never depends on Sales Orders.
   */
  async findExpiredPreliminaryHoldOrderIds(olderThan: Date): Promise<string[]> {
    const rows: Array<{ salesOrderId: string }> = await this.dataSource.query(
      `SELECT DISTINCT "salesOrderId" FROM stock_reservations WHERE status = 'preliminary' AND "createdAt" < $1`,
      [olderThan],
    );
    return rows.map((r) => r.salesOrderId);
  }

  /**
   * The auto-provisioned Operational Sub-location lookup (CTO directive
   * "SHIPPING & CUSTODY MANAGEMENT" §4's pattern, reused by Fulfillment's
   * "PRIORITY: ITEM PREPARATION" directive for the "مخزن تحت التجهيز"
   * sub-location) — a thin, generic "does a sub-location with this code
   * prefix already exist under this parent" read, so a caller can decide
   * get-vs-create without duplicating a warehouse row on every call.
   * Matches by code PREFIX rather than a dedicated marker column: this
   * codebase's Numbering Engine already guarantees every prefix is used
   * by exactly one purpose (registered once, never reused), so the
   * prefix itself is a reliable enough discriminator without a schema
   * change to the shared `Warehouse` entity.
   */
  async findOperationalSubLocation(parentWarehouseId: string, codePrefix: string): Promise<Warehouse | null> {
    return this.dataSource.getRepository(Warehouse).findOne({
      where: { parentWarehouseId, kind: 'operational', code: Like(`${codePrefix}%`) },
    });
  }

  /**
   * Preparation stage physical relocation (CTO directive — "PRIORITY:
   * ITEM PREPARATION": "نقل الكمية فعليًا في دورة المخزون من Reserved
   * إلى Preparing/Prepared"). Moves an already-RESERVED quantity from one
   * warehouse row to another (Main -> the "Under Preparation" sub-
   * location) as one atomic unit: the `StockReservation` itself moves
   * with the goods, so the SOURCE warehouse's own Free/Reserved/Available
   * figures stop counting stock that has physically left it, and the
   * DESTINATION's figures start counting it — both from the exact same
   * `getWarehouseInventoryPage`/`getAvailable` formulas every other
   * screen already uses, no separate reporting path.
   *
   * Deliberately NOT routed through `WarehouseTransactionsService`'s
   * normal transfer/availability-check pipeline: that gate answers "is
   * there enough FREE (unreserved) stock to move," which is the wrong
   * question here — this quantity is already committed to this exact
   * order. The correctness guarantee instead comes from validating
   * against the RESERVATION's own remaining active quantity. Still posts
   * through the single ledger (`recordMovement` -> `stock_movements`,
   * the same table every other posting path uses, directive §19) and the
   * single `stock_reservations` table — never a parallel stock system,
   * and never edited from a Sales Order/Fulfillment UI directly.
   */
  async relocateReservedStock(
    salesOrderId: string,
    productId: string,
    fromWarehouseId: string,
    toWarehouseId: string,
    quantity: number,
    referenceType: string,
    referenceId: string,
    actorUserId: string | null,
  ): Promise<void> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConflictException('Relocation quantity must be a positive whole number.');
    }
    if (fromWarehouseId === toWarehouseId) {
      throw new ConflictException('Relocation source and destination warehouse must be different.');
    }

    await this.dataSource.transaction(async (manager) => {
      const lockKeys = [`${fromWarehouseId}:${productId}`, `${toWarehouseId}:${productId}`].sort();
      for (const key of lockKeys) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      }

      const reservationRepo = manager.getRepository(StockReservation);
      const sourceRows = await reservationRepo.find({
        where: { salesOrderId, productId, warehouseId: fromWarehouseId, status: 'active' },
        order: { createdAt: 'ASC' },
      });
      const totalActive = sourceRows.reduce((sum, r) => sum + r.quantity, 0);
      if (totalActive < quantity) {
        throw new ConflictException(
          `Cannot relocate ${quantity} of product "${productId}" for sales order "${salesOrderId}" — only ${totalActive} is actively reserved in warehouse "${fromWarehouseId}".`,
        );
      }

      // Move the reservation itself so it "follows the goods": drain
      // source row(s) first (a fully-drained row is marked `released` —
      // not because the stock was freed for resale, but because its
      // quantity is now zero and its commitment lives on in the
      // destination row created/extended below), then extend an existing
      // destination reservation or create a new one. All under the same
      // advisory lock and transaction as the ledger entries that follow.
      let remainingToMove = quantity;
      for (const row of sourceRows) {
        if (remainingToMove <= 0) break;
        const take = Math.min(row.quantity, remainingToMove);
        row.quantity -= take;
        remainingToMove -= take;
        if (row.quantity === 0) row.status = 'released';
        await reservationRepo.save(row);
      }

      const destinationExisting = await reservationRepo.findOne({
        where: { salesOrderId, productId, warehouseId: toWarehouseId, status: 'active' },
      });
      if (destinationExisting) {
        destinationExisting.quantity += quantity;
        await reservationRepo.save(destinationExisting);
      } else {
        await reservationRepo.save(reservationRepo.create({ salesOrderId, productId, warehouseId: toWarehouseId, quantity, status: 'active' }));
      }

      await this.recordMovement(fromWarehouseId, productId, -quantity, 'transfer_out', referenceType, referenceId, actorUserId, manager);
      await this.recordMovement(toWarehouseId, productId, quantity, 'transfer_in', referenceType, referenceId, actorUserId, manager);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'inventory.reservation.relocated',
          resource: 'stock_reservation',
          resourceId: referenceId,
          result: 'success',
          correlationId: null,
          after: { salesOrderId, productId, fromWarehouseId, toWarehouseId, quantity },
        },
        manager,
      );
    });
  }

  async releaseReservation(reservationId: string, actorUserId: string | null): Promise<void> {
    const repo = this.dataSource.getRepository(StockReservation);
    const reservation = await repo.findOne({ where: { id: reservationId } });
    if (!reservation) throw new NotFoundException(`Reservation "${reservationId}" not found.`);
    if (reservation.status !== 'active') {
      throw new ConflictException(`Cannot release a reservation in status "${reservation.status}".`);
    }
    reservation.status = 'released';
    await repo.save(reservation);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'inventory.reservation.released',
      resource: 'stock_reservation',
      resourceId: reservationId,
      result: 'success',
      correlationId: null,
    });
  }

  /**
   * Partial reservation release (Returns Engine Phase B — Custody Returns):
   * unlike `releaseReservation` (releases one whole reservation row by id)
   * or `releaseReservationForOrderProductInTransaction` (releases an
   * entire order+product reservation, used when a draft order line is
   * removed), a `damaged`/`repair`/`scrap` disposition on a pre-delivery
   * custody return means only the returned QUANTITY of the order's
   * reservation at this warehouse can no longer be fulfilled — the rest,
   * if any, is untouched. Drains active rows the same way
   * `relocateReservedStock` drains its source rows, but never posts a
   * movement itself (the caller posts its own transfer_out/transfer_in
   * pair for the physical disposition).
   */
  async releaseReservedQuantity(
    salesOrderId: string,
    productId: string,
    warehouseId: string,
    quantity: number,
    actorUserId: string | null,
  ): Promise<void> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConflictException('Release quantity must be a positive whole number.');
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${warehouseId}:${productId}`]);

      const repo = manager.getRepository(StockReservation);
      const rows = await repo.find({
        where: { salesOrderId, productId, warehouseId, status: 'active' },
        order: { createdAt: 'ASC' },
      });
      const totalActive = rows.reduce((sum, r) => sum + r.quantity, 0);
      if (totalActive < quantity) {
        throw new ConflictException(
          `Cannot release ${quantity} of product "${productId}" for sales order "${salesOrderId}" — only ${totalActive} is actively reserved in warehouse "${warehouseId}".`,
        );
      }

      let remaining = quantity;
      for (const row of rows) {
        if (remaining <= 0) break;
        const take = Math.min(row.quantity, remaining);
        row.quantity -= take;
        remaining -= take;
        if (row.quantity === 0) row.status = 'released';
        await repo.save(row);
      }

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'inventory.reservation.partially_released',
          resource: 'stock_reservation',
          resourceId: `${salesOrderId}:${productId}:${warehouseId}`,
          result: 'success',
          correlationId: null,
          after: { salesOrderId, productId, warehouseId, quantity },
        },
        manager,
      );
    });
  }

  /**
   * Converts an active reservation into an actual outbound movement — the
   * physical stock reduction, at actual dispatch time. `warehouseIdOverride`
   * defaults to the reservation's own `warehouseId`, but a caller whose
   * goods have since moved via one or more custody transfers (CTO
   * directive — Warehouse/Sales Order Ownership Flow: goods stay company
   * property, moving only between operational locations, until Customer
   * Delivery) must pass where the goods currently sit — see
   * `fulfillReservationsForOrder` below, the intended caller for that case.
   */
  async fulfillReservation(reservationId: string, actorUserId: string | null, warehouseIdOverride?: string): Promise<StockMovement> {
    const reservationRepo = this.dataSource.getRepository(StockReservation);
    const reservation = await reservationRepo.findOne({ where: { id: reservationId } });
    if (!reservation) throw new NotFoundException(`Reservation "${reservationId}" not found.`);
    if (reservation.status !== 'active') {
      throw new ConflictException(`Cannot fulfill a reservation in status "${reservation.status}".`);
    }

    const movement = await this.recordMovement(
      warehouseIdOverride ?? reservation.warehouseId,
      reservation.productId,
      -reservation.quantity,
      'dispatch',
      'sales_order',
      reservation.salesOrderId,
      actorUserId,
    );

    reservation.status = 'fulfilled';
    await reservationRepo.save(reservation);

    return movement;
  }

  /**
   * The final ledger exit for an order's stock (CTO directive — Warehouse/
   * Sales Order Ownership Flow §11/§17: "Financial completion only happens
   * at actual Delivery"; goods are company property, never "sold and gone",
   * until then). Called ONCE, by `DeliveryService.recordOutcome` when the
   * outcome is 'delivered' — deliberately NOT at pack-task completion
   * (Fulfillment's earlier "dispatch at pack time" was a real bug: it
   * removed stock from the ledger before a Shipment/pickup/custody-transfer
   * even existed, so the LATER custody transfer at pickup would then try to
   * move the same already-zeroed quantity again — either failing on
   * insufficient stock or silently drawing down unrelated stock of the same
   * SKU). `currentWarehouseId` is wherever the goods physically sit right
   * now (the custodian's sub-location if one was ever assigned, else the
   * Fulfillment Order's own warehouse — see `ShipmentService.
   * getCurrentCustodyWarehouseId`), not necessarily the reservation's
   * original `warehouseId`.
   */
  async fulfillReservationsForOrder(salesOrderId: string, currentWarehouseId: string, actorUserId: string | null): Promise<void> {
    const reservations = await this.getActiveReservationsForOrder(salesOrderId);
    for (const reservation of reservations) {
      await this.fulfillReservation(reservation.id, actorUserId, currentWarehouseId);
    }
  }

  /**
   * Gap G-2 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md
   * §3B/§4/§21; CTO handover directive §15) — the real "تجميع صاله
   * الانتاج" (assembly, production floor) event: components are consumed
   * and the finished good is produced atomically, in ONE transaction, all
   * within a single warehouse (Daii's flat V1 model has no cross-
   * warehouse component sourcing — every component and the finished
   * good move in the same warehouse, matching the Excel evidence's own
   * mirrored-workbook-same-site pattern). Every product involved
   * (finished + every component) is advisory-locked, sorted, same
   * pattern as `reserveStock` — sorting prevents two concurrent assembly
   * runs with overlapping component sets from deadlocking each other.
   */
  async assembleProduct(
    warehouseId: string,
    finishedProductId: string,
    quantity: number,
    actorUserId: string | null,
  ): Promise<{ assemblyReference: string; finishedGoodMovement: StockMovement; componentMovements: StockMovement[] }> {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ConflictException('Assembly quantity must be a positive whole number.');
    }

    const recipe = await this.bom.getBomForAssembly(finishedProductId);
    if (!recipe || recipe.length === 0) {
      throw new NotFoundException(`No Bill of Materials defined for product "${finishedProductId}".`);
    }

    const assemblyReference = await this.numbering.getNextNumber('assembly');

    return this.dataSource.transaction(async (manager) => {
      const involvedProductIds = [...new Set([finishedProductId, ...recipe.map((r) => r.componentProductId)])].sort();
      for (const productId of involvedProductIds) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${warehouseId}:${productId}`]);
      }

      // Check every component's availability BEFORE writing any movement —
      // an assembly either fully succeeds or writes nothing at all.
      for (const component of recipe) {
        const required = component.quantityPerUnit * quantity;
        const onHandRows: Array<{ sum: string | null }> = await manager.query(
          'SELECT SUM(quantity) as sum FROM stock_movements WHERE "warehouseId" = $1 AND "productId" = $2',
          [warehouseId, component.componentProductId],
        );
        const reservedRows: Array<{ sum: string | null }> = await manager.query(
          `SELECT SUM(quantity) as sum FROM stock_reservations WHERE "warehouseId" = $1 AND "productId" = $2 AND status IN ('active', 'preliminary')`,
          [warehouseId, component.componentProductId],
        );
        const available = Number(onHandRows[0]?.sum ?? 0) - Number(reservedRows[0]?.sum ?? 0);
        if (available < required) {
          throw new ConflictException(
            `Insufficient available stock for component "${component.componentProductId}" in warehouse "${warehouseId}": ` +
              `requested ${required} (${component.quantityPerUnit} x ${quantity}), available ${available}.`,
          );
        }
      }

      const movementRepo = manager.getRepository(StockMovement);
      const componentMovements: StockMovement[] = [];
      for (const component of recipe) {
        const required = component.quantityPerUnit * quantity;
        componentMovements.push(
          await movementRepo.save(
            movementRepo.create({
              warehouseId,
              productId: component.componentProductId,
              quantity: -required,
              movementType: 'assembly_consumption',
              referenceType: 'assembly',
              referenceId: assemblyReference,
              createdByUserId: actorUserId,
            }),
          ),
        );
      }

      const finishedGoodMovement = await movementRepo.save(
        movementRepo.create({
          warehouseId,
          productId: finishedProductId,
          quantity,
          movementType: 'assembly_output',
          referenceType: 'assembly',
          referenceId: assemblyReference,
          createdByUserId: actorUserId,
        }),
      );

      // Pass this transaction's own manager through — see the pool-
      // exhaustion deadlock note on AuditService.record() / reserveStock().
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'inventory.assembly.completed',
          resource: 'stock_movement',
          resourceId: finishedGoodMovement.id,
          result: 'success',
          correlationId: null,
          after: {
            assemblyReference,
            warehouseId,
            finishedProductId,
            quantity,
            components: recipe.map((r) => ({ componentProductId: r.componentProductId, consumed: r.quantityPerUnit * quantity })),
          },
        },
        manager,
      );

      return { assemblyReference, finishedGoodMovement, componentMovements };
    });
  }
}
