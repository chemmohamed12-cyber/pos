import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { WarehouseTransaction } from '../infrastructure/warehouse-transaction.entity';
import { WarehouseTransactionLine } from '../infrastructure/warehouse-transaction-line.entity';
import { WarehouseTransactionType, NUMBERING_SERIES_BY_TYPE, NO_APPROVAL_REQUIRED } from '../domain/warehouse-transaction-type';
import { WAREHOUSE_TRANSACTION_PROCESS } from '../domain/warehouse-transaction-process';
import { WAREHOUSE_TRANSACTION_ACTION_ROLES } from '../domain/warehouse-transaction-action-roles';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { SALES_PRODUCTS_CONTRACT, SalesProductsContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { InventoryService } from './inventory.service';

export interface TransactionLineInput {
  productId: string;
  quantity: number;
  notes?: string | null;
}

const ENTITY_TYPE = 'warehouse_transaction';

/**
 * Warehouse & Inventory Control UX/UI V1 (CTO directive) — the business
 * document layer above Inventory's append-only ledger. Every posting
 * path in this service calls `InventoryService.recordMovement` (never
 * `stock_movements` directly) so the ledger remains the single source
 * of truth (directive §16) regardless of which document produced the
 * entry.
 */
@Injectable()
export class WarehouseTransactionsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly processEngine: ProcessEngineService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    @Inject(SALES_PRODUCTS_CONTRACT) private readonly products: SalesProductsContract,
    private readonly inventory: InventoryService,
  ) {}

  async createTransaction(
    type: WarehouseTransactionType,
    warehouseId: string,
    destinationWarehouseId: string | null,
    lines: TransactionLineInput[],
    reference: string | null,
    reason: string | null,
    notes: string | null,
    actorUserId: string,
    movementDate?: Date,
  ): Promise<WarehouseTransaction> {
    if (lines.length === 0) {
      throw new BadRequestException('A warehouse transaction must have at least one line.');
    }
    if (type === 'transfer' && !destinationWarehouseId) {
      throw new BadRequestException('A transfer requires a destination warehouse.');
    }
    if (type === 'transfer' && destinationWarehouseId === warehouseId) {
      throw new BadRequestException('Transfer source and destination warehouses must be different.');
    }
    if (type === 'count') {
      throw new BadRequestException('Count transactions are created via startCount(), not createTransaction().');
    }

    // Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — an
    // inactive warehouse is taken out of operational use; no new
    // document may target it (source or transfer destination).
    await this.assertWarehouseActive(warehouseId);
    if (destinationWarehouseId) await this.assertWarehouseActive(destinationWarehouseId);

    // Validate every product exists BEFORE opening the write transaction
    // (same ordering discipline as SalesOrdersService.createOrder).
    for (const line of lines) {
      if (line.quantity <= 0) throw new BadRequestException('Every line quantity must be a positive whole number.');
      const snapshot = await this.products.getProductSnapshot(line.productId);
      if (!snapshot) throw new BadRequestException(`Product "${line.productId}" was not found.`);
    }

    const transactionNumber = await this.numbering.getNextNumber(NUMBERING_SERIES_BY_TYPE[type]);

    const transaction = await this.dataSource.transaction(async (manager) => {
      const txnRepo = manager.getRepository(WarehouseTransaction);
      const lineRepo = manager.getRepository(WarehouseTransactionLine);

      const saved = await txnRepo.save(
        txnRepo.create({
          transactionNumber,
          type,
          warehouseId,
          destinationWarehouseId,
          reference,
          reason,
          notes,
          createdByUserId: actorUserId,
          movementDate: movementDate ?? new Date(),
        }),
      );
      const lineEntities = lines.map((l) =>
        lineRepo.create({ warehouseTransactionId: saved.id, productId: l.productId, quantity: l.quantity, notes: l.notes ?? null }),
      );
      await lineRepo.save(lineEntities);
      return saved;
    });

    await this.processEngine.start(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, transaction.id);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'warehouse_transaction.created',
      resource: 'warehouse_transaction',
      resourceId: transaction.id,
      result: 'success',
      correlationId: null,
      after: { transactionNumber, type, warehouseId, destinationWarehouseId, lineCount: lines.length },
    });

    return transaction;
  }

  /**
   * Stock Count (directive §15): captures each line's CURRENT ledger
   * balance as `systemQuantity` at count-creation time — the physical
   * count doesn't touch the ledger at all until a supervisor approves
   * the resulting variance (via the normal submit/approve pipeline,
   * `type: 'count'` posts as `movementType: 'adjustment'`).
   */
  async startCount(warehouseId: string, productIds: string[], actorUserId: string): Promise<WarehouseTransaction> {
    if (productIds.length === 0) throw new BadRequestException('A stock count must include at least one product.');
    await this.assertWarehouseActive(warehouseId);
    const transactionNumber = await this.numbering.getNextNumber(NUMBERING_SERIES_BY_TYPE.count);

    const transaction = await this.dataSource.transaction(async (manager) => {
      const txnRepo = manager.getRepository(WarehouseTransaction);
      const lineRepo = manager.getRepository(WarehouseTransactionLine);
      const saved = await txnRepo.save(
        txnRepo.create({
          transactionNumber,
          type: 'count',
          warehouseId,
          destinationWarehouseId: null,
          createdByUserId: actorUserId,
          movementDate: new Date(),
        }),
      );
      const lineEntities: WarehouseTransactionLine[] = [];
      for (const productId of productIds) {
        const systemQuantity = await this.inventory.getOnHand(warehouseId, productId);
        lineEntities.push(
          lineRepo.create({ warehouseTransactionId: saved.id, productId, quantity: 0, systemQuantity, physicalQuantity: null }),
        );
      }
      await lineRepo.save(lineEntities);
      return saved;
    });

    await this.processEngine.start(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, transaction.id);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'warehouse_transaction.count_started',
      resource: 'warehouse_transaction',
      resourceId: transaction.id,
      result: 'success',
      correlationId: null,
      after: { transactionNumber, warehouseId, productCount: productIds.length },
    });
    return transaction;
  }

  /** Records the physically-counted quantities and computes each line's variance — still just a draft edit, no ledger effect yet. */
  async recordCountResults(transactionId: string, physicalQuantities: Array<{ lineId: string; physicalQuantity: number }>): Promise<void> {
    const state = await this.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, transactionId);
    if (state !== 'draft') throw new ConflictException(`Cannot record count results for a transaction in state "${state}".`);

    const lineRepo = this.dataSource.getRepository(WarehouseTransactionLine);
    for (const { lineId, physicalQuantity } of physicalQuantities) {
      const line = await lineRepo.findOne({ where: { id: lineId, warehouseTransactionId: transactionId } });
      if (!line) throw new NotFoundException(`Count line "${lineId}" not found on this transaction.`);
      line.physicalQuantity = physicalQuantity;
      line.quantity = physicalQuantity - (line.systemQuantity ?? 0);
      await lineRepo.save(line);
    }
  }

  async getTransaction(transactionId: string): Promise<WarehouseTransaction & { state: string }> {
    const txn = await this.dataSource.getRepository(WarehouseTransaction).findOne({ where: { id: transactionId } });
    if (!txn) throw new NotFoundException(`Warehouse transaction "${transactionId}" not found.`);
    const state = await this.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, transactionId);
    return { ...txn, state };
  }

  async getLines(transactionId: string): Promise<WarehouseTransactionLine[]> {
    return this.dataSource.getRepository(WarehouseTransactionLine).find({ where: { warehouseTransactionId: transactionId } });
  }

  /**
   * Warehouse Operational Control Center (directive §4) — every figure
   * here is computed from real data that already exists; nothing is
   * fabricated. `totalInventoryValue` is explicitly disclosed as
   * "at selling price" (`Product.unitPrice`) because this codebase has
   * no cost/valuation layer yet — a real COGS-based valuation is
   * Finance's future scope (README's Phase 2 note), not invented here.
   * `lowStock` is deliberately omitted for the same reason: no
   * per-product/warehouse minimum-stock threshold exists to compare
   * against yet.
   */
  async getOverview(): Promise<{
    totalWarehouses: number;
    totalInventoryValueAtSellingPrice: string;
    todaysMovementsCount: number;
    reservedStockUnits: number;
    pendingApprovalsCount: number;
    openCountsCount: number;
    negativeStockItems: Array<{ warehouseId: string; productId: string; onHand: number }>;
  }> {
    const [warehouses, stockReport, products, allTransactions] = await Promise.all([
      this.inventory.listWarehouses(),
      this.inventory.getStockReport(),
      this.products.listAllProducts(),
      this.listTransactions({}),
    ]);
    const priceById = new Map(products.map((p) => [p.id, Number(p.unitPrice)]));

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaysMovements = await this.inventory.listMovements({ dateFrom: todayStart.toISOString() });

    return {
      totalWarehouses: warehouses.length,
      totalInventoryValueAtSellingPrice: stockReport
        .reduce((sum, row) => sum + row.onHand * (priceById.get(row.productId) ?? 0), 0)
        .toFixed(2),
      todaysMovementsCount: todaysMovements.length,
      reservedStockUnits: stockReport.reduce((sum, row) => sum + row.reserved, 0),
      pendingApprovalsCount: allTransactions.filter((t) => t.state === 'submitted').length,
      openCountsCount: allTransactions.filter((t) => t.type === 'count' && ['draft', 'submitted'].includes(t.state)).length,
      negativeStockItems: stockReport.filter((row) => row.onHand < 0).map((row) => ({ warehouseId: row.warehouseId, productId: row.productId, onHand: row.onHand })),
    };
  }

  /** Backs the Movement Center / Warehouse screen's transaction list — filterable by warehouse/type, newest first. */
  async listTransactions(filters: { warehouseId?: string; type?: WarehouseTransactionType }): Promise<Array<WarehouseTransaction & { state: string }>> {
    const repo = this.dataSource.getRepository(WarehouseTransaction);
    const where: Record<string, unknown> = {};
    if (filters.warehouseId) where.warehouseId = filters.warehouseId;
    if (filters.type) where.type = filters.type;
    const rows = await repo.find({ where, order: { createdAt: 'DESC' } });
    return Promise.all(rows.map(async (r) => ({ ...r, state: await this.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, r.id) })));
  }

  /**
   * Pagination audit fix (MASTER_PROJECT_STATUS.md §6 — the `repo.find()`
   * above was one of 5 confirmed-unbounded list endpoints). `listTransactions`
   * itself is deliberately left unpaginated — `getOverview`'s KPI tiles
   * (`pendingApprovalsCount`, `openCountsCount`) call it with no filters and
   * need the FULL set to count accurately, not one page of it. This
   * take/skip-bounded sibling backs the Movement Center screen's own table;
   * same `warehouseId`/`type` filters as `listTransactions`, just paginated.
   * A nice side effect: the per-row `processEngine.getState` lookup (an
   * N+1-shaped call, same pattern flagged elsewhere in this codebase) is
   * now bounded to one page's worth of rows instead of the whole table.
   */
  async listTransactionsPage(
    filters: { warehouseId?: string; type?: WarehouseTransactionType; page: number; pageSize: number },
  ): Promise<{ rows: Array<WarehouseTransaction & { state: string }>; total: number }> {
    const repo = this.dataSource.getRepository(WarehouseTransaction);
    const where: Record<string, unknown> = {};
    if (filters.warehouseId) where.warehouseId = filters.warehouseId;
    if (filters.type) where.type = filters.type;
    const [rows, total] = await repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
    });
    const enriched = await Promise.all(
      rows.map(async (r) => ({ ...r, state: await this.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, r.id) })),
    );
    return { rows: enriched, total };
  }

  /**
   * The single entry point for every lifecycle action (directive §11).
   * `submit` auto-chains straight to `posted` for no-approval types
   * (currently just receipt); `approve` auto-chains straight to `posted`
   * for everything else — "control without bureaucracy": a supervisor's
   * one click both approves AND posts, while the audit trail still
   * records both events distinctly with their own timestamps.
   */
  async transition(transactionId: string, action: string, actorUserId: string): Promise<string> {
    // V1 Release Audit HIGH fix — default-deny: an action absent from
    // the map (e.g. 'auto_post', an internal-only transition this
    // service fires itself further down, never meant to be client-
    // reachable) used to skip the role check entirely instead of being
    // rejected, letting any authenticated user post a transaction with
    // no ledger movement and no stock check.
    const requiredRoles = WAREHOUSE_TRANSACTION_ACTION_ROLES[action];
    if (!requiredRoles) {
      throw new ForbiddenException(`"${action}" is not a valid client-initiated action.`);
    }
    const userRoles = await this.authorization.getRoleKeysForUser(actorUserId);
    const isAdmin = userRoles.includes('admin');
    if (!isAdmin && !requiredRoles.some((r) => userRoles.includes(r))) {
      throw new ForbiddenException(`Role required for action "${action}": one of [${requiredRoles.join(', ')}].`);
    }

    const txn = await this.dataSource.getRepository(WarehouseTransaction).findOne({ where: { id: transactionId } });
    if (!txn) throw new NotFoundException(`Warehouse transaction "${transactionId}" not found.`);

    if (action === 'submit' && txn.type === 'count') {
      const lines = await this.getLines(transactionId);
      if (lines.some((l) => l.physicalQuantity === null)) {
        throw new BadRequestException('Every line must have a physical count recorded before this count can be submitted.');
      }
    }

    if (action === 'reverse') {
      await this.reverseTransaction(txn, actorUserId);
      return this.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, transactionId);
    }

    // POST THE LEDGER FIRST, advance the lifecycle state SECOND — but as
    // ONE atomic unit now (Inventory Integrity concurrency fix,
    // 2026-09-13; see `postTransaction`'s own doc comment for the full
    // history, including a first version of this fix that was itself
    // found incomplete by live testing). `postTransaction` performs BOTH
    // the ledger write AND the resulting Process Engine state transition
    // ('post' or 'auto_post') itself, inside the SAME document-locked
    // database transaction — so the document-level advisory lock is held
    // for the whole combined operation, not released in between. This
    // closes a real gap an earlier version of this fix had: releasing
    // the lock right after writing movements, but BEFORE the state
    // transition, left a window where a second concurrent caller could
    // acquire the lock, still see the OLD state (not yet flipped), and
    // itself proceed to write a duplicate movement. A failed post (e.g.
    // the negative-stock guard) still never reaches the state-transition
    // line at all — the whole transaction rolls back, leaving the
    // document at its prior state so a supervisor can fix the stock
    // situation and retry, never mislabeled "posted" with no movements
    // actually written.
    if (action === 'submit' && NO_APPROVAL_REQUIRED.has(txn.type)) {
      await this.processEngine.transition(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, transactionId, 'submit', actorUserId);
      await this.postTransaction(txn, actorUserId, null, 'auto_post');
    } else if (action === 'approve') {
      await this.processEngine.transition(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, transactionId, 'approve', actorUserId);
      await this.postTransaction(txn, actorUserId, actorUserId, 'post');
    } else if (action === 'post') {
      await this.postTransaction(txn, actorUserId, actorUserId, 'post');
    } else {
      await this.processEngine.transition(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, transactionId, action, actorUserId);
    }

    const finalState = await this.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, transactionId);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: `warehouse_transaction.${action}`,
      resource: 'warehouse_transaction',
      resourceId: transactionId,
      result: 'success',
      correlationId: null,
      after: { state: finalState },
    });

    return finalState;
  }

  /** Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — no new document may target a deactivated warehouse. */
  private async assertWarehouseActive(warehouseId: string): Promise<void> {
    const warehouse = await this.inventory.getWarehouse(warehouseId);
    if (warehouse.status !== 'active') {
      throw new ConflictException(`Warehouse "${warehouse.code}" is inactive — no new transactions can target it.`);
    }
  }

  /** Returns the quantity that must be available for this line to post, or null if this line/type needs no check at all (receipt, positive adjustment/count, or a zero-variance count line). */
  private requiredCheckQuantity(txn: WarehouseTransaction, line: WarehouseTransactionLine): number | null {
    if (txn.type === 'issue' || txn.type === 'transfer') return line.quantity;
    if (txn.type === 'adjustment' || txn.type === 'count') return line.quantity < 0 ? -line.quantity : null;
    return null; // receipt: an incoming movement is never "insufficient"
  }

  /**
   * Writes the real ledger entries (directive §16 — the transaction
   * header never IS the balance, it only produces movements). Negative-
   * stock prevention (Warehouse & Inventory Control V1 handover, §0/§10/§22)
   * happens HERE, at posting time, not at draft/submit time, since
   * availability can genuinely change between when a line was drafted
   * and when it's actually approved.
   *
   * Whole-document atomicity, not first-line-only (handover §0's explicit
   * multi-line requirement — a real gap this rewrite closes, found while
   * reviewing this method for that directive, not by the existing unit
   * tests, which mock `InventoryService` and so never exercised true
   * cross-line atomicity or the concurrent-writer race): every line
   * needing a stock check is validated BEFORE any movement is written,
   * inside ONE database transaction, under sorted per-(warehouse,product)
   * advisory locks (same pattern as `InventoryService.reserveStock` /
   * `assembleProduct`) — a shortage on any single line blocks the entire
   * document, and two concurrent postings touching the same
   * warehouse+product can no longer both read the same stale "available"
   * number and both proceed.
   *
   * **Document-level idempotency (Inventory Integrity fix, 2026-09-13,
   * REVISED same day after a first version was itself found incomplete
   * by live testing — see below).** The per-(warehouse,product) advisory
   * locks above only ever protected two DIFFERENT documents from racing
   * on the same stock — they did nothing to stop the SAME document from
   * being posted twice by two concurrent callers (two retry-clicks, or
   * an 'approve' racing a 'post' retry), since neither call had any way
   * to know the other was also mid-flight until AFTER both had already
   * written their own movements. Live-reproduced on real PostgreSQL:
   * `evidence/warehouse-issue-approval-posting/concurrent-post-live-reproduction.txt`.
   *
   * The first version of this fix took a document-scoped advisory lock
   * here, re-read the Process Engine's state inside it, and returned a
   * `{posted: boolean}` flag telling the CALLER (`transition()`) whether
   * to fire its own separate Process Engine transition afterward. That
   * was ALSO found incomplete by live Browser E2E testing the same day:
   * releasing this method's own transaction (and with it, the document
   * lock) BEFORE the caller's separate `processEngine.transition(...,
   * 'post', ...)` call left a real window — a second concurrent call
   * could acquire the now-free lock, see the state as still NOT posted
   * (because the first call's own state transition hadn't run yet
   * either), and itself proceed to write a second, duplicate movement.
   * Two concurrent HTTP requests hit exactly this window in practice.
   *
   * **The actual fix: this method now performs the Process Engine state
   * transition itself, INSIDE the same document-locked transaction**
   * (`postAction` tells it which action to fire — `'post'` for the
   * approve/retry paths, `'auto_post'` for the no-approval-required
   * submit path), via `ProcessEngineService.transition(..., manager)`'s
   * own existing optional-manager support (Foundation, 2026-09-10) — so
   * the write, the state flip, AND the document lock all live and die
   * together as ONE atomic unit. A second concurrent caller can now only
   * ever observe either "not started yet" (lock still held by the first
   * caller — it blocks and waits) or "fully complete, including the
   * state transition" (lock released only after everything committed)
   * — there is no more window where movements are written but the state
   * hasn't caught up yet. The state re-read at the top, inside the lock,
   * is what makes the LOSING side of a race a true idempotent no-op:
   * sees `posted` already → writes nothing, checks nothing, returns
   * `{posted: false}` without ever calling `processEngine.transition`
   * again (which would otherwise be rejected — "not valid from state
   * 'posted'" — for no reason). Never relies on any state the caller
   * already had before this method was called — only on this fresh,
   * in-lock read.
   */
  private async postTransaction(
    txn: WarehouseTransaction,
    actorUserId: string,
    approvedByUserId: string | null,
    postAction: 'post' | 'auto_post',
  ): Promise<{ posted: boolean }> {
    const allLines = await this.getLines(txn.id);
    // A zero-variance count/adjustment line has nothing to post and
    // nothing to check — excluded up front, same as the original
    // `if (line.quantity === 0) continue`.
    const lines = allLines.filter((l) => !((txn.type === 'adjustment' || txn.type === 'count') && l.quantity === 0));

    const pairs = new Set<string>();
    for (const line of lines) {
      pairs.add(`${txn.warehouseId}:${line.productId}`);
      if (txn.type === 'transfer') pairs.add(`${txn.destinationWarehouseId}:${line.productId}`);
    }
    const sortedPairs = [...pairs].sort();

    return this.dataSource.transaction(async (manager: EntityManager) => {
      // Document-level lock FIRST — serializes any two concurrent posting
      // attempts for THIS SAME document against each other, before either
      // touches stock at all.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`warehouse_transaction_post:${txn.id}`]);

      // Re-check state fresh, inside the lock — never trust a state read
      // (by this call or its caller) from before the lock was acquired.
      const currentState = await this.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, txn.id, manager);
      if (currentState === 'posted') {
        // A concurrent call already posted this exact document while this
        // call was waiting on the lock above — idempotent no-op, matching
        // "One Business Document = One Operational Effect" under any
        // concurrent retry/double-click/duplicate request.
        return { posted: false };
      }

      for (const pair of sortedPairs) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pair]);
      }

      const shortages: Array<{ line: WarehouseTransactionLine; required: number; available: number }> = [];
      for (const line of lines) {
        const required = this.requiredCheckQuantity(txn, line);
        if (required === null) continue;
        const available = await this.inventory.getAvailableInTransaction(manager, txn.warehouseId, line.productId);
        if (available < required) shortages.push({ line, required, available });
      }

      if (shortages.length > 0) {
        const details = await Promise.all(
          shortages.map(async ({ line, required, available }) => {
            const product = await this.products.getProductSnapshot(line.productId);
            const label = product ? `${product.sku} (${product.name})` : line.productId;
            return `${label}: requested ${required}, available ${available}, short by ${required - available}`;
          }),
        );
        throw new ConflictException(
          `Insufficient stock for ${shortages.length} line(s) — nothing was posted: ${details.join('; ')}`,
        );
      }

      for (const line of lines) {
        if (txn.type === 'receipt') {
          await this.inventory.recordMovement(txn.warehouseId, line.productId, line.quantity, 'receipt', 'warehouse_transaction', txn.id, actorUserId, manager);
        } else if (txn.type === 'issue') {
          await this.inventory.recordMovement(txn.warehouseId, line.productId, -line.quantity, 'dispatch', 'warehouse_transaction', txn.id, actorUserId, manager);
        } else if (txn.type === 'transfer') {
          await this.inventory.recordMovement(txn.warehouseId, line.productId, -line.quantity, 'transfer_out', 'warehouse_transaction', txn.id, actorUserId, manager);
          await this.inventory.recordMovement(txn.destinationWarehouseId!, line.productId, line.quantity, 'transfer_in', 'warehouse_transaction', txn.id, actorUserId, manager);
        } else if (txn.type === 'adjustment' || txn.type === 'count') {
          await this.inventory.recordMovement(txn.warehouseId, line.productId, line.quantity, 'adjustment', 'warehouse_transaction', txn.id, actorUserId, manager);
        }
      }

      await manager.getRepository(WarehouseTransaction).update(txn.id, {
        postedByUserId: actorUserId,
        ...(approvedByUserId ? { approvedByUserId } : {}),
      });

      // State transition INSIDE the same locked transaction — see this method's own doc comment
      // for why this must not happen after the lock is released.
      await this.processEngine.transition(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, txn.id, postAction, actorUserId, manager);

      return { posted: true };
    });
  }

  /**
   * Reversal, never delete, for a posted transaction (directive §17) —
   * creates a brand-new transaction of the same type with every line's
   * quantity negated, linked via `reversalOfTransactionId`, and posts it
   * immediately (reversing something already approved doesn't need a
   * second approval cycle). The ORIGINAL transaction's own Process
   * Engine history is untouched — both the original and its reversal
   * remain permanently in the ledger and in `process_transition_records`.
   */
  private async reverseTransaction(original: WarehouseTransaction, actorUserId: string): Promise<WarehouseTransaction> {
    const state = await this.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, original.id);
    if (state !== 'posted') throw new ConflictException(`Cannot reverse a transaction in state "${state}" — only posted transactions can be reversed.`);

    const originalLines = await this.getLines(original.id);
    const transactionNumber = await this.numbering.getNextNumber(NUMBERING_SERIES_BY_TYPE[original.type]);

    // Move the ORIGINAL transaction's own lifecycle to 'reversed' first —
    // this is the state check that must hold even if the reversal-document
    // creation below were to fail.
    await this.processEngine.transition(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, original.id, 'reverse', actorUserId);

    const reversal = await this.dataSource.transaction(async (manager) => {
      const txnRepo = manager.getRepository(WarehouseTransaction);
      const lineRepo = manager.getRepository(WarehouseTransactionLine);
      const saved = await txnRepo.save(
        txnRepo.create({
          transactionNumber,
          type: original.type,
          warehouseId: original.warehouseId,
          destinationWarehouseId: original.destinationWarehouseId,
          reference: original.transactionNumber,
          reason: `Reversal of ${original.transactionNumber}`,
          reversalOfTransactionId: original.id,
          createdByUserId: actorUserId,
        }),
      );
      const lineEntities = originalLines.map((l) =>
        lineRepo.create({ warehouseTransactionId: saved.id, productId: l.productId, quantity: -l.quantity }),
      );
      await lineRepo.save(lineEntities);
      return saved;
    });

    await this.processEngine.start(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, reversal.id);
    await this.processEngine.transition(WAREHOUSE_TRANSACTION_PROCESS, ENTITY_TYPE, reversal.id, 'submit', actorUserId);
    // Post THEN mark posted — same ordering fix as transition() above. `postTransaction` now
    // performs the 'auto_post' state transition itself, inside its own document-locked
    // transaction (Inventory Integrity concurrency fix, 2026-09-13) — no separate call needed here.
    await this.postTransaction(reversal, actorUserId, null, 'auto_post');

    // The original transaction stays 'posted' in its own process instance;
    // marking that IT was reversed lives in the audit trail + the reversal
    // row's own `reversalOfTransactionId` pointer, not a mutation of the original.
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'warehouse_transaction.reversed',
      resource: 'warehouse_transaction',
      resourceId: original.id,
      result: 'success',
      correlationId: null,
      after: { reversalTransactionId: reversal.id, reversalTransactionNumber: transactionNumber },
    });

    return reversal;
  }
}
