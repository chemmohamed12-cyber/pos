import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FulfillmentOrder } from '../infrastructure/fulfillment-order.entity';
import { PickTask } from '../infrastructure/pick-task.entity';
import { PackTask } from '../infrastructure/pack-task.entity';
import { PickTaskLine } from '../infrastructure/pick-task-line.entity';
import { FULFILLMENT_TASK_PROCESS } from '../domain/fulfillment-task-process';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';

const WORKER_ROLE = 'warehouse_worker';
const PREPARATION_WAREHOUSE_CODE_PREFIX = 'PREP';
const PREPARATION_WAREHOUSE_DOCUMENT_TYPE = 'fulfillment_preparation_sub_location';

@Injectable()
export class FulfillmentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly inventory: InventoryService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * Creates the Fulfillment Order and its first Pick Task, started at
   * 'assigned' in the shared Process Engine.
   *
   * MULTI-LINE FIX: no longer takes a single `reservationId` from the
   * caller — it derives the full set of reservations (one per Sales
   * Order line, see `InventoryService.reserveStock`) itself, the single
   * source of truth for "what does this fulfillment order need to
   * dispatch." `warehouseId` is derived from those reservations too
   * (never trusted from the client) — an order whose reservations span
   * more than one warehouse is rejected outright rather than silently
   * fulfilling from the wrong one; splitting a single fulfillment order
   * across warehouses is out of scope for V1 (disclosed, not silent).
   */
  async createFulfillmentOrder(
    salesOrderId: string,
    actorUserId: string | null,
  ): Promise<{ fulfillmentOrder: FulfillmentOrder; pickTask: PickTask }> {
    const reservations = await this.inventory.getActiveReservationsForOrder(salesOrderId);
    if (reservations.length === 0) {
      throw new BadRequestException(
        `No active stock reservations found for sales order "${salesOrderId}" — reserve stock for every line before creating a fulfillment order.`,
      );
    }
    const warehouseIds = new Set(reservations.map((r) => r.warehouseId));
    if (warehouseIds.size > 1) {
      throw new BadRequestException(
        `Reservations for sales order "${salesOrderId}" span multiple warehouses — splitting one fulfillment order across warehouses is not supported in V1.`,
      );
    }
    const warehouseId = reservations[0].warehouseId;
    // Same numbering discipline as the Sales Order itself (FO-2026-000001
    // vs SO-2026-000001, see CreateNumberingSequences1755841200000 /
    // AddFulfillmentOrderNumber1755850300000) — issued before the
    // transaction, same ordering `SalesOrdersService.createOrder` uses.
    const orderNumber = await this.numbering.getNextNumber('fulfillment_order');

    const { fulfillmentOrder, pickTask } = await this.dataSource.transaction(async (manager) => {
      const foRepo = manager.getRepository(FulfillmentOrder);
      const pickRepo = manager.getRepository(PickTask);
      const lineRepo = manager.getRepository(PickTaskLine);

      const fo = await foRepo.save(foRepo.create({ salesOrderId, warehouseId, orderNumber }));
      const pick = await pickRepo.save(pickRepo.create({ fulfillmentOrderId: fo.id, assignedToUserId: null }));

      // CTO directive ("PRIORITY: ITEM PREPARATION") — one Pick Task Line
      // per reservation, i.e. per Sales Order line, so the Preparation
      // screen can track "Prepared Quantity" per PRODUCT, not just a
      // single order-wide checkbox.
      const lineEntities = reservations.map((r) =>
        lineRepo.create({
          pickTaskId: pick.id,
          fulfillmentOrderId: fo.id,
          productId: r.productId,
          requestedQuantity: r.quantity,
        }),
      );
      await lineRepo.save(lineEntities);

      await this.events.publish(manager, 'fulfillment.created', { fulfillmentOrderId: fo.id, salesOrderId });

      return { fulfillmentOrder: fo, pickTask: pick };
    });

    await this.processEngine.start(FULFILLMENT_TASK_PROCESS, 'pick_task', pickTask.id);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'fulfillment.created',
      resource: 'fulfillment_order',
      resourceId: fulfillmentOrder.id,
      result: 'success',
      correlationId: null,
      after: { salesOrderId, warehouseId },
    });

    return { fulfillmentOrder, pickTask };
  }

  /** Backs the Fulfillment operational screen's pick-task queue — any warehouse_worker/admin may act on any open task (same "qualified role, not per-resource assignment" pattern as Sales Order review, §5.1). */
  async listPickTasks(): Promise<Array<PickTask & { state: string }>> {
    const tasks = await this.dataSource.getRepository(PickTask).find({ order: { createdAt: 'DESC' } });
    return Promise.all(
      tasks.map(async (task) => ({
        ...task,
        state: await this.processEngine.getState(FULFILLMENT_TASK_PROCESS, 'pick_task', task.id),
      })),
    );
  }

  async listPackTasks(): Promise<Array<PackTask & { state: string }>> {
    const tasks = await this.dataSource.getRepository(PackTask).find({ order: { createdAt: 'DESC' } });
    return Promise.all(
      tasks.map(async (task) => ({
        ...task,
        state: await this.processEngine.getState(FULFILLMENT_TASK_PROCESS, 'pack_task', task.id),
      })),
    );
  }

  async getFulfillmentOrderBySalesOrderId(salesOrderId: string): Promise<FulfillmentOrder | null> {
    return this.dataSource.getRepository(FulfillmentOrder).findOne({ where: { salesOrderId } });
  }

  /**
   * Backs the Fulfillment dashboard (CTO directive — 3 clickable status
   * tiles: New / Under Preparation / Ready for Shipping). A bulk list
   * didn't exist before (only the by-one-sales-order lookup above and
   * the by-one-id lookup below) — the dashboard needs to know, for every
   * released Sales Order, whether a Fulfillment Order already exists for
   * it at all, which this makes a single query instead of N.
   */
  async listFulfillmentOrders(): Promise<FulfillmentOrder[]> {
    return this.dataSource.getRepository(FulfillmentOrder).find({ order: { createdAt: 'DESC' } });
  }

  /** Backs the Picking/Packing print documents — single-task reads, didn't exist before (only list existed). */
  async getPickTask(pickTaskId: string): Promise<PickTask & { state: string }> {
    const task = await this.dataSource.getRepository(PickTask).findOne({ where: { id: pickTaskId } });
    if (!task) throw new NotFoundException(`Pick task "${pickTaskId}" not found.`);
    const state = await this.processEngine.getState(FULFILLMENT_TASK_PROCESS, 'pick_task', pickTaskId);
    return { ...task, state };
  }

  async getPackTask(packTaskId: string): Promise<PackTask & { state: string }> {
    const task = await this.dataSource.getRepository(PackTask).findOne({ where: { id: packTaskId } });
    if (!task) throw new NotFoundException(`Pack task "${packTaskId}" not found.`);
    const state = await this.processEngine.getState(FULFILLMENT_TASK_PROCESS, 'pack_task', packTaskId);
    return { ...task, state };
  }

  async getFulfillmentOrder(fulfillmentOrderId: string): Promise<FulfillmentOrder> {
    const order = await this.dataSource.getRepository(FulfillmentOrder).findOne({ where: { id: fulfillmentOrderId } });
    if (!order) throw new NotFoundException(`Fulfillment order "${fulfillmentOrderId}" not found.`);
    return order;
  }

  async assignPickTask(pickTaskId: string, userId: string, actorUserId: string | null): Promise<PickTask> {
    const repo = this.dataSource.getRepository(PickTask);
    const task = await repo.findOne({ where: { id: pickTaskId } });
    if (!task) throw new NotFoundException(`Pick task "${pickTaskId}" not found.`);
    task.assignedToUserId = userId;
    const saved = await repo.save(task);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'fulfillment.pick_task.assigned',
      resource: 'pick_task',
      resourceId: pickTaskId,
      result: 'success',
      correlationId: null,
      after: { userId },
    });
    return saved;
  }

  private async requireWorkerRole(actorUserId: string): Promise<void> {
    const roles = await this.authorization.getRoleKeysForUser(actorUserId);
    if (!roles.includes(WORKER_ROLE) && !roles.includes('admin')) {
      throw new ForbiddenException(`Role required: ${WORKER_ROLE} (or admin).`);
    }
  }

  /**
   * CTO directive ("استلام وبدء التجهيز" — Receive & Start Preparation):
   * one operator action that takes a freshly-created Pick Task straight
   * from `assigned` to `in_progress`, landing the order in the
   * "Under Preparation" dashboard bucket. Not a new state — just the
   * existing `accept` then `start` transitions run back-to-back, so the
   * underlying state machine (already tested, already correct) is
   * unchanged; this only removes a redundant confirmation click from the
   * UI's happy path. If `accept` succeeds but `start` then fails for any
   * reason, the task is left in `accepted` — a real, visible, still-valid
   * state (not a partial/corrupt one), and the worker can retry `start`
   * from there via the normal per-state actions.
   */
  async receiveAndStartPickTask(pickTaskId: string, actorUserId: string): Promise<{ state: string }> {
    await this.transitionPickTask(pickTaskId, 'accept', actorUserId);
    const { state } = await this.transitionPickTask(pickTaskId, 'start', actorUserId);
    return { state };
  }

  async transitionPickTask(
    pickTaskId: string,
    action: string,
    actorUserId: string,
  ): Promise<{ state: string; packTaskId: string | null }> {
    await this.requireWorkerRole(actorUserId);
    await this.processEngine.transition(FULFILLMENT_TASK_PROCESS, 'pick_task', pickTaskId, action, actorUserId);
    const newState = await this.processEngine.getState(FULFILLMENT_TASK_PROCESS, 'pick_task', pickTaskId);

    let packTaskId: string | null = null;
    if (newState === 'closed') {
      // Pick verified closed -> auto-create the Pack Task (blueprint §24).
      const pickTask = await this.dataSource.getRepository(PickTask).findOne({ where: { id: pickTaskId } });
      const packTask = await this.dataSource.transaction(async (manager) => {
        const packRepo = manager.getRepository(PackTask);
        const created = await packRepo.save(
          packRepo.create({ fulfillmentOrderId: pickTask!.fulfillmentOrderId, assignedToUserId: null }),
        );
        await this.events.publish(manager, 'fulfillment.pick.completed', {
          pickTaskId,
          fulfillmentOrderId: pickTask!.fulfillmentOrderId,
        });
        return created;
      });
      await this.processEngine.start(FULFILLMENT_TASK_PROCESS, 'pack_task', packTask.id);
      packTaskId = packTask.id;
    }

    return { state: newState, packTaskId };
  }

  // ---- Item Preparation (CTO directive — "PRIORITY: ITEM PREPARATION") ----

  async listPickTaskLines(pickTaskId: string): Promise<PickTaskLine[]> {
    return this.dataSource.getRepository(PickTaskLine).find({ where: { pickTaskId }, order: { createdAt: 'ASC' } });
  }

  /**
   * The "مخزن تحت التجهيز" (Under Preparation) sub-location: one shared
   * Operational Sub-location per parent (main) warehouse, auto-provisioned
   * on first use — never created directly by a user, same discipline as
   * `ShipmentService.provisionCustodianResources` for its own custodians.
   * Get-or-create, not create-on-every-call: checked first via
   * `InventoryService.findOperationalSubLocation`, matching
   * `ShipmentService`'s own precedent of no extra locking around this
   * rare, effectively-once-per-warehouse provisioning step.
   */
  private async getOrCreatePreparationWarehouse(parentWarehouseId: string): Promise<string> {
    const existing = await this.inventory.findOperationalSubLocation(parentWarehouseId, `${PREPARATION_WAREHOUSE_CODE_PREFIX}-`);
    if (existing) return existing.id;

    await this.numbering.registerDocumentType(PREPARATION_WAREHOUSE_DOCUMENT_TYPE, PREPARATION_WAREHOUSE_CODE_PREFIX, false);
    const code = await this.numbering.getNextNumber(PREPARATION_WAREHOUSE_DOCUMENT_TYPE);
    const warehouse = await this.inventory.createWarehouse(code, 'تحت التجهيز', null, null, parentWarehouseId, 'operational');
    return warehouse.id;
  }

  /**
   * The per-item "تم" action (CTO directive item 2): records the actual
   * quantity just prepared, moves that exact quantity in the real
   * inventory ledger from the fulfillment order's warehouse into the
   * "Under Preparation" sub-location (`InventoryService.
   * relocateReservedStock` — the reservation itself moves too, so
   * Free/Reserved/Available stay accurate at both locations), and — once
   * EVERY line on this pick task is fully prepared — auto-advances the
   * Pick Task through the SAME Process Engine transition a worker would
   * otherwise click by hand ("انتقال إلى مراجعة التجهيز", directive
   * item 3). Callable multiple times per line (partial preparation),
   * `quantity` capped at whatever remains outstanding for that line.
   */
  async markPickTaskLineDone(
    pickTaskId: string,
    lineId: string,
    quantity: number,
    actorUserId: string,
  ): Promise<PickTaskLine> {
    await this.requireWorkerRole(actorUserId);

    const state = await this.processEngine.getState(FULFILLMENT_TASK_PROCESS, 'pick_task', pickTaskId);
    if (state !== 'in_progress') {
      throw new ConflictException(`Cannot prepare items while the pick task is in state "${state}" — start preparation first.`);
    }

    const lineRepo = this.dataSource.getRepository(PickTaskLine);
    const line = await lineRepo.findOne({ where: { id: lineId, pickTaskId } });
    if (!line) throw new NotFoundException(`Pick task line "${lineId}" not found on this task.`);
    if (line.status === 'prepared') {
      throw new ConflictException('This item is already fully prepared.');
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Prepared quantity must be a positive whole number.');
    }
    const remaining = line.requestedQuantity - line.preparedQuantity;
    if (quantity > remaining) {
      throw new BadRequestException(`Cannot prepare ${quantity} — only ${remaining} remain for this item.`);
    }

    const pickTask = await this.dataSource.getRepository(PickTask).findOne({ where: { id: pickTaskId } });
    const fulfillmentOrder = await this.getFulfillmentOrder(pickTask!.fulfillmentOrderId);
    const preparationWarehouseId = await this.getOrCreatePreparationWarehouse(fulfillmentOrder.warehouseId);

    const before = { preparedQuantity: line.preparedQuantity, status: line.status };

    await this.inventory.relocateReservedStock(
      fulfillmentOrder.salesOrderId,
      line.productId,
      fulfillmentOrder.warehouseId,
      preparationWarehouseId,
      quantity,
      'pick_task_line',
      line.id,
      actorUserId,
    );

    line.preparedQuantity += quantity;
    line.status = line.preparedQuantity >= line.requestedQuantity ? 'prepared' : 'pending';
    line.preparedByUserId = actorUserId;
    line.preparedAt = new Date();
    const saved = await lineRepo.save(line);

    // Audit fields per the directive's own list: user (actorUserId, via
    // AuditService), date/time (automatic), order, item, quantity,
    // previous status, new status.
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'fulfillment.pick_task_line.prepared',
      resource: 'pick_task_line',
      resourceId: line.id,
      result: 'success',
      correlationId: null,
      before,
      after: {
        preparedQuantity: line.preparedQuantity,
        status: line.status,
        quantityJustPrepared: quantity,
        salesOrderId: fulfillmentOrder.salesOrderId,
        productId: line.productId,
      },
    });

    const allLines = await lineRepo.find({ where: { pickTaskId } });
    if (allLines.every((l) => l.status === 'prepared')) {
      await this.transitionPickTask(pickTaskId, 'complete', actorUserId);
    }

    return saved;
  }

  /** The "تم للجميع" bulk action — marks every remaining line fully done, one `markPickTaskLineDone` call per line so no second code path exists for the same business rule. */
  async markAllPickTaskLinesDone(pickTaskId: string, actorUserId: string): Promise<PickTaskLine[]> {
    await this.requireWorkerRole(actorUserId);
    const lines = await this.listPickTaskLines(pickTaskId);
    const results: PickTaskLine[] = [];
    for (const line of lines) {
      const remaining = line.requestedQuantity - line.preparedQuantity;
      results.push(remaining > 0 ? await this.markPickTaskLineDone(pickTaskId, line.id, remaining, actorUserId) : line);
    }
    return results;
  }

  /**
   * "تم التغليف وجاهز للشحن" — one click, once every item is prepared
   * (pick task already sitting at `pending_verification`), straight to
   * "Ready for Shipping": runs Preparation Review's `verify` (closes the
   * pick task, auto-creates the Pack Task — existing behavior, unchanged)
   * then drives that SAME Pack Task through accept -> start -> complete ->
   * verify, back to back. Same convenience-action precedent as
   * `receiveAndStartPickTask` ("not a new state — just the existing
   * transitions run back-to-back") — every individual transition still
   * goes through the same Process Engine, still individually reachable
   * (and still auditable) via `transitionPickTask`/`transitionPackTask`
   * for anyone who needs the granular per-stage screen instead.
   */
  async finishPreparationAndReadyForShipping(pickTaskId: string, actorUserId: string): Promise<{ packTaskId: string; state: string }> {
    const state = await this.processEngine.getState(FULFILLMENT_TASK_PROCESS, 'pick_task', pickTaskId);
    if (state !== 'pending_verification') {
      throw new ConflictException(
        `Cannot finish packing while the pick task is in state "${state}" — every item must be prepared first.`,
      );
    }

    const { packTaskId } = await this.transitionPickTask(pickTaskId, 'verify', actorUserId);
    if (!packTaskId) {
      throw new ConflictException('Preparation review did not produce a pack task — cannot continue to packing.');
    }

    await this.transitionPackTask(packTaskId, 'accept', actorUserId);
    await this.transitionPackTask(packTaskId, 'start', actorUserId);
    await this.transitionPackTask(packTaskId, 'complete', actorUserId);
    const finalState = await this.transitionPackTask(packTaskId, 'verify', actorUserId);

    return { packTaskId, state: finalState };
  }

  async transitionPackTask(packTaskId: string, action: string, actorUserId: string): Promise<string> {
    await this.requireWorkerRole(actorUserId);
    await this.processEngine.transition(FULFILLMENT_TASK_PROCESS, 'pack_task', packTaskId, action, actorUserId);
    const newState = await this.processEngine.getState(FULFILLMENT_TASK_PROCESS, 'pack_task', packTaskId);

    if (newState === 'closed') {
      // Pack verified closed -> ready to hand off to Shipping. Deliberately
      // NO ledger dispatch here any more (CTO directive — reconcile the
      // Preparation -> Shipping handoff, "no premature inventory
      // deduction"): this used to call `InventoryService.fulfillReservation`
      // for every line at this exact point, which was a real bug — it
      // zeroed the reservation and removed the stock from the ledger
      // entirely BEFORE a Shipment/pickup/custody-transfer even existed,
      // so `ShipmentService`'s later custody transfer at pickup had nothing
      // real left to move. The goods are still company property, still
      // physically sitting wherever Preparation put them (the "تحت
      // التجهيز" sub-location) — every reservation stays `active` through
      // Shipping's custody transfer(s), and the final ledger exit now
      // happens exactly once, at actual Customer Delivery
      // (`DeliveryService.recordOutcome` -> `InventoryService.
      // fulfillReservationsForOrder`), matching the Warehouse/Sales Order
      // Ownership directive's own principle: "financial completion only
      // happens at actual Delivery."
      const packTask = await this.dataSource.getRepository(PackTask).findOne({ where: { id: packTaskId } });
      const fulfillmentOrder = await this.dataSource
        .getRepository(FulfillmentOrder)
        .findOne({ where: { id: packTask!.fulfillmentOrderId } });

      await this.dataSource.transaction(async (manager) => {
        await this.events.publish(manager, 'fulfillment.ready-for-dispatch', {
          fulfillmentOrderId: fulfillmentOrder!.id,
          salesOrderId: fulfillmentOrder!.salesOrderId,
        });
      });
      // RSH Shipping Orders (CTO directive §3) — flush immediately, same
      // in-request pattern as products.service.ts's own dispatchPending()
      // calls. Without this, the event above is written but never
      // delivered to ShipmentService's subscriber (confirmed: this call
      // was previously missing entirely, leaving the event permanently
      // undispatched).
      await this.events.dispatchPending();
    }

    return newState;
  }
}
