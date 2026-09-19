import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { WorkOrder } from '../infrastructure/work-order.entity';
import { WorkOrderComponent } from '../infrastructure/work-order-component.entity';
import { WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE } from '../domain/work-order-process';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { SALES_BOM_CONTRACT, SalesBomContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';

/**
 * ADR-061 — Manufacturing Production & Costing Integration Contract.
 * Implements Work Order creation/release/lifecycle, Material Issue,
 * Material Return, and Finished Goods Output exactly per §§3/5/6/7/13,
 * including every mandatory guard (§5's no-over-issue, §7's
 * no-over-production and physical-availability guards, §3's
 * WIP-must-be-zero completion guard).
 *
 * `InventoryValuationContract` (F08) is a REQUIRED dependency here (not
 * `@Optional()` the way `InventoryService` treats it) — D1 (Actual/
 * Moving-Average costing) has no meaning without it; an installation
 * without F08 bound simply cannot run Manufacturing.
 */
@Injectable()
export class WorkOrderService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly inventory: InventoryService,
    private readonly numbering: NumberingService,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    @Inject(SALES_BOM_CONTRACT) private readonly bom: SalesBomContract,
    @Inject(INVENTORY_VALUATION_CONTRACT) private readonly valuation: InventoryValuationContract,
  ) {}

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  async getWorkOrderOrThrow(workOrderId: string): Promise<WorkOrder> {
    const wo = await this.dataSource.getRepository(WorkOrder).findOne({ where: { id: workOrderId } });
    if (!wo) throw new NotFoundException(`Work Order "${workOrderId}" not found.`);
    return wo;
  }

  async listWorkOrders(): Promise<WorkOrder[]> {
    return this.dataSource.getRepository(WorkOrder).find({ order: { createdAt: 'DESC' } });
  }

  async getWorkOrderState(workOrderId: string): Promise<string> {
    return this.processEngine.getState(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, workOrderId);
  }

  async getWorkOrderComponents(workOrderId: string): Promise<WorkOrderComponent[]> {
    return this.dataSource.getRepository(WorkOrderComponent).find({ where: { workOrderId } });
  }

  /**
   * ADR-061 §6 — WIP(WO).value is ALWAYS computed, never a stored/cached
   * number. Reads F08's own `totalValueBase` directly (via
   * `getValuedOnHandTotal`, grouped by warehouse) rather than
   * re-deriving `onHand × unitCost` in JS — the latter incorrectly
   * collapses to zero for any component whose on-hand quantity has hit
   * zero (its `averageCostBase` goes `null` at that point, per F08's own
   * "weighted average is undefined for zero quantity" rule) even though
   * a real leftover dollar value can still legitimately sit in
   * `totalValueBase` after a policy-valued (§7) consumption — that
   * leftover is real, carried-forward money, not lost until the next
   * receipt/consumption for that component touches it again. Since a
   * Work Order's WIP sub-warehouse only ever holds that one Work Order's
   * material, the WHOLE warehouse row from `getValuedOnHandTotal` IS
   * `WIP(WO).value` — no per-component loop needed.
   */
  async computeWipValue(workOrderId: string): Promise<number> {
    const wo = await this.getWorkOrderOrThrow(workOrderId);
    if (!wo.wipWarehouseId) return 0;
    const rows = await this.valuation.getValuedOnHandTotal(undefined, this.dataSource.manager);
    const row = rows.find((r) => r.warehouseId === wo.wipWarehouseId);
    return row ? Number(row.totalValueBase) : 0;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  async createWorkOrder(finishedProductId: string, quantityPlanned: number, warehouseId: string, actorUserId: string | null): Promise<WorkOrder> {
    if (!Number.isInteger(quantityPlanned) || quantityPlanned <= 0) {
      throw new ConflictException('quantityPlanned must be a positive whole number.');
    }
    return this.dataSource.transaction(async (manager) => {
      const workOrderNumber = await this.numbering.getNextNumber('work_order', manager);
      const repo = manager.getRepository(WorkOrder);
      const wo = await repo.save(repo.create({ workOrderNumber, finishedProductId, quantityPlanned, warehouseId, createdByUserId: actorUserId }));
      await this.processEngine.start(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, wo.id, manager);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'manufacturing.work_order.created',
          resource: 'work_order',
          resourceId: wo.id,
          result: 'success',
          correlationId: null,
          after: { workOrderNumber, finishedProductId, quantityPlanned, warehouseId },
        },
        manager,
      );
      return wo;
    });
  }

  /**
   * ADR-061 §2/§3/§6 — takes the BOM snapshot, reserves every component
   * (Option A generic reference, see `stock-reservation.entity.ts`), and
   * auto-creates the Work Order's dedicated WIP sub-warehouse. Warehouse
   * creation is its own step first (`InventoryService.createWarehouse` is
   * not itself transactional, matching every other caller of it in this
   * codebase) — idempotent via `findOperationalSubLocation` so a retried
   * release never creates a second WIP warehouse for the same Work Order.
   */
  async release(workOrderId: string, actorUserId: string | null): Promise<WorkOrder> {
    const wo = await this.getWorkOrderOrThrow(workOrderId);
    const state = await this.getWorkOrderState(workOrderId);
    if (state !== 'draft') throw new ConflictException(`Work Order "${workOrderId}" cannot be released from state "${state}".`);

    const bomLines = await this.bom.getBomForAssembly(wo.finishedProductId);
    if (!bomLines || bomLines.length === 0) {
      throw new ConflictException(`Finished product "${wo.finishedProductId}" has no Bill of Materials — cannot release a Work Order for it.`);
    }

    const wipCode = `WIP-${wo.workOrderNumber}`;
    let wipWarehouse = await this.inventory.findOperationalSubLocation(wo.warehouseId, wipCode);
    if (!wipWarehouse) {
      wipWarehouse = await this.inventory.createWarehouse(wipCode, `WIP — ${wo.workOrderNumber}`, null, null, wo.warehouseId, 'operational');
    }
    const wipWarehouseId = wipWarehouse.id;

    return this.dataSource.transaction(async (manager) => {
      const componentRepo = manager.getRepository(WorkOrderComponent);
      for (const line of bomLines) {
        const quantityRequired = line.quantityPerUnit * wo.quantityPlanned;
        const currentCost = await this.valuation.getUnitCost(line.componentProductId, wo.warehouseId, undefined, manager);
        await componentRepo.save(
          componentRepo.create({
            workOrderId: wo.id,
            componentProductId: line.componentProductId,
            quantityRequired,
            unitCostAtRelease: currentCost?.unitCostBase ?? null,
          }),
        );
        await this.inventory.reserveStockForReferenceInTransaction(
          manager,
          wo.warehouseId,
          line.componentProductId,
          quantityRequired,
          'WORK_ORDER',
          wo.id,
          actorUserId,
        );
      }

      const woRepo = manager.getRepository(WorkOrder);
      await woRepo.update(wo.id, { wipWarehouseId });
      await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, wo.id, 'release', actorUserId, manager);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'manufacturing.work_order.released',
          resource: 'work_order',
          resourceId: wo.id,
          result: 'success',
          correlationId: null,
          after: { wipWarehouseId, componentCount: bomLines.length },
        },
        manager,
      );

      return (await woRepo.findOne({ where: { id: wo.id } }))!;
    });
  }

  /**
   * ADR-061 §5 — Material Issue: real warehouse → WIP, physical + valued,
   * with the no-over-issue guard. `requestId` is the caller's own
   * idempotency key (§16 — "no Manufacturing movement can be
   * double-posted by a retried request"): a genuinely retried HTTP call
   * MUST pass the SAME `requestId` so the derived Financial Event
   * idempotency keys stay identical across retries. Defaults to a fresh
   * UUID only when the caller supplies none — that specific call then has
   * no retry protection of its own, a disclosed limitation, not a silent
   * one.
   */
  async materialIssue(
    workOrderId: string,
    componentProductId: string,
    issueQuantity: number,
    actorUserId: string | null,
    requestId: string = randomUUID(),
  ): Promise<void> {
    if (!Number.isInteger(issueQuantity) || issueQuantity <= 0) {
      throw new ConflictException('issueQuantity must be a positive whole number.');
    }
    const wo = await this.getWorkOrderOrThrow(workOrderId);
    const state = await this.getWorkOrderState(workOrderId);
    if (state !== 'released' && state !== 'in_progress') {
      throw new ConflictException(`Work Order "${workOrderId}" cannot accept a Material Issue from state "${state}".`);
    }
    if (!wo.wipWarehouseId) throw new ConflictException(`Work Order "${workOrderId}" has no WIP sub-warehouse — release it first.`);

    await this.dataSource.transaction(async (manager) => {
      const componentRepo = manager.getRepository(WorkOrderComponent);
      const component = await componentRepo.findOne({ where: { workOrderId, componentProductId } });
      if (!component) throw new ConflictException(`Component "${componentProductId}" is not part of Work Order "${workOrderId}"'s released BOM snapshot.`);

      // ADR-061 §5 — hard guard: no over-issue.
      if (component.quantityIssued + issueQuantity > component.quantityRequired) {
        throw new ConflictException(
          `Cannot issue ${issueQuantity} of "${componentProductId}" — would exceed quantityRequired (${component.quantityRequired}); already issued ${component.quantityIssued}.`,
        );
      }

      const keys = [`${wo.warehouseId}:${componentProductId}`, `${wo.wipWarehouseId}:${componentProductId}`].sort();
      for (const key of keys) await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

      const issueLineId = requestId;
      const consumed = await this.valuation.consumeIssueCost(
        componentProductId,
        wo.warehouseId,
        issueQuantity,
        `manufacturing:work_order:${wo.id}:material_issue:${issueLineId}:consume`,
        manager,
      );
      if (!consumed || 'rejected' in consumed) {
        throw new ConflictException(`Cannot issue ${issueQuantity} of "${componentProductId}" from warehouse "${wo.warehouseId}" — insufficient valued stock.`);
      }

      await this.inventory.recordMovement(wo.warehouseId, componentProductId, -issueQuantity, 'work_order_material_issue', 'work_order', wo.id, actorUserId, manager);
      await this.inventory.recordMovement(wo.wipWarehouseId!, componentProductId, issueQuantity, 'work_order_material_issue', 'work_order', wo.id, actorUserId, manager);
      await this.valuation.recordReceiptCost(
        componentProductId,
        wo.wipWarehouseId!,
        issueQuantity,
        consumed.unitCostBase,
        `manufacturing:work_order:${wo.id}:material_issue:${issueLineId}:receipt`,
        manager,
      );

      await this.inventory.releaseReservedQuantityForReference('WORK_ORDER', wo.id, componentProductId, wo.warehouseId, issueQuantity, actorUserId, manager);

      component.quantityIssued += issueQuantity;
      await componentRepo.save(component);

      if (state === 'released') {
        await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, wo.id, 'begin_production', actorUserId, manager);
      }

      await this.events.publish(manager, 'manufacturing.work_order.material_issued', {
        idempotencyKey: `manufacturing:work_order:${wo.id}:material_issue:${issueLineId}`,
        workOrderId: wo.id,
        componentProductId,
        quantity: issueQuantity,
        unitCostBase: consumed.unitCostBase,
        totalValueBase: consumed.totalCostBase,
      });

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'manufacturing.work_order.material_issued',
          resource: 'work_order',
          resourceId: wo.id,
          result: 'success',
          correlationId: null,
          after: { componentProductId, issueQuantity, unitCostBase: consumed.unitCostBase },
        },
        manager,
      );
    });
    // The outbox row `events.publish` wrote above only becomes a real GL entry once dispatched —
    // without this, it would sit `pending` until some unrelated later sweep, an accidental and
    // non-deterministic delay (same precedent `GoodsReceiptService.post` already established).
    await this.events.dispatchPending();
  }

  /**
   * ADR-061 §5 — Material Return: WIP → real warehouse, costed at WIP's
   * OWN current average (corrected rule), with the cumulative-issued
   * guard. `requestId` — see `materialIssue`'s doc comment.
   */
  async materialReturn(
    workOrderId: string,
    componentProductId: string,
    returnQuantity: number,
    actorUserId: string | null,
    requestId: string = randomUUID(),
  ): Promise<void> {
    if (!Number.isInteger(returnQuantity) || returnQuantity <= 0) {
      throw new ConflictException('returnQuantity must be a positive whole number.');
    }
    const wo = await this.getWorkOrderOrThrow(workOrderId);
    const state = await this.getWorkOrderState(workOrderId);
    if (state !== 'in_progress' && state !== 'on_hold') {
      throw new ConflictException(`Work Order "${workOrderId}" cannot accept a Material Return from state "${state}".`);
    }
    if (!wo.wipWarehouseId) throw new ConflictException(`Work Order "${workOrderId}" has no WIP sub-warehouse.`);

    await this.dataSource.transaction(async (manager) => {
      const componentRepo = manager.getRepository(WorkOrderComponent);
      const component = await componentRepo.findOne({ where: { workOrderId, componentProductId } });
      if (!component) throw new ConflictException(`Component "${componentProductId}" is not part of Work Order "${workOrderId}".`);

      // ADR-061 §5 — a return may not exceed the WO's own cumulative issued-minus-already-returned quantity.
      if (returnQuantity > component.quantityIssued) {
        throw new ConflictException(
          `Cannot return ${returnQuantity} of "${componentProductId}" — only ${component.quantityIssued} is currently issued (net of prior returns).`,
        );
      }

      const keys = [`${wo.warehouseId}:${componentProductId}`, `${wo.wipWarehouseId}:${componentProductId}`].sort();
      for (const key of keys) await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

      const returnLineId = requestId;
      // Corrected costing rule (§5) — WIP's OWN current moving-average cost, never the original issue's cost.
      const consumed = await this.valuation.consumeIssueCost(
        componentProductId,
        wo.wipWarehouseId!,
        returnQuantity,
        `manufacturing:work_order:${wo.id}:material_return:${returnLineId}:consume`,
        manager,
      );
      if (!consumed || 'rejected' in consumed) {
        throw new ConflictException(`Cannot return ${returnQuantity} of "${componentProductId}" — insufficient physical/valued stock in the Work Order's WIP.`);
      }

      await this.inventory.recordMovement(wo.wipWarehouseId!, componentProductId, -returnQuantity, 'work_order_material_return', 'work_order', wo.id, actorUserId, manager);
      await this.inventory.recordMovement(wo.warehouseId, componentProductId, returnQuantity, 'work_order_material_return', 'work_order', wo.id, actorUserId, manager);
      await this.valuation.recordReceiptCost(
        componentProductId,
        wo.warehouseId,
        returnQuantity,
        consumed.unitCostBase,
        `manufacturing:work_order:${wo.id}:material_return:${returnLineId}:receipt`,
        manager,
      );

      // Re-reserve the returned quantity for THIS Work Order — a return puts the physical unit
      // back in the real warehouse, but it is still within this Work Order's plan entitlement
      // (quantityRequired), not released to general availability. This is what lets a later
      // Material Issue re-draw the same quantity (ADR-061 §8's worked example does exactly this)
      // without ever needing more than quantityRequired reserved in total, and keeps the
      // reservation balance consistent with quantityRequired − quantityIssued at every point.
      await this.inventory.reserveStockForReferenceInTransaction(manager, wo.warehouseId, componentProductId, returnQuantity, 'WORK_ORDER', wo.id, actorUserId);

      component.quantityIssued -= returnQuantity;
      await componentRepo.save(component);

      await this.events.publish(manager, 'manufacturing.work_order.material_returned', {
        idempotencyKey: `manufacturing:work_order:${wo.id}:material_return:${returnLineId}`,
        workOrderId: wo.id,
        componentProductId,
        quantity: returnQuantity,
        unitCostBase: consumed.unitCostBase,
        totalValueBase: consumed.totalCostBase,
      });

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'manufacturing.work_order.material_returned',
          resource: 'work_order',
          resourceId: wo.id,
          result: 'success',
          correlationId: null,
          after: { componentProductId, returnQuantity, unitCostBase: consumed.unitCostBase },
        },
        manager,
      );
    });
    await this.events.dispatchPending();
  }

  /**
   * ADR-061 §7 — Finished Goods Output. Enforces the over-production
   * guard, the physical-availability guard (per component, all-or-
   * nothing), applies the Work-Order-pooled cost formula for the GL
   * amount, and attributes it across components pro-rata by each one's
   * own natural (qty × its own average) share purely for F08's
   * per-component bookkeeping (§7 point 5) via the narrowly-scoped
   * `consumeManufacturingPooledCost` override.
   */
  async finishedGoodsOutput(
    workOrderId: string,
    outputQuantity: number,
    actorUserId: string | null,
    requestId: string = randomUUID(),
  ): Promise<void> {
    if (!Number.isInteger(outputQuantity) || outputQuantity <= 0) {
      throw new ConflictException('outputQuantity must be a positive whole number.');
    }
    const wo = await this.getWorkOrderOrThrow(workOrderId);
    const state = await this.getWorkOrderState(workOrderId);
    if (state !== 'in_progress') {
      throw new ConflictException(`Work Order "${workOrderId}" cannot record a Finished Goods Output from state "${state}".`);
    }
    if (!wo.wipWarehouseId) throw new ConflictException(`Work Order "${workOrderId}" has no WIP sub-warehouse.`);

    // ADR-061 §7 — hard guard: no over-production beyond plan.
    if (wo.quantityProduced + outputQuantity > wo.quantityPlanned) {
      throw new ConflictException(
        `Cannot output ${outputQuantity} — Work Order "${workOrderId}" has only ${wo.quantityPlanned - wo.quantityProduced} remaining of its ${wo.quantityPlanned}-unit plan.`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const componentRepo = manager.getRepository(WorkOrderComponent);
      const components = await componentRepo.find({ where: { workOrderId: wo.id } });
      if (components.length === 0) throw new ConflictException(`Work Order "${workOrderId}" has no components — cannot produce.`);

      const lockKeys = new Set<string>();
      for (const c of components) lockKeys.add(`${wo.wipWarehouseId}:${c.componentProductId}`);
      lockKeys.add(`${wo.warehouseId}:${wo.finishedProductId}`);
      for (const key of Array.from(lockKeys).sort()) await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

      // ADR-061 §6/§7 — WIP(WO).value_before, read as F08's own authoritative `totalValueBase` for
      // the WIP sub-warehouse (see `computeWipValue`'s doc comment for why this must NOT be
      // re-derived as Σ(onHand × unitCost) in JS: a component whose on-hand hit zero after a prior
      // policy-valued consumption carries a null average but a real leftover `totalValueBase`).
      const wipTotals = await this.valuation.getValuedOnHandTotal(undefined, manager);
      const wipValueBefore = Number(wipTotals.find((r) => r.warehouseId === wo.wipWarehouseId)?.totalValueBase ?? 0);

      const perComponent: Array<{ componentProductId: string; onHand: number; unitCost: number; qtyConsumed: number }> = [];
      for (const c of components) {
        const onHand = await this.inventory.getOnHandQuantityInTransaction(manager, wo.wipWarehouseId!, c.componentProductId);
        const costRow = await this.valuation.getUnitCost(c.componentProductId, wo.wipWarehouseId!, undefined, manager);
        const unitCost = costRow ? Number(costRow.unitCostBase) : 0;

        // ADR-061 §7 points 1/2 — physical quantity consumed, tied to the BOM snapshot.
        // (quantityRequired × outputQuantity) is ALWAYS an exact multiple of quantityPlanned by
        // construction (quantityRequired = BOM.quantityPerUnit × quantityPlanned, both integers,
        // per §2/§3), so this division never truncates in real operation — asserted, not assumed.
        const qtyConsumedRaw = (c.quantityRequired * outputQuantity) / wo.quantityPlanned;
        const qtyConsumed = Math.round(qtyConsumedRaw);
        if (Math.abs(qtyConsumedRaw - qtyConsumed) > 1e-6) {
          throw new ConflictException(
            `Internal consistency error: component "${c.componentProductId}"'s quantityRequired (${c.quantityRequired}) is not an exact multiple of quantityPlanned (${wo.quantityPlanned}) for output quantity ${outputQuantity}.`,
          );
        }
        perComponent.push({ componentProductId: c.componentProductId, onHand, unitCost, qtyConsumed });
      }

      // ADR-061 §7 point 4 — hard guard: physical availability, checked for EVERY component before any write (all-or-nothing).
      for (const p of perComponent) {
        if (p.qtyConsumed > p.onHand) {
          throw new ConflictException(
            `Cannot produce ${outputQuantity} units — component "${p.componentProductId}" needs ${p.qtyConsumed} physically on hand in the Work Order's WIP, only ${p.onHand} is there.`,
          );
        }
      }

      // ADR-061 §7 — the ratified, Work-Order-pooled cost formula. When this output exactly
      // exhausts the remaining plan (the common "final output" case), `valueOutput` is set to
      // `wipValueBefore` DIRECTLY rather than via `(wipValueBefore / N) * N` — algebraically
      // identical, but avoids a floating-point round-trip that could otherwise make the applied
      // total a fraction of a cent larger than what F08 actually holds, tripping the
      // `value_exceeds_on_hand` guard on the exact case that most needs to land at precisely zero.
      const remainingPlannedQtyBefore = wo.quantityPlanned - wo.quantityProduced;
      const isFinalOutputOfRemainingPlan = outputQuantity === remainingPlannedQtyBefore;
      const valueOutput = isFinalOutputOfRemainingPlan ? wipValueBefore : (wipValueBefore / remainingPlannedQtyBefore) * outputQuantity;
      // Recomputed from the FINAL valueOutput (not the other way around) so the per-unit rate fed
      // to `recordReceiptCost` below always reconciles exactly with the GL-posted total, in both branches.
      const unitCostOutput = valueOutput / outputQuantity;

      // ADR-061 §7 point 5 — pro-rata attribution of valueOutput across components, by each
      // one's OWN natural (qty × its own average) share; never double-counted. The LAST
      // component consuming a non-zero quantity is given the exact REMAINDER (valueOutput minus
      // every other component's already-rounded share) instead of its own computed share, so the
      // sum of every component's `appliedValueBase` always reconciles to `valueOutput` exactly,
      // regardless of individual rounding.
      const naturalTotal = perComponent.reduce((sum, p) => sum + p.qtyConsumed * p.unitCost, 0);
      const consuming = perComponent.filter((p) => p.qtyConsumed > 0);

      const outputEventId = requestId;
      let allocatedSoFar = 0;
      for (let i = 0; i < consuming.length; i++) {
        const p = consuming[i];
        const isLast = i === consuming.length - 1;
        let appliedValueBase: string;
        if (isLast) {
          appliedValueBase = (valueOutput - allocatedSoFar).toFixed(4);
        } else {
          const share = naturalTotal > 0 ? (p.qtyConsumed * p.unitCost) / naturalTotal : p.qtyConsumed / outputQuantity;
          appliedValueBase = (valueOutput * share).toFixed(4);
          allocatedSoFar += Number(appliedValueBase);
        }

        const consumeResult = await this.valuation.consumeManufacturingPooledCost(
          p.componentProductId,
          wo.wipWarehouseId!,
          p.qtyConsumed,
          appliedValueBase,
          `manufacturing:work_order:${wo.id}:fg_output:${outputEventId}:${p.componentProductId}`,
          manager,
        );
        if (!consumeResult || 'rejected' in consumeResult) {
          throw new ConflictException(`Finished Goods Output failed applying the policy-valued consumption for component "${p.componentProductId}".`);
        }
        await this.inventory.recordMovement(
          wo.wipWarehouseId!,
          p.componentProductId,
          -p.qtyConsumed,
          'work_order_finished_goods_output',
          'work_order',
          wo.id,
          actorUserId,
          manager,
        );
      }

      await this.inventory.recordMovement(wo.warehouseId, wo.finishedProductId, outputQuantity, 'work_order_finished_goods_output', 'work_order', wo.id, actorUserId, manager);
      await this.valuation.recordReceiptCost(
        wo.finishedProductId,
        wo.warehouseId,
        outputQuantity,
        unitCostOutput.toFixed(4),
        `manufacturing:work_order:${wo.id}:fg_output:${outputEventId}:receipt`,
        manager,
      );

      const woRepo = manager.getRepository(WorkOrder);
      await woRepo.update(wo.id, { quantityProduced: wo.quantityProduced + outputQuantity });

      await this.events.publish(manager, 'manufacturing.work_order.finished_goods_received', {
        idempotencyKey: `manufacturing:work_order:${wo.id}:fg_output:${outputEventId}`,
        workOrderId: wo.id,
        finishedProductId: wo.finishedProductId,
        quantity: outputQuantity,
        unitCostBase: unitCostOutput.toFixed(4),
        totalValueBase: valueOutput.toFixed(4),
      });

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'manufacturing.work_order.finished_goods_received',
          resource: 'work_order',
          resourceId: wo.id,
          result: 'success',
          correlationId: null,
          after: { outputQuantity, unitCostOutput: unitCostOutput.toFixed(4), valueOutput: valueOutput.toFixed(4) },
        },
        manager,
      );
    });
    await this.events.dispatchPending();
  }

  /**
   * A Work Order that will never issue again (completing, or cancelling
   * from `released`) must give back whatever reservation is still held
   * for it — otherwise that stock stays permanently earmarked and
   * unavailable to anyone else. Releases, per component, exactly
   * `quantityRequired − quantityIssued` (the only amount that can still
   * legitimately be reserved at this point), and only if that is > 0.
   */
  private async releaseRemainingReservations(workOrderId: string, warehouseId: string, actorUserId: string | null, manager = this.dataSource.manager): Promise<void> {
    const components = await manager.getRepository(WorkOrderComponent).find({ where: { workOrderId } });
    for (const c of components) {
      const remaining = c.quantityRequired - c.quantityIssued;
      if (remaining <= 0) continue;
      await this.inventory.releaseReservedQuantityForReference('WORK_ORDER', workOrderId, c.componentProductId, warehouseId, remaining, actorUserId, manager);
    }
  }

  async hold(workOrderId: string, actorUserId: string | null): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, workOrderId, 'hold', actorUserId, manager);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.held', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: null },
        manager,
      );
    });
  }

  async resume(workOrderId: string, actorUserId: string | null): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, workOrderId, 'resume', actorUserId, manager);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.resumed', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: null },
        manager,
      );
    });
  }

  /** ADR-061 §3 — hard guard: WIP(WO).value must be exactly zero (within rounding tolerance) before completion. */
  async complete(workOrderId: string, actorUserId: string | null): Promise<void> {
    const wo = await this.getWorkOrderOrThrow(workOrderId);
    if (!wo.wipWarehouseId) throw new ConflictException(`Work Order "${workOrderId}" has no WIP sub-warehouse.`);

    const wipValue = await this.computeWipValue(workOrderId);
    const TOLERANCE = 0.01;
    if (Math.abs(wipValue) > TOLERANCE) {
      throw new ConflictException(
        `Cannot complete Work Order "${workOrderId}" — its WIP balance is ${wipValue.toFixed(4)}, not zero. Material-Return any remaining unconsumed component value first.`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, workOrderId, 'complete', actorUserId, manager);
      await this.releaseRemainingReservations(workOrderId, wo.warehouseId, actorUserId, manager);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'manufacturing.work_order.completed',
          resource: 'work_order',
          resourceId: workOrderId,
          result: 'success',
          correlationId: null,
          after: { wipValue: wipValue.toFixed(4) },
        },
        manager,
      );
    });
  }

  /** ADR-061 §3 — `released -> cancelled` only if zero material has been issued; `draft -> cancelled` always allowed. */
  async cancel(workOrderId: string, actorUserId: string | null): Promise<void> {
    const wo = await this.getWorkOrderOrThrow(workOrderId);
    const state = await this.getWorkOrderState(workOrderId);
    if (state === 'released') {
      const components = await this.getWorkOrderComponents(workOrderId);
      if (components.some((c) => c.quantityIssued > 0)) {
        throw new ConflictException(`Cannot cancel Work Order "${workOrderId}" from "released" — material has already been issued.`);
      }
    } else if (state !== 'draft') {
      throw new ConflictException(`Work Order "${workOrderId}" cannot be cancelled from state "${state}".`);
    }

    await this.dataSource.transaction(async (manager) => {
      await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, workOrderId, 'cancel', actorUserId, manager);
      if (state === 'released') {
        await this.releaseRemainingReservations(workOrderId, wo.warehouseId, actorUserId, manager);
      }
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.cancelled', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: null },
        manager,
      );
    });
  }
}
