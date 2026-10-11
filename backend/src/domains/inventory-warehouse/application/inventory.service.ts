import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource, EntityManager, Like } from 'typeorm';
import { StockMovement } from '../infrastructure/stock-movement.entity';
import { StockReservation, ReservationStatus, ReservationReferenceType } from '../infrastructure/stock-reservation.entity';
import { Warehouse } from '../infrastructure/warehouse.entity';
import { MovementType } from '../domain/movement-type';
import { canTransitionWarehouseStatus, WarehouseStatus } from '../domain/warehouse-status';
import { AuditService } from '../../../foundation/audit/audit.service';
import { runInTransaction } from '../../../foundation/transaction/run-in-transaction';
import {
  SALES_PRODUCTS_CONTRACT,
  SALES_BOM_CONTRACT,
  SalesProductsContract,
  SalesBomContract,
} from '../../../foundation/module-registry/contracts/sales.contract';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { InventoryReservationContract, InventoryLogisticsContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { INVENTORY_EVENT_TOPICS, INVENTORY_VALUATION_CONTRACT, InventoryGlKind, InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';

/**
 * F07 — Inventory Accounting (ADR-040 D2), extended by D3 (2026-10-04, CTO-approved posting policy —
 * `D3-INVENTORY-POSTING-POLICY-2026-10-04.md`). Which stock movements publish `inventory.movement.recorded`, and
 * the `glKind` the accounting handler routes on:
 *   dispatch                                → 'dispatch'      Dr COGS / Cr Inventory (unchanged)
 *   receipt + referenceType 'excel_import'  → 'opening_stock' Dr Inventory / Cr configured Opening Balance (only with a supplied cost)
 *   adjustment                              → 'adjustment'    Dr Inventory / Cr Adjustment Gain  |  Dr Adjustment Loss / Cr Inventory
 *   return_in                               → 'return_in'     D4: carries the ORIGINAL cost → Dr Inventory / Cr COGS (via `recordSaleReturnIn`); without a carried cost the handler REJECTS
 *   receipt + referenceType 'manual_receipt' → 'manual_receipt' Dr Inventory / Cr the offset account CONFIGURED for the receipt's reason code (D3-B;
 *                                              only `recordManualReceipt` produces this referenceType, and it demands cost + reason)
 * A Goods Receipt (`receipt` + 'goods_receipt') is NOT published here — its own GRNI event already posts it.
 * Transfers never post to GL (Model A — one central Inventory control account).
 */
/** D3-B — reserved `stock_movements.referenceType` of a policy-validated manual receipt (set only by `recordManualReceipt`). */
export const MANUAL_RECEIPT_REFERENCE_TYPE = 'manual_receipt';

function glKindFor(movementType: MovementType, referenceType: string | null, unitCostBase: string | null | undefined): InventoryGlKind | null {
  if (movementType === 'dispatch') return 'dispatch';
  if (movementType === 'adjustment') return 'adjustment';
  if (movementType === 'return_in') return 'return_in';
  if (movementType === 'receipt' && referenceType === 'excel_import' && unitCostBase != null && unitCostBase !== '') return 'opening_stock';
  if (movementType === 'receipt' && referenceType === MANUAL_RECEIPT_REFERENCE_TYPE && unitCostBase != null && unitCostBase !== '') return 'manual_receipt';
  return null;
}

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
export class InventoryService implements InventoryReservationContract, InventoryLogisticsContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    @Inject(SALES_PRODUCTS_CONTRACT) private readonly products: SalesProductsContract,
    @Inject(SALES_BOM_CONTRACT) private readonly bom: SalesBomContract,
    private readonly numbering: NumberingService,
    private readonly events: EventBusService,
    // F08 (ADR-041 D18c) — the ONE approved opening-stock/receipt cost-input flow (D3/D7/D20).
    // `@Optional()` — F08 may not be entitled/wired in every installation; when unbound, `recordMovement`
    // behaves exactly as before (a supplied `unitCostBase` is simply never applied).
    @Optional() @Inject(INVENTORY_VALUATION_CONTRACT) private readonly valuation?: InventoryValuationContract,
    // D3-B — the manual-receipt pre-mutation gate, bound by `accounting` (foundation holder; no module cycle).
    // Unbound ⇒ no accounting installed ⇒ a manual receipt cannot be validated and is rejected (fail-closed).
    @Optional() private readonly postingPolicy?: InventoryPostingPolicyRegistry,
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
    manager?: EntityManager,
    /** F6 — optional link to the organization unit (branch / warehouse unit) that owns the warehouse (the scope key). */
    orgUnitId: string | null = null,
  ): Promise<Warehouse> {
    const repo = (manager ?? this.dataSource).getRepository(Warehouse);
    const existing = await repo.findOne({ where: { code } });
    if (existing) throw new ConflictException(`Warehouse with code "${code}" already exists.`);
    if (orgUnitId) await this.assertOrgUnitExists(orgUnitId, manager);
    return repo.save(repo.create({ code, name, location, responsibleUserId, parentWarehouseId, kind, status: 'active', orgUnitId }));
  }

  private async assertOrgUnitExists(orgUnitId: string, manager?: EntityManager): Promise<void> {
    const rows: unknown[] = await (manager ?? this.dataSource).query(`SELECT 1 FROM "org_units" WHERE "id" = $1`, [orgUnitId]);
    if (rows.length === 0) throw new BadRequestException(`Organization unit "${orgUnitId}" not found.`);
  }

  /** F6 — links (or, with `null`, unlinks) a warehouse to an organization unit: the scope key of the pilot domains. Audited. The caller has already been checked against the warehouse's CURRENT and the NEW unit. */
  async setWarehouseOrgUnit(warehouseId: string, orgUnitId: string | null, actorUserId: string | null, manager?: EntityManager): Promise<Warehouse> {
    const warehouse = await this.getWarehouse(warehouseId, manager);
    if (orgUnitId) await this.assertOrgUnitExists(orgUnitId, manager);
    const before = { orgUnitId: warehouse.orgUnitId ?? null };
    warehouse.orgUnitId = orgUnitId;
    const saved = await (manager ?? this.dataSource).getRepository(Warehouse).save(warehouse);
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'inventory.warehouse.org_unit_changed', resource: 'warehouse', resourceId: warehouseId, result: 'success', correlationId: null, before, after: { orgUnitId } },
      manager,
    );
    return saved;
  }

  async listWarehouses(manager?: EntityManager): Promise<Warehouse[]> {
    return (manager ?? this.dataSource).getRepository(Warehouse).find();
  }

  /**
   * F-INV-001 — an HTTP movement request must name a warehouse and a product that exist in THIS Company: otherwise the insert dies on the foreign key (HTTP 500).
   * Resolved before any write → 404 (same contract as the other warehouse-referencing writes). A malformed id is "not found", never a database error.
   */
  async assertMovementTargetsExist(warehouseId: string, productId: string, manager: EntityManager): Promise<void> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID.test(warehouseId)) throw new NotFoundException(`Warehouse "${warehouseId}" not found.`);
    await this.getWarehouse(warehouseId, manager);
    const found: Array<{ id: string }> = UUID.test(productId) ? await manager.query(`SELECT id FROM "products" WHERE id = $1::uuid`, [productId]) : [];
    if (found.length === 0) throw new NotFoundException(`Product "${productId}" not found.`);
  }

  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added. */
  async getWarehouse(warehouseId: string, manager?: EntityManager): Promise<Warehouse> {
    const warehouse = await (manager ?? this.dataSource).getRepository(Warehouse).findOne({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException(`Warehouse "${warehouseId}" not found.`);
    return warehouse;
  }

  /** Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — active/inactive toggle, audited like every other status change in this codebase. */
  async setWarehouseStatus(warehouseId: string, status: WarehouseStatus, actorUserId: string | null, manager?: EntityManager): Promise<Warehouse> {
    const warehouse = await this.getWarehouse(warehouseId, manager);
    if (!canTransitionWarehouseStatus(warehouse.status, status)) {
      throw new ConflictException(`Cannot transition warehouse from "${warehouse.status}" to "${status}".`);
    }
    const before = { status: warehouse.status };
    warehouse.status = status;
    const saved = await (manager ?? this.dataSource).getRepository(Warehouse).save(warehouse);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'inventory.warehouse.status_changed',
        resource: 'warehouse',
        resourceId: warehouseId,
        result: 'success',
        correlationId: null,
        before,
        after: { status },
      },
      manager,
    );
    return saved;
  }

  /** Excel import (CTO finalization directive §3/§4) — enters through the same `createWarehouse` call the UI uses, per row. */
  async importWarehouseRows(
    rows: Array<{ code: string; name: string }>,
    manager?: EntityManager,
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
        succeeded.push(await this.createWarehouse(code, name, null, null, null, 'main', manager));
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
    // F08 (ADR-041 D3/D7/D20/D18c) — the ONE approved opening-stock/receipt cost-input field.
    // Additive, optional, last-positioned — every existing caller is unaffected. Applied ONLY when
    // `movementType === 'receipt'` AND F08 is bound; ignored for every other movement type (a
    // dispatch's cost is ALWAYS sourced from the running weighted average, never a caller-supplied
    // value — that rule is structural, `CostEngine.applyIssue` takes no cost parameter at all).
    unitCostBase?: string | null,
    // D3-B — carried on the event of a 'manual_receipt' only (set by `recordManualReceipt`).
    reasonCode?: string | null,
  ): Promise<StockMovement> {
    // F07-H1 (ADR-040 D9, CTO Mandatory Condition 4) — when the caller
    // supplies no transaction of its own, open one here so the
    // StockMovement insert and (when gated below) the
    // `inventory.movement.recorded` outbox row commit or roll back
    // together — the same transactional-outbox guarantee every other
    // publisher in this codebase relies on (`EventBusService.publish`'s
    // own contract: "writes the outbox row using the CALLER's transaction
    // manager"). A caller that already owns a transaction (passes its own
    // `manager`) keeps that same atomicity unchanged.
    if (!manager) {
      return this.dataSource.transaction((txManager) =>
        this.recordMovement(warehouseId, productId, quantity, movementType, referenceType, referenceId, actorUserId, txManager, unitCostBase, reasonCode),
      );
    }

    const repo = manager.getRepository(StockMovement);
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

    // F08 (ADR-041 D3/D7/D20/D18c) — the receipt-side valuation bootstrap. Same transaction as the
    // StockMovement insert above (atomic); never posts to GL (D7/D20 — a receipt has no accounting
    // entry, only a valuation-subledger one). Silently a no-op when F08 is not bound or no cost was
    // supplied — zero behavior change from before this field existed.
    if ((movementType === 'receipt' || movementType === 'return_in') && unitCostBase != null && this.valuation) {
      await this.valuation.recordReceiptCost(productId, warehouseId, quantity, unitCostBase, `inventory-valuation:receipt:${movement.id}`, manager);
    }

    // F07-H1 (ADR-040 D2/D3) — publish only the allow-listed movement types (`dispatch`, always a
    // negative quantity — never this method's `receipt`/`unitCostBase` branch above). Cost fields on
    // THIS payload stay always null even after F08 (ADR-041 D18/D18a) — F08's handler bridge
    // (`InventoryCostingHandlerService`) sources cost independently via `INVENTORY_VALUATION_CONTRACT`
    // at ingest time, never from this payload; fail-closed (`no_valuation_source`) when unavailable.
    const glKind = glKindFor(movementType, referenceType, unitCostBase);
    // The kinds whose COST is an input resolved BEFORE the movement (every other kind resolves cost from the valuation engine at ingest).
    const carriesCost = glKind === 'opening_stock' || glKind === 'manual_receipt' || (glKind === 'return_in' && unitCostBase != null && unitCostBase !== '');
    if (glKind) {
      await this.events.publish(manager, INVENTORY_EVENT_TOPICS.movementRecorded, {
        idempotencyKey: `inventory:movement:${movement.id}:recorded`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null,
        sourceEntityType: 'stock_movement',
        sourceEntityId: movement.id,
        externalDocument: null,
        payloadVersion: 1,
        movementType,
        glKind,
        productId,
        warehouseId,
        quantity,
        referenceType,
        referenceId,
        // opening stock only: the maker-SUPPLIED cost (an input); every other kind resolves cost from the valuation engine at ingest.
        unitCostBase: carriesCost ? String(unitCostBase) : null,
        totalCostBase: carriesCost ? (Number(quantity) * Number(unitCostBase)).toFixed(4) : null,
        reasonCode: glKind === 'manual_receipt' ? (reasonCode ?? null) : null,
      });
    }

    return movement;
  }

  /**
   * D3-B (2026-10-04, CTO-approved Manual Receipt policy) — the ONLY way a manual receipt enters stock. It needs an
   * explicit positive `unitCostBase` (no moving-average / last-purchase / estimated fallback) and a controlled
   * `reasonCode` whose configured offset GL account is valid. EVERYTHING is validated before the first write, so a
   * rejection leaves stock, valuation and the outbox untouched. Valuation is bootstrapped at the supplied cost and the
   * event posts Dr Inventory / Cr the reason-configured account for quantity × unit cost.
   */
  async recordManualReceipt(
    warehouseId: string,
    productId: string,
    quantity: number,
    unitCostBase: string | number | null | undefined,
    reasonCode: string | null | undefined,
    referenceId: string | null,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<StockMovement> {
    if (!manager) {
      return this.dataSource.transaction((tx) =>
        this.recordManualReceipt(warehouseId, productId, quantity, unitCostBase, reasonCode, referenceId, actorUserId, tx),
      );
    }
    if (!Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException('A manual receipt quantity must be a positive number');
    const cost = unitCostBase == null || String(unitCostBase).trim() === '' ? NaN : Number(unitCostBase);
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new BadRequestException('A manual receipt requires an explicit unit cost greater than zero (no fallback cost is used)');
    }
    const code = (reasonCode ?? '').trim();
    if (!code) throw new BadRequestException('A manual receipt requires a reason code');
    const policy = this.postingPolicy?.get();
    if (!policy) throw new ConflictException('Manual receipts cannot be validated: the accounting posting policy is not available');
    await policy.assertManualReceiptReason(code, manager);
    return this.recordMovement(
      warehouseId,
      productId,
      quantity,
      'receipt',
      MANUAL_RECEIPT_REFERENCE_TYPE,
      referenceId,
      actorUserId,
      manager,
      cost.toFixed(4),
      code,
    );
  }

  /**
   * D4 (2026-10-05) — the ORIGINAL cost of a sold product: the cost the order's dispatch movements were actually charged
   * (`inventory_valuation_movements` `issue` rows, looked up by the dispatch event's idempotency key). Returns
   * `unitCostBase` = Σ issue value ÷ Σ issue quantity. `null` — and the caller must FAIL CLOSED — when the order has no
   * dispatch of that product, when valuation is not bound, or when ANY of those dispatches has no costed issue row yet
   * (its GL event was rejected / is still pending). Never a current average, never a last purchase cost.
   */
  async resolveOriginalSaleCost(salesOrderId: string, productId: string, manager?: EntityManager): Promise<{ unitCostBase: string; quantity: number } | null> {
    if (!this.valuation) return null;
    const runner = manager ?? this.dataSource;
    const dispatches: Array<{ id: string }> = await runner.query(
      `SELECT "id" FROM "stock_movements"
        WHERE "movementType" = 'dispatch' AND "referenceType" = 'sales_order' AND "referenceId"::text = $1 AND "productId"::text = $2`,
      [salesOrderId, productId],
    );
    if (dispatches.length === 0) return null;
    const keys = dispatches.map((d) => `inventory:movement:${d.id}:recorded`);
    const costs = await this.valuation.getIssueCostsByKeys(keys, manager);
    if (costs.length !== keys.length) return null; // at least one dispatch was never (successfully) costed
    const quantity = costs.reduce((s, c) => s + c.quantity, 0);
    const value = costs.reduce((s, c) => s + Number(c.valueBase), 0);
    if (!(quantity > 0) || !(value > 0)) return null;
    return { unitCostBase: (value / quantity).toFixed(4), quantity };
  }

  /**
   * D4 (2026-10-05) — the ONLY way returned stock re-enters the ledger financially: a `return_in` at the ORIGINAL cost
   * (resolved by the caller BEFORE any write). Valuation is restored at that unit cost and the movement event carries the
   * cost so the GL posts `Dr Inventory / Cr COGS`. A missing/non-positive cost is rejected — no fallback cost.
   */
  async recordSaleReturnIn(
    warehouseId: string,
    productId: string,
    quantity: number,
    unitCostBase: string,
    referenceType: 'sales_return' | 'shipment_return',
    referenceId: string,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<StockMovement> {
    if (!Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException('A sale-return quantity must be a positive number');
    if (!(Number(unitCostBase) > 0)) throw new BadRequestException('A sale return requires the original unit cost (no fallback cost is used)');
    return this.recordMovement(warehouseId, productId, quantity, 'return_in', referenceType, referenceId, actorUserId, manager, Number(unitCostBase).toFixed(4));
  }

  /** D3-B — the reason codes that currently have a configured offset account (what a UI may offer). */
  listManualReceiptReasons(): string[] {
    return this.postingPolicy?.get()?.listManualReceiptReasons() ?? [];
  }

  /**
   * D3 (2026-10-04) — THE paired transfer: `transfer_out` + `transfer_in` + valuation carry. Model A (one central
   * Inventory control account): NO GL journal — value moves between warehouse valuation ledgers at the SOURCE's
   * moving-average cost, so total company valuation is unchanged. If the source has no usable valuation state the
   * physical transfer still proceeds and no cost is carried (never blocks an operational move). `manager` must be the
   * caller's open transaction.
   */
  async recordTransfer(
    fromWarehouseId: string,
    toWarehouseId: string,
    productId: string,
    quantity: number,
    referenceType: string | null,
    referenceId: string | null,
    actorUserId: string | null,
    manager: EntityManager,
  ): Promise<void> {
    const out = await this.recordMovement(fromWarehouseId, productId, -quantity, 'transfer_out', referenceType, referenceId, actorUserId, manager);
    await this.recordMovement(toWarehouseId, productId, quantity, 'transfer_in', referenceType, referenceId, actorUserId, manager);
    if (!this.valuation) return;
    const consumed = await this.valuation.consumeIssueCost(productId, fromWarehouseId, quantity, `inventory-valuation:transfer-out:${out.id}`, manager);
    if (consumed && !('rejected' in consumed)) {
      await this.valuation.recordReceiptCost(productId, toWarehouseId, quantity, consumed.unitCostBase, `inventory-valuation:transfer-in:${out.id}`, manager);
    }
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
  /**
   * ADR-061 (Manufacturing) — raw physical on-hand quantity for a
   * (warehouse, product) pair, with NO reservation subtracted (unlike
   * `getAvailableInTransaction`). Needed because a Work Order's dedicated
   * WIP sub-warehouse never itself carries reservations — "on hand" and
   * "available" are the same number there, but Manufacturing's guards
   * (ADR-061 §5/§7) are phrased in terms of physical on-hand quantity
   * specifically, not availability net of a reservation concept that
   * doesn't apply inside WIP.
   */
  async getOnHandQuantityInTransaction(manager: EntityManager, warehouseId: string, productId: string): Promise<number> {
    const rows: Array<{ sum: string | null }> = await manager.query(
      'SELECT SUM(quantity) as sum FROM stock_movements WHERE "warehouseId" = $1 AND "productId" = $2',
      [warehouseId, productId],
    );
    return Number(rows[0]?.sum ?? 0);
  }

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
  async getMovement(movementId: string, manager?: EntityManager): Promise<StockMovement> {
    const movement = await (manager ?? this.dataSource).getRepository(StockMovement).findOne({ where: { id: movementId } });
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
  async listMovements(
    filters: {
      warehouseId?: string;
      productId?: string;
      movementType?: string;
      dateFrom?: string;
      dateTo?: string;
      /** F6 — the caller's visible warehouses (omit for unrestricted): movements of any other warehouse are never returned. */
      visibleWarehouseIds?: string[];
    },
    manager?: EntityManager,
  ): Promise<StockMovement[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.visibleWarehouseIds) {
      params.push(filters.visibleWarehouseIds);
      conditions.push(`"warehouseId" = ANY($${params.length}::uuid[])`);
    }
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
    return (manager ?? this.dataSource).query(
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
    manager?: EntityManager,
    /** F6 — the caller's visible warehouses (omit for unrestricted): filtered BEFORE aggregation. */
    visibleWarehouseIds?: string[],
  ): Promise<Array<{ warehouseId: string; productId: string; onHand: number; reserved: number; available: number }>> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (warehouseId) {
      params.push(warehouseId);
      where.push(`"warehouseId" = $${params.length}`);
    }
    if (visibleWarehouseIds) {
      params.push(visibleWarehouseIds);
      where.push(`"warehouseId" = ANY($${params.length}::uuid[])`);
    }
    const onHandRows: Array<{ warehouseId: string; productId: string; sum: string }> = await (manager ?? this.dataSource).query(
      `SELECT "warehouseId", "productId", SUM(quantity) as sum FROM stock_movements
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY "warehouseId", "productId"`,
      params,
    );
    const reservedRows: Array<{ warehouseId: string; productId: string; sum: string }> = await (manager ?? this.dataSource).query(
      `SELECT "warehouseId", "productId", SUM(quantity) as sum FROM stock_reservations
       WHERE status IN ('active', 'preliminary') ${where.length ? 'AND ' + where.join(' AND ') : ''}
       GROUP BY "warehouseId", "productId"`,
      params,
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
    options: { search?: string; page: number; pageSize: number; sortBy?: string; sortDir?: 'asc' | 'desc'; scope?: 'assigned' | 'all' },
    manager?: EntityManager,
  ): Promise<{
    rows: Array<{
      /** D1 — whether the item is assigned to this warehouse (an unassigned row only appears in the `assigned` scope when it still holds stock/reservations). */
      assigned: boolean;
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

    // D1 (2026-10-05) — scope. `assigned` (default): the items assigned to this warehouse PLUS any item that still has a
    // non-zero stock/reservation row here (flagged `assigned = false` — stock is never silently hidden). `all`: the whole catalogue.
    const scopeClause =
      options.scope === 'all'
        ? ''
        : `AND (wi.id IS NOT NULL OR COALESCE(m.on_hand, 0) <> 0 OR COALESCE(r.preliminary_hold, 0) + COALESCE(r.reserved, 0) <> 0)`;

    const fromAndWhere = `
      FROM products p
      LEFT JOIN "warehouse_items" wi ON wi."productId" = p.id AND wi."warehouseId" = $1
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
      ${scopeClause}
    `;

    const countRows: Array<{ count: string }> = await (manager ?? this.dataSource).query(`SELECT COUNT(*) as count ${fromAndWhere}`, [warehouseId, search]);

    const rows: Array<{
      assigned: boolean;
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
    }> = await (manager ?? this.dataSource).query(
      `SELECT p.id as "productId", p.sku, p.name, p.unit, p.status, (wi.id IS NOT NULL) as assigned,
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
        assigned: r.assigned === true,
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

  /**
   * D1 (2026-10-05, CTO policy: Default/Origin Warehouse, transferable) — mark items as belonging to a warehouse as their
   * DEFAULT / ORIGIN (master data; bulk, idempotent). It is NOT a restriction and NOT evidence that the item is there now: where
   * stock is, is always `SUM(stock_movements)` and items move freely by Transfer. Unknown warehouse/product ⇒ rejected before any write.
   */
  async assignItems(warehouseId: string, productIds: string[], actorUserId: string | null, manager?: EntityManager): Promise<{ requested: number; assigned: number; alreadyAssigned: number }> {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) throw new BadRequestException('At least one item is required.');
    const runner = manager ?? this.dataSource;
    await this.getWarehouse(warehouseId, manager);
    const found: Array<{ id: string }> = await runner.query(`SELECT id FROM "products" WHERE id = ANY($1::uuid[])`, [unique]);
    if (found.length !== unique.length) {
      const known = new Set(found.map((f) => f.id));
      throw new NotFoundException(`Unknown item(s): ${unique.filter((id) => !known.has(id)).join(', ')}`);
    }
    const inserted: Array<{ id: string }> = await runner.query(
      `INSERT INTO "warehouse_items" ("warehouseId", "productId", "assignedByUserId")
       SELECT $1::uuid, x, $3::uuid FROM unnest($2::uuid[]) AS x
       ON CONFLICT ("warehouseId", "productId") DO NOTHING
       RETURNING "id"`,
      [warehouseId, unique, actorUserId],
    );
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'inventory.warehouse_items.assigned', resource: 'warehouse', resourceId: warehouseId, result: 'success', correlationId: null, after: { requested: unique.length, assigned: inserted.length } },
      manager,
    );
    return { requested: unique.length, assigned: inserted.length, alreadyAssigned: unique.length - inserted.length };
  }

  /**
   * D1 — remove an item's default/origin marker. Always allowed: it is metadata, not stock. If the item still holds stock here it
   * simply shows up in this warehouse's grid as "holds stock, not a default" (the ledger is the truth).
   */
  async unassignItem(warehouseId: string, productId: string, actorUserId: string | null, manager?: EntityManager): Promise<{ removed: boolean }> {
    await this.getWarehouse(warehouseId, manager);
    // CTE count: a raw DELETE ... RETURNING comes back from the driver as [rows, rowCount], so count explicitly.
    const [{ n }]: Array<{ n: number }> = await (manager ?? this.dataSource).query(
      `WITH d AS (DELETE FROM "warehouse_items" WHERE "warehouseId" = $1 AND "productId" = $2 RETURNING "id") SELECT count(*)::int AS n FROM d`,
      [warehouseId, productId],
    );
    if (n > 0) {
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'inventory.warehouse_items.unassigned', resource: 'warehouse', resourceId: warehouseId, result: 'success', correlationId: null, after: { productId } },
        manager,
      );
    }
    return { removed: n > 0 };
  }

  async getOnHand(warehouseId: string, productId: string, manager?: EntityManager): Promise<number> {
    const result: Array<{ sum: string | null }> = await (manager ?? this.dataSource).query(
      'SELECT SUM(quantity) as sum FROM stock_movements WHERE "warehouseId" = $1 AND "productId" = $2',
      [warehouseId, productId],
    );
    return Number(result[0]?.sum ?? 0);
  }

  async getReserved(warehouseId: string, productId: string, manager?: EntityManager): Promise<number> {
    const result: Array<{ sum: string | null }> = await (manager ?? this.dataSource).query(
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

  async getAvailable(warehouseId: string, productId: string, manager?: EntityManager): Promise<number> {
    const [onHand, reserved] = await Promise.all([
      this.getOnHand(warehouseId, productId, manager),
      this.getReserved(warehouseId, productId, manager),
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
   * ADR-061 (Manufacturing) — the generic-reference twin of
   * `reserveStockInTransaction` above, for callers that are not a Sales
   * Order (Work Order release, per ADR-061 §5). Same availability check,
   * same advisory lock, same audit action — the only difference is which
   * addressing column is populated (`referenceType`/`referenceId` instead
   * of `salesOrderId`), enforced at the DB level by
   * `CHK_stock_reservations_reference_xor`. Not a second reservation
   * mechanism — the same `stock_reservations` table, the same
   * `getAvailableInTransaction` availability calc (which already
   * aggregates by `(warehouseId, productId, status)` regardless of which
   * reference column is set).
   */
  async reserveStockForReferenceInTransaction(
    manager: EntityManager,
    warehouseId: string,
    productId: string,
    quantity: number,
    referenceType: ReservationReferenceType,
    referenceId: string,
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
      repo.create({ warehouseId, productId, quantity, referenceType, referenceId, status }),
    );

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'inventory.stock.reserved',
        resource: 'stock_reservation',
        resourceId: reservation.id,
        result: 'success',
        correlationId: null,
        after: { warehouseId, productId, quantity, referenceType, referenceId },
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
    manager?: EntityManager,
  ): Promise<StockReservation> {
    return (manager ?? this.dataSource).transaction((txManager) =>
      this.reserveStockInTransaction(txManager, warehouseId, productId, quantity, salesOrderId, actorUserId, status),
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
   *
   * Finding F-1 fix (CTO directive, 2026-09-12): `unitCost` is now
   * REQUIRED — a row with a missing or non-positive cost is REJECTED,
   * never defaulted/guessed, so the quantity this import creates is
   * never invisible to F08's Moving Average valuation subledger the way
   * it silently was before this fix. `recordMovement`'s own signature
   * and the general receipt/dispatch mechanism are UNCHANGED — this
   * method simply now supplies the `unitCostBase` argument that method
   * already accepted but this caller never passed (ADR-041 D18c/D20).
   * No GL/Financial Event/FA-01 is introduced here — a `'receipt'`
   * movement still never reaches the F03 posting gate (ADR-040 D2),
   * unchanged.
   *
   * Duplicate-import protection (per the CTO's explicit verification
   * requirement): an opening-stock import is, by its own business
   * meaning, a ONE-TIME event per `(warehouseId, productId)` — any
   * further stock change is a real, separate business event (a future,
   * out-of-scope phase), never a second "opening balance." Each row is
   * therefore processed inside its OWN transaction that first checks for
   * an existing `excel_import`-sourced receipt for that exact pair
   * before calling `recordMovement` (passed that same transaction's
   * manager) — no new column/constraint, a plain read against columns
   * `stock_movements` already has. This is a check-then-act, not a
   * DB-constraint-enforced guarantee — an accepted limitation for a
   * rare, low-frequency, admin-run onboarding action, the same shape
   * `FiscalPeriodService.activateFiscalYear` already documents and
   * accepts for a comparable rare admin action — sufficient for the
   * realistic case this import is used for (uploading a file once, or
   * re-uploading the same file after the fact), not for true concurrent
   * double-submission.
   */
  async importOpeningStockRows(
    rows: Array<{ warehouseCode: string; productSku: string; quantity: string; unitCost: string }>,
    actorUserId: string | null,
    manager?: EntityManager,
    /** F6 — the caller's visible warehouses (omit / 'ALL' for unrestricted): a row naming any other warehouse is rejected exactly like an unknown code (no enumeration). */
    visibleWarehouseIds?: 'ALL' | string[],
  ): Promise<{ succeeded: StockMovement[]; rejected: Array<{ row: number; errors: string[] }> }> {
    const succeeded: StockMovement[] = [];
    const rejected: Array<{ row: number; errors: string[] }> = [];
    const allWarehouses = await (manager ?? this.dataSource).getRepository(Warehouse).find();
    const warehouses = !visibleWarehouseIds || visibleWarehouseIds === 'ALL' ? allWarehouses : allWarehouses.filter((w) => visibleWarehouseIds.includes(w.id));

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const warehouseCode = rows[i].warehouseCode.trim();
      const productSku = rows[i].productSku.trim();
      const quantityText = rows[i].quantity.trim();
      const unitCostText = (rows[i].unitCost ?? '').trim();
      const errors: string[] = [];

      const warehouse = warehouses.find((w) => w.code === warehouseCode);
      const product = productSku ? await this.products.getProductSnapshotBySku(productSku, manager) : null;
      if (!warehouseCode) errors.push('Warehouse Code is required.');
      else if (!warehouse) errors.push(`Warehouse Code "${warehouseCode}" was not found.`);
      if (!productSku) errors.push('Product SKU is required.');
      else if (!product) errors.push(`Product SKU "${productSku}" was not found.`);
      if (!quantityText) errors.push('Quantity is required.');
      else if (!Number.isInteger(Number(quantityText)) || Number(quantityText) <= 0) {
        errors.push(`Quantity "${quantityText}" must be a positive whole number.`);
      }
      // F-1 fix — required, never defaulted/guessed (CTO directive: no default cost, no fallback).
      if (!unitCostText) errors.push('Unit Cost is required.');
      else if (Number.isNaN(Number(unitCostText)) || Number(unitCostText) <= 0) {
        errors.push(`Unit Cost "${unitCostText}" must be a positive number.`);
      }

      if (errors.length > 0) {
        rejected.push({ row: rowNumber, errors });
        continue;
      }

      try {
        succeeded.push(
          await (manager ?? this.dataSource).transaction(async (txManager) => {
            const existing = await txManager.getRepository(StockMovement).findOne({
              where: { warehouseId: warehouse!.id, productId: product!.id, movementType: 'receipt', referenceType: 'excel_import' },
            });
            if (existing) {
              throw new ConflictException(
                `Opening stock has already been imported for Warehouse Code "${warehouseCode}" / Product SKU "${productSku}" ` +
                  `(existing movement ${existing.id}). Use a future adjustment/receipt path for further changes, not a second opening-stock import.`,
              );
            }
            return this.recordMovement(
              warehouse!.id,
              product!.id,
              Number(quantityText),
              'receipt',
              'excel_import',
              null,
              actorUserId,
              txManager,
              unitCostText,
            );
          }),
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
  async getActiveReservationsForOrder(salesOrderId: string, manager?: EntityManager): Promise<StockReservation[]> {
    return (manager ?? this.dataSource)
      .getRepository(StockReservation)
      .find({ where: { salesOrderId, status: 'active' }, order: { createdAt: 'ASC' } });
  }

  /** ADR-061 (Manufacturing) — the generic-reference twin of `getActiveReservationsForOrder` above. */
  async getActiveReservationsForReference(referenceType: ReservationReferenceType, referenceId: string): Promise<StockReservation[]> {
    return this.dataSource
      .getRepository(StockReservation)
      .find({ where: { referenceType, referenceId, status: 'active' }, order: { createdAt: 'ASC' } });
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
  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added and threaded into the `audit.record` call, per §14.5's rule. */
  async confirmReservationsForOrder(salesOrderId: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? this.dataSource).getRepository(StockReservation);
    const holds = await repo.find({ where: { salesOrderId, status: 'preliminary' } });
    for (const hold of holds) {
      hold.status = 'active';
      await repo.save(hold);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'inventory.reservation.confirmed',
          resource: 'stock_reservation',
          resourceId: hold.id,
          result: 'success',
          correlationId: null,
          before: { status: 'preliminary' },
          after: { status: 'active' },
        },
        manager,
      );
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
  async releasePreliminaryHoldsForOrder(salesOrderId: string, actorUserId: string | null, reason: string, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? this.dataSource).getRepository(StockReservation);
    const holds = await repo.find({ where: { salesOrderId, status: 'preliminary' } });
    for (const hold of holds) {
      hold.status = 'released';
      await repo.save(hold);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'inventory.reservation.hold_expired',
          resource: 'stock_reservation',
          resourceId: hold.id,
          result: 'success',
          correlationId: null,
          before: { status: 'preliminary' },
          after: { status: 'released', reason },
        },
        manager,
      );
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
  async findExpiredPreliminaryHoldOrderIds(olderThan: Date, manager?: EntityManager): Promise<string[]> {
    const rows: Array<{ salesOrderId: string }> = await (manager ?? this.dataSource).query(
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
  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added — called cross-domain from `ShipmentService`/`ReturnsService` via `InventoryLogisticsContract`. */
  async findOperationalSubLocation(parentWarehouseId: string, codePrefix: string, manager?: EntityManager): Promise<Warehouse | null> {
    return (manager ?? this.dataSource).getRepository(Warehouse).findOne({
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
  /**
   * Gap Resolution Package 3 (2026-09-14, row 37) — `manager?` added so `ReturnsService.recordDisposition`
   * can make this call part of its one atomic operation instead of an independent transaction (this
   * was one of only two calls in the whole atomicity package with no manager-threading capability at
   * all before this change). `manager ? run(manager) : dataSource.transaction(run)` — the standard
   * idiom used throughout this package; the advisory locks are taken unconditionally inside `run`
   * either way (`pg_advisory_xact_lock` is safely re-entrant within the same transaction).
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
    manager?: EntityManager,
  ): Promise<void> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConflictException('Relocation quantity must be a positive whole number.');
    }
    if (fromWarehouseId === toWarehouseId) {
      throw new ConflictException('Relocation source and destination warehouse must be different.');
    }

    const run = async (m: EntityManager): Promise<void> => {
      const lockKeys = [`${fromWarehouseId}:${productId}`, `${toWarehouseId}:${productId}`].sort();
      for (const key of lockKeys) {
        await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      }

      const reservationRepo = m.getRepository(StockReservation);
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

      await this.recordTransfer(fromWarehouseId, toWarehouseId, productId, quantity, referenceType, referenceId, actorUserId, m);

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
        m,
      );
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  async releaseReservation(reservationId: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? this.dataSource).getRepository(StockReservation);
    const reservation = await repo.findOne({ where: { id: reservationId } });
    if (!reservation) throw new NotFoundException(`Reservation "${reservationId}" not found.`);
    if (reservation.status !== 'active') {
      throw new ConflictException(`Cannot release a reservation in status "${reservation.status}".`);
    }
    reservation.status = 'released';
    await repo.save(reservation);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'inventory.reservation.released',
        resource: 'stock_reservation',
        resourceId: reservationId,
        result: 'success',
        correlationId: null,
      },
      manager,
    );
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
  /**
   * Gap Resolution Package 3 (2026-09-14, row 37) — `manager?` added so `ReturnsService.recordDisposition`
   * can make this call part of its one atomic operation instead of an independent transaction.
   */
  async releaseReservedQuantity(
    salesOrderId: string,
    productId: string,
    warehouseId: string,
    quantity: number,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConflictException('Release quantity must be a positive whole number.');
    }

    const run = async (m: EntityManager): Promise<void> => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${warehouseId}:${productId}`]);

      const repo = m.getRepository(StockReservation);
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
        m,
      );
    };

    // N-02/H2: the per-(warehouse,product) advisory lock and the read-modify-write of the reservation rows must share ONE transaction (a plain manager releases the lock at once).
    return runInTransaction(this.dataSource, manager, run);
  }

  /**
   * ADR-061 (Manufacturing) — the generic-reference twin of
   * `releaseReservedQuantity` above, for Work Order Material Issue: each
   * issue decrements the Work Order's own reservation by the issued
   * quantity, the same FIFO-drain-across-active-rows logic, so
   * `getAvailableInTransaction` reflects the shrinking reservation
   * immediately.
   */
  async releaseReservedQuantityForReference(
    referenceType: ReservationReferenceType,
    referenceId: string,
    productId: string,
    warehouseId: string,
    quantity: number,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConflictException('Release quantity must be a positive whole number.');
    }

    const run = async (m: EntityManager): Promise<void> => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${warehouseId}:${productId}`]);

      const repo = m.getRepository(StockReservation);
      const rows = await repo.find({
        where: { referenceType, referenceId, productId, warehouseId, status: 'active' },
        order: { createdAt: 'ASC' },
      });
      const totalActive = rows.reduce((sum, r) => sum + r.quantity, 0);
      if (totalActive < quantity) {
        throw new ConflictException(
          `Cannot release ${quantity} of product "${productId}" for reference "${referenceType}:${referenceId}" — only ${totalActive} is actively reserved in warehouse "${warehouseId}".`,
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
          resourceId: `${referenceType}:${referenceId}:${productId}:${warehouseId}`,
          result: 'success',
          correlationId: null,
          after: { referenceType, referenceId, productId, warehouseId, quantity },
        },
        m,
      );
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
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
  /**
   * Gap Resolution Package 3 (2026-09-14, row 36) — the movement insert and the reservation
   * status flip now share ONE transaction/manager (previously two independent writes: a crash
   * between them left a `dispatch` movement that already deducted on-hand stock with the
   * reservation still `active`, which `getAvailableInTransaction` then double-counts as still
   * reserved). `manager` is optional (Mandatory Implementation Invariant) — `recordMovement`
   * always receives OUR manager here, so it never opens an independent transaction of its own.
   */
  async fulfillReservation(
    reservationId: string,
    actorUserId: string | null,
    warehouseIdOverride?: string,
    manager?: EntityManager,
  ): Promise<StockMovement> {
    const run = async (m: EntityManager): Promise<StockMovement> => {
      const reservationRepo = m.getRepository(StockReservation);
      // N-02: the status check and the status flip must be ONE serialised unit. The first read only identifies the (warehouse, product) key; the per-(warehouse,product)
      // advisory lock is the SAME key reserveStock / releaseReservedQuantity use, held until the end of this transaction; the reservation is then RE-READ under the lock, so a
      // second fulfilment of the same reservation sees 'fulfilled' and is refused instead of posting a second dispatch movement.
      const probe = await reservationRepo.findOne({ where: { id: reservationId } });
      if (!probe) throw new NotFoundException(`Reservation "${reservationId}" not found.`);
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${probe.warehouseId}:${probe.productId}`]);
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
        m,
      );

      reservation.status = 'fulfilled';
      await reservationRepo.save(reservation);

      return movement;
    };

    // N-02: join the caller's transaction when one is ACTIVE, otherwise open one on the caller's manager (a plain manager would otherwise run every statement, and release the lock, separately).
    return runInTransaction(this.dataSource, manager, run);
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
  /**
   * Gap Resolution Package 3 (2026-09-14, row 36) — wraps the WHOLE order's reservation loop in
   * ONE transaction (previously one independent transaction per line, via each unmanaged
   * `fulfillReservation` call) — a multi-line order's dispatch is now a single atomic unit: either
   * every line's stock leaves the ledger and every reservation flips to `fulfilled` together, or
   * none of it does. `manager` optional per the Mandatory Implementation Invariant.
   */
  async fulfillReservationsForOrder(
    salesOrderId: string,
    currentWarehouseId: string,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    const run = async (m: EntityManager): Promise<void> => {
      // N-02 (independent-review finding, reproduced by T-21 case I: 12 deadlocks in 24 calls): two orders that share products but list them in opposite order would lock their
      // per-(warehouse,product) keys in opposite order inside fulfillReservation and deadlock. Take ALL the keys of the order up front in one deterministic (sorted) order — the same
      // discipline assembleProduct uses — then re-read the still-active reservations under those locks and fulfil them (the per-reservation locks are then re-entrant no-ops).
      const preview = await this.getActiveReservationsForOrder(salesOrderId, m);
      const keys = [...new Set(preview.map((r) => `${r.warehouseId}:${r.productId}`))].sort();
      for (const key of keys) await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const reservations = await this.getActiveReservationsForOrder(salesOrderId, m);
      for (const reservation of reservations) {
        await this.fulfillReservation(reservation.id, actorUserId, currentWarehouseId, m);
      }
    };

    // N-02: the whole order is one atomic unit even when the caller passes a plain manager (see fulfillReservation).
    return runInTransaction(this.dataSource, manager, run);
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
    manager?: EntityManager,
  ): Promise<{ assemblyReference: string; finishedGoodMovement: StockMovement; componentMovements: StockMovement[] }> {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ConflictException('Assembly quantity must be a positive whole number.');
    }

    const recipe = await this.bom.getBomForAssembly(finishedProductId, manager);
    if (!recipe || recipe.length === 0) {
      throw new NotFoundException(`No Bill of Materials defined for product "${finishedProductId}".`);
    }

    const assemblyReference = await this.numbering.getNextNumber('assembly', manager);

    return (manager ?? this.dataSource).transaction(async (txManager) => {
      const involvedProductIds = [...new Set([finishedProductId, ...recipe.map((r) => r.componentProductId)])].sort();
      for (const productId of involvedProductIds) {
        await txManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${warehouseId}:${productId}`]);
      }

      // Check every component's availability BEFORE writing any movement —
      // an assembly either fully succeeds or writes nothing at all.
      for (const component of recipe) {
        const required = component.quantityPerUnit * quantity;
        const onHandRows: Array<{ sum: string | null }> = await txManager.query(
          'SELECT SUM(quantity) as sum FROM stock_movements WHERE "warehouseId" = $1 AND "productId" = $2',
          [warehouseId, component.componentProductId],
        );
        const reservedRows: Array<{ sum: string | null }> = await txManager.query(
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

      // ADR-061 §14 (D5 retrofit) — every leg now goes through `recordMovement` (never a direct
      // `movementRepo.save`), and F08/Financial-Event integration is wired exactly like a Work
      // Order's Material Issue + Finished Goods Output, financially collapsed into ONE
      // instantaneous transaction (assembly has no partial-production concept, so there is no
      // "remaining planned quantity" to pool across — the Work-Order-pooled override is not
      // needed here; each component is simply consumed at its own current average, same as a
      // real dispatch, and the finished good receipts at the sum of what was actually consumed).
      // Movement types are UNCHANGED (`assembly_consumption`/`assembly_output`) — no existing
      // report/query that filters on them is disturbed.
      const componentMovements: StockMovement[] = [];
      let totalConsumedValue = 0;
      for (const component of recipe) {
        const required = component.quantityPerUnit * quantity;
        const naturalCost = this.valuation ? await this.valuation.getUnitCost(component.componentProductId, warehouseId, undefined, txManager) : null;
        if (this.valuation && naturalCost != null) {
          const applied = await this.valuation.consumeIssueCost(
            component.componentProductId,
            warehouseId,
            required,
            `manufacturing:assembly:${assemblyReference}:consumption:${component.componentProductId}`,
            txManager,
          );
          if (applied && !('rejected' in applied)) totalConsumedValue += Number(applied.totalCostBase);
        }
        componentMovements.push(
          await this.recordMovement(warehouseId, component.componentProductId, -required, 'assembly_consumption', 'assembly', assemblyReference, actorUserId, txManager),
        );
      }

      const finishedGoodMovement = await this.recordMovement(warehouseId, finishedProductId, quantity, 'assembly_output', 'assembly', assemblyReference, actorUserId, txManager);
      if (this.valuation && totalConsumedValue > 0) {
        await this.valuation.recordReceiptCost(
          finishedProductId,
          warehouseId,
          quantity,
          (totalConsumedValue / quantity).toFixed(4),
          `manufacturing:assembly:${assemblyReference}:output`,
          txManager,
        );

        // ADR-061 §14 — "an instantaneous Work Order": Dr WIP / Cr Inventory on consumption, then
        // Dr Inventory / Cr WIP on output, same transaction, WIP touched and immediately zeroed
        // again — reuses the identical Manufacturing topics/handlers (§13), no new control
        // function or mechanism introduced solely for legacy compatibility.
        await this.events.publish(txManager, 'manufacturing.work_order.material_issued', {
          idempotencyKey: `manufacturing:assembly:${assemblyReference}:consumption`,
          workOrderId: assemblyReference,
          componentProductId: null,
          quantity,
          unitCostBase: null,
          totalValueBase: totalConsumedValue.toFixed(4),
        });
        await this.events.publish(txManager, 'manufacturing.work_order.finished_goods_received', {
          idempotencyKey: `manufacturing:assembly:${assemblyReference}:output`,
          workOrderId: assemblyReference,
          finishedProductId,
          quantity,
          unitCostBase: (totalConsumedValue / quantity).toFixed(4),
          totalValueBase: totalConsumedValue.toFixed(4),
        });
      }

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
            totalConsumedValue: totalConsumedValue.toFixed(4),
            components: recipe.map((r) => ({ componentProductId: r.componentProductId, consumed: r.quantityPerUnit * quantity })),
          },
        },
        txManager,
      );

      return { assemblyReference, finishedGoodMovement, componentMovements };
    }).then(async (result) => {
      // Same precedent as `GoodsReceiptService.post` — without this, the outbox rows `events.publish`
      // wrote above would sit `pending` until some unrelated later sweep, an accidental delay.
      await this.events.dispatchPending(undefined, manager);
      return result;
    });
  }
}
