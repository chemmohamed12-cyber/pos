import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, Like } from 'typeorm';
import { WorkOrder } from '../infrastructure/work-order.entity';
import { WorkOrderComponent } from '../infrastructure/work-order-component.entity';
import { WorkOrderOperation } from '../infrastructure/work-order-operation.entity';
import { WorkOrderResult } from '../infrastructure/work-order-result.entity';
import { RoutingService } from './routing.service';
import { ProcessDefinitionService } from './process-definition.service';
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
    private readonly routings: RoutingService,
    @Optional() private readonly processes?: ProcessDefinitionService,
    // D6 (UX stage 5): the accounting pre-flight for scrap / recovery; absent / unbound => no GL => no gate (same pattern as the inventory posting policy)
    @Optional() private readonly postingPolicy?: InventoryPostingPolicyRegistry,
  ) {}

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  async getWorkOrderOrThrow(workOrderId: string, manager?: EntityManager): Promise<WorkOrder> {
    const wo = await (manager ?? this.dataSource).getRepository(WorkOrder).findOne({ where: { id: workOrderId } });
    if (!wo) throw new NotFoundException(`Work Order "${workOrderId}" not found.`);
    return wo;
  }

  /**
   * D6 - read-only: can scrap / recovery be recorded right now? Runs the SAME accounting pre-flight the operations run, so the screen can show the blocking reason (and where to fix it) BEFORE
   * the user fills a form. Exposes only a yes/no and the actionable message - never account balances or configuration values other than the key name already in the message.
   */
  async scrapReadiness(manager?: EntityManager): Promise<{ ready: boolean; reason: string | null }> {
    const gate = this.postingPolicy?.get()?.assertManufacturingScrapPostable;
    if (!gate) return { ready: true, reason: null };
    try {
      await this.postingPolicy!.get()!.assertManufacturingScrapPostable!('scrap', manager ?? this.dataSource.manager);
      await this.postingPolicy!.get()!.assertManufacturingScrapPostable!('recovery', manager ?? this.dataSource.manager);
      return { ready: true, reason: null };
    } catch (err) {
      if (err instanceof ConflictException) return { ready: false, reason: err.message };
      throw err;
    }
  }

  /** T-M-02 - the accounting prerequisites of Manufacturing and whether each is ready (read-only; reasons are actionable, no values are exposed). Empty when accounting is not installed. */
  async setupStatus(manager?: EntityManager): Promise<Array<{ code: string; ready: boolean; reason: string | null }>> {
    const status = this.postingPolicy?.get()?.manufacturingSetupStatus;
    if (!status) return [];
    return this.postingPolicy!.get()!.manufacturingSetupStatus!(manager ?? this.dataSource.manager);
  }

  async listWorkOrders(manager?: EntityManager): Promise<WorkOrder[]> {
    return (manager ?? this.dataSource).getRepository(WorkOrder).find({ order: { createdAt: 'DESC' } });
  }

  /**
   * Phase 2 (Manufacturing UI completion, team directive UI-02) — the list
   * view's own required columns (Status, WIP Value) are computed, not
   * stored, exactly like the single-Work-Order `get()` endpoint already
   * does (`getWorkOrderState`/`computeWipValue`) — this is the same
   * composition, just mapped over every row. No new business logic.
   */
  async listWorkOrdersWithSummary(manager?: EntityManager): Promise<Array<WorkOrder & { state: string; wipValue: string }>> {
    const workOrders = await this.listWorkOrders(manager);
    return Promise.all(
      workOrders.map(async (wo) => {
        const [state, wipValue] = await Promise.all([this.getWorkOrderState(wo.id, manager), this.computeWipValue(wo.id, manager)]);
        return { ...wo, state, wipValue: wipValue.toFixed(4) };
      }),
    );
  }

  async getWorkOrderState(workOrderId: string, manager?: EntityManager): Promise<string> {
    return this.processEngine.getState(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, workOrderId, manager);
  }

  /** ADR-061 Addendum 1 (A1) — the Work Order's routing snapshot (empty ⇒ no routing was active at release). */
  async getWorkOrderOperations(workOrderId: string, manager?: EntityManager): Promise<WorkOrderOperation[]> {
    return (manager ?? this.dataSource).getRepository(WorkOrderOperation).find({ where: { workOrderId }, order: { sequence: 'ASC' } });
  }

  async getWorkOrderComponents(workOrderId: string, manager?: EntityManager): Promise<WorkOrderComponent[]> {
    return (manager ?? this.dataSource).getRepository(WorkOrderComponent).find({ where: { workOrderId } });
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
  async computeWipValue(workOrderId: string, manager?: EntityManager): Promise<number> {
    const wo = await this.getWorkOrderOrThrow(workOrderId, manager);
    if (!wo.wipWarehouseId) return 0;
    const rows = await this.valuation.getValuedOnHandTotal(undefined, manager ?? this.dataSource.manager);
    const row = rows.find((r) => r.warehouseId === wo.wipWarehouseId);
    return row ? Number(row.totalValueBase) : 0;
  }

  /**
   * Phase 2 (Manufacturing UI completion, team directive UI-09 —
   * "Accounting / Traceability: Financial Events, GL reference, movement
   * references"). Read-only, keyed off the same deterministic
   * `manufacturing:work_order:<id>:*` idempotency-key prefix every
   * mutating method above already writes (§16) — never a second,
   * independently-maintained trail. Deliberately implemented HERE, inside
   * Manufacturing's own domain, reading the shared, cross-cutting
   * `accounting_financial_events`/`accounting_journal_lines`/
   * `accounting_gl_accounts` tables directly (the same class of shared
   * platform table `AuditService`'s own `audit_records` already is, not
   * another domain's PRIVATE schema) — so a viewer with only
   * `manufacturing.work_order.view` can see this Work Order's own
   * financial trail without also needing an `accounting.*` permission,
   * which routing this through Accounting's own
   * `/accounting/financial-events` endpoint would have required.
   */
  async getFinancialTrail(workOrderId: string, manager?: EntityManager): Promise<
    Array<{
      id: string;
      eventType: string;
      status: string;
      businessDate: string;
      rejectionReason: string | null;
      journalEntryId: string | null;
      lines: Array<{ accountCode: string; accountName: string; debitBase: string; creditBase: string }>;
    }>
  > {
    const events: Array<{
      id: string;
      eventType: string;
      status: string;
      businessDate: string;
      rejectionReason: string | null;
      journalEntryId: string | null;
    }> = await (manager ?? this.dataSource).query(
      `SELECT "id", "eventType", "status", "businessDate", "rejectionReason", "journalEntryId"
       FROM "accounting_financial_events"
       WHERE "idempotencyKey" LIKE $1
       ORDER BY "receivedAt" ASC`,
      [`manufacturing:work_order:${workOrderId}:%`],
    );
    if (events.length === 0) return [];

    const journalEntryIds = events.map((e) => e.journalEntryId).filter((id): id is string => id != null);
    const lines: Array<{ journalEntryId: string; accountCode: string; accountName: string; debitBase: string; creditBase: string }> =
      journalEntryIds.length === 0
        ? []
        : await (manager ?? this.dataSource).query(
            `SELECT jl."journalEntryId", a."code" AS "accountCode", a."name" AS "accountName", jl."debitBase", jl."creditBase"
             FROM "accounting_journal_lines" jl
             JOIN "accounting_gl_accounts" a ON a.id = jl."accountId"
             WHERE jl."journalEntryId" = ANY($1::uuid[])
             ORDER BY jl."lineNumber" ASC`,
            [journalEntryIds],
          );

    return events.map((e) => ({
      ...e,
      lines: lines.filter((l) => l.journalEntryId === e.journalEntryId).map(({ accountCode, accountName, debitBase, creditBase }) => ({ accountCode, accountName, debitBase, creditBase })),
    }));
  }

  /**
   * Phase 2 (Manufacturing UI completion, team directive UI-09 — "audit
   * trail"). Reads the shared, append-only `audit_records` table
   * (`AuditService`'s own table — every mutating method above already
   * calls `AuditService.record({ resource: 'work_order', resourceId:
   * wo.id, ... })`) filtered to this one Work Order. No new audit
   * mechanism; this is a read view over the one that already exists.
   */
  async getAuditTrail(
    workOrderId: string,
    manager?: EntityManager,
  ): Promise<Array<{ seq: number; timestamp: Date; action: string; actorUserId: string | null; result: string; after: Record<string, unknown> | null }>> {
    return (manager ?? this.dataSource).query(
      `SELECT "seq", "timestamp", "action", "actorUserId", "result", "after"
       FROM "audit_records"
       WHERE "resource" = 'work_order' AND "resourceId" = $1
       ORDER BY "seq" ASC`,
      [workOrderId],
    );
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  async createWorkOrder(finishedProductId: string, quantityPlanned: number, warehouseId: string, actorUserId: string | null, manager?: EntityManager): Promise<WorkOrder> {
    if (!Number.isInteger(quantityPlanned) || quantityPlanned <= 0) {
      throw new ConflictException('quantityPlanned must be a positive whole number.');
    }
    // ADR-061 Addendum 1 (A3) — manufacturing eligibility is DERIVED (an active BOM exists), and is now
    // enforced at creation, not only at release. `getBomForAssembly` is null for a missing/inactive BOM.
    const recipe = await this.bom.getBomForAssembly(finishedProductId, manager);
    if (!recipe || recipe.length === 0) {
      throw new ConflictException(
        `Finished product "${finishedProductId}" has no active Bill of Materials — define one (Manufacturing → Bills of Materials) before creating a Work Order for it.`,
      );
    }
    return (manager ?? this.dataSource).transaction(async (txManager) => {
      const workOrderNumber = await this.numbering.getNextNumber('work_order', txManager);
      const repo = txManager.getRepository(WorkOrder);
      // Org engine WP-C: the work order belongs to the branch of its production warehouse (resolved on the server, stamped once).
      const branchOrgUnitId = await this.inventory.getWarehouseBranchId(warehouseId, txManager);
      const wo = await repo.save(repo.create({ workOrderNumber, finishedProductId, quantityPlanned, warehouseId, branchOrgUnitId, createdByUserId: actorUserId }));
      await this.processEngine.start(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, wo.id, txManager);
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
        txManager,
      );
      return wo;
    });
  }

  /**
   * Manufacturing Engine S4 - an order that runs the product's ACTIVE process version instead of the flat BOM. The version and the alternate choices are fixed here; `release`
   * snapshots the raw requirements from the version (not from the BOM). Everything after (issue, output, scrap, completion) is the unchanged order lifecycle.
   */
  async createProcessWorkOrder(finishedProductId: string, quantityPlanned: number, warehouseId: string, choices: Record<string, string> | null, actorUserId: string | null, manager?: EntityManager): Promise<WorkOrder> {
    if (!this.processes) throw new ConflictException('Process definitions are not available in this installation.');
    if (!Number.isInteger(quantityPlanned) || quantityPlanned <= 0) throw new ConflictException('quantityPlanned must be a positive whole number.');
    const version = await this.processes.getActiveVersion(finishedProductId, manager);
    if (!version) throw new ConflictException(`Product "${finishedProductId}" has no ACTIVE process version - activate one (Manufacturing > Processes) first.`);
    const requirements = await this.processes.resolveRawRequirements(version.id, choices, manager); // also validates the choices
    if (requirements.length === 0) throw new ConflictException(`Process version ${version.versionNo} needs no raw material from stock - nothing to reserve or issue.`);
    return (manager ?? this.dataSource).transaction(async (txManager) => {
      const workOrderNumber = await this.numbering.getNextNumber('work_order', txManager);
      const repo = txManager.getRepository(WorkOrder);
      const wo = await repo.save(repo.create({ workOrderNumber, finishedProductId, quantityPlanned, warehouseId, createdByUserId: actorUserId, processVersionId: version.id, processChoices: choices ?? null }));
      await this.processEngine.start(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, wo.id, txManager);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.created', resource: 'work_order', resourceId: wo.id, result: 'success', correlationId: null, after: { workOrderNumber, finishedProductId, quantityPlanned, warehouseId, processVersionId: version.id, versionNo: version.versionNo } },
        txManager,
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
  async release(workOrderId: string, actorUserId: string | null, manager?: EntityManager): Promise<WorkOrder> {
    const wo = await this.getWorkOrderOrThrow(workOrderId, manager);
    const state = await this.getWorkOrderState(workOrderId, manager);
    if (state !== 'draft') throw new ConflictException(`Work Order "${workOrderId}" cannot be released from state "${state}".`);

    // S4: a process-bound order snapshots its raw requirements from the (immutable) process version; the Basic Profile keeps the flat BOM.
    const bomLines = wo.processVersionId && this.processes ? await this.processes.resolveRawRequirements(wo.processVersionId, wo.processChoices, manager) : await this.bom.getBomForAssembly(wo.finishedProductId, manager);
    if (!bomLines || bomLines.length === 0) {
      throw new ConflictException(`Finished product "${wo.finishedProductId}" has no Bill of Materials — cannot release a Work Order for it.`);
    }

    // ADR-061 Addendum 1 (A1) — resolved BEFORE any release side effect (WIP warehouse creation): an
    // active routing is snapshotted below; a routing pointing at an inactive Work Center fails here.
    const routingOperations = wo.processVersionId ? null : await this.routings.getActiveOperationsForRelease(wo.finishedProductId, manager);

    const wipCode = `WIP-${wo.workOrderNumber}`;
    let wipWarehouse = await this.inventory.findOperationalSubLocation(wo.warehouseId, wipCode, manager);
    if (!wipWarehouse) {
      wipWarehouse = await this.inventory.createWarehouse(wipCode, `WIP — ${wo.workOrderNumber}`, null, null, wo.warehouseId, 'operational', manager, wo.branchOrgUnitId); // the WIP location carries the work order's branch
    }
    const wipWarehouseId = wipWarehouse.id;

    return (manager ?? this.dataSource).transaction(async (txManager) => {
      const componentRepo = txManager.getRepository(WorkOrderComponent);
      for (const line of bomLines) {
        const quantityRequired = line.quantityPerUnit * wo.quantityPlanned;
        const currentCost = await this.valuation.getUnitCost(line.componentProductId, wo.warehouseId, undefined, txManager);
        await componentRepo.save(
          componentRepo.create({
            workOrderId: wo.id,
            componentProductId: line.componentProductId,
            quantityRequired,
            unitCostAtRelease: currentCost?.unitCostBase ?? null,
          }),
        );
        await this.inventory.reserveStockForReferenceInTransaction(
          txManager,
          wo.warehouseId,
          line.componentProductId,
          quantityRequired,
          'WORK_ORDER',
          wo.id,
          actorUserId,
        );
      }

      if (routingOperations) {
        const opRepo = txManager.getRepository(WorkOrderOperation);
        await opRepo.save(
          routingOperations.map((o) =>
            opRepo.create({
              workOrderId: wo.id,
              sequence: o.sequence,
              name: o.name,
              description: o.description,
              workCenterId: o.workCenterId,
              workCenterCode: o.workCenterCode,
              workCenterName: o.workCenterName,
              status: 'pending',
            }),
          ),
        );
      }

      const woRepo = txManager.getRepository(WorkOrder);
      await woRepo.update(wo.id, { wipWarehouseId });
      await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, wo.id, 'release', actorUserId, txManager);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'manufacturing.work_order.released',
          resource: 'work_order',
          resourceId: wo.id,
          result: 'success',
          correlationId: null,
          after: { wipWarehouseId, componentCount: bomLines.length, operationCount: routingOperations?.length ?? 0 },
        },
        txManager,
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
    manager?: EntityManager,
  ): Promise<void> {
    if (!Number.isInteger(issueQuantity) || issueQuantity <= 0) {
      throw new ConflictException('issueQuantity must be a positive whole number.');
    }
    const wo = await this.getWorkOrderOrThrow(workOrderId, manager);
    const state = await this.getWorkOrderState(workOrderId, manager);
    if (state !== 'released' && state !== 'in_progress') {
      throw new ConflictException(`Work Order "${workOrderId}" cannot accept a Material Issue from state "${state}".`);
    }
    if (!wo.wipWarehouseId) throw new ConflictException(`Work Order "${workOrderId}" has no WIP sub-warehouse — release it first.`);

    await (manager ?? this.dataSource).transaction(async (txManager) => {
      const componentRepo = txManager.getRepository(WorkOrderComponent);
      const component = await componentRepo.findOne({ where: { workOrderId, componentProductId } });
      if (!component) throw new ConflictException(`Component "${componentProductId}" is not part of Work Order "${workOrderId}"'s released BOM snapshot.`);

      // ADR-061 §5 — hard guard: no over-issue.
      if (component.quantityIssued + issueQuantity > component.quantityRequired) {
        throw new ConflictException(
          `Cannot issue ${issueQuantity} of "${componentProductId}" — would exceed quantityRequired (${component.quantityRequired}); already issued ${component.quantityIssued}.`,
        );
      }

      const keys = [`${wo.warehouseId}:${componentProductId}`, `${wo.wipWarehouseId}:${componentProductId}`].sort();
      for (const key of keys) await txManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

      const issueLineId = requestId;
      const consumed = await this.valuation.consumeIssueCost(
        componentProductId,
        wo.warehouseId,
        issueQuantity,
        `manufacturing:work_order:${wo.id}:material_issue:${issueLineId}:consume`,
        txManager,
      );
      if (!consumed || 'rejected' in consumed) {
        throw new ConflictException(`Cannot issue ${issueQuantity} of "${componentProductId}" from warehouse "${wo.warehouseId}" — insufficient valued stock.`);
      }

      await this.inventory.recordMovement(wo.warehouseId, componentProductId, -issueQuantity, 'work_order_material_issue', 'work_order', wo.id, actorUserId, txManager);
      await this.inventory.recordMovement(wo.wipWarehouseId!, componentProductId, issueQuantity, 'work_order_material_issue', 'work_order', wo.id, actorUserId, txManager);
      await this.valuation.recordReceiptCost(
        componentProductId,
        wo.wipWarehouseId!,
        issueQuantity,
        consumed.unitCostBase,
        `manufacturing:work_order:${wo.id}:material_issue:${issueLineId}:receipt`,
        txManager,
      );

      await this.inventory.releaseReservedQuantityForReference('WORK_ORDER', wo.id, componentProductId, wo.warehouseId, issueQuantity, actorUserId, txManager);

      component.quantityIssued += issueQuantity;
      await componentRepo.save(component);

      if (state === 'released') {
        await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, wo.id, 'begin_production', actorUserId, txManager);
      }

      await this.events.publish(txManager, 'manufacturing.work_order.material_issued', {
        orgUnitId: wo.branchOrgUnitId ?? null, // WP-C: attributes the WIP / inventory entry to the work order's branch (null = company level, as before)
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
        txManager,
      );
    });
    // The outbox row `events.publish` wrote above only becomes a real GL entry once dispatched —
    // without this, it would sit `pending` until some unrelated later sweep, an accidental and
    // non-deterministic delay (same precedent `GoodsReceiptService.post` already established).
    await this.events.dispatchAfterCommit(manager);
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
    manager?: EntityManager,
  ): Promise<void> {
    if (!Number.isInteger(returnQuantity) || returnQuantity <= 0) {
      throw new ConflictException('returnQuantity must be a positive whole number.');
    }
    const wo = await this.getWorkOrderOrThrow(workOrderId, manager);
    const state = await this.getWorkOrderState(workOrderId, manager);
    if (state !== 'in_progress' && state !== 'on_hold') {
      throw new ConflictException(`Work Order "${workOrderId}" cannot accept a Material Return from state "${state}".`);
    }
    if (!wo.wipWarehouseId) throw new ConflictException(`Work Order "${workOrderId}" has no WIP sub-warehouse.`);

    await (manager ?? this.dataSource).transaction(async (txManager) => {
      const componentRepo = txManager.getRepository(WorkOrderComponent);
      const component = await componentRepo.findOne({ where: { workOrderId, componentProductId } });
      if (!component) throw new ConflictException(`Component "${componentProductId}" is not part of Work Order "${workOrderId}".`);

      // ADR-061 §5 — a return may not exceed the WO's own cumulative issued-minus-already-returned quantity.
      if (returnQuantity > component.quantityIssued) {
        throw new ConflictException(
          `Cannot return ${returnQuantity} of "${componentProductId}" — only ${component.quantityIssued} is currently issued (net of prior returns).`,
        );
      }

      const keys = [`${wo.warehouseId}:${componentProductId}`, `${wo.wipWarehouseId}:${componentProductId}`].sort();
      for (const key of keys) await txManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

      const returnLineId = requestId;
      // Corrected costing rule (§5) — WIP's OWN current moving-average cost, never the original issue's cost.
      const consumed = await this.valuation.consumeIssueCost(
        componentProductId,
        wo.wipWarehouseId!,
        returnQuantity,
        `manufacturing:work_order:${wo.id}:material_return:${returnLineId}:consume`,
        txManager,
      );
      if (!consumed || 'rejected' in consumed) {
        throw new ConflictException(`Cannot return ${returnQuantity} of "${componentProductId}" — insufficient physical/valued stock in the Work Order's WIP.`);
      }

      await this.inventory.recordMovement(wo.wipWarehouseId!, componentProductId, -returnQuantity, 'work_order_material_return', 'work_order', wo.id, actorUserId, txManager);
      await this.inventory.recordMovement(wo.warehouseId, componentProductId, returnQuantity, 'work_order_material_return', 'work_order', wo.id, actorUserId, txManager);
      await this.valuation.recordReceiptCost(
        componentProductId,
        wo.warehouseId,
        returnQuantity,
        consumed.unitCostBase,
        `manufacturing:work_order:${wo.id}:material_return:${returnLineId}:receipt`,
        txManager,
      );

      // Re-reserve the returned quantity for THIS Work Order — a return puts the physical unit
      // back in the real warehouse, but it is still within this Work Order's plan entitlement
      // (quantityRequired), not released to general availability. This is what lets a later
      // Material Issue re-draw the same quantity (ADR-061 §8's worked example does exactly this)
      // without ever needing more than quantityRequired reserved in total, and keeps the
      // reservation balance consistent with quantityRequired − quantityIssued at every point.
      await this.inventory.reserveStockForReferenceInTransaction(txManager, wo.warehouseId, componentProductId, returnQuantity, 'WORK_ORDER', wo.id, actorUserId);

      component.quantityIssued -= returnQuantity;
      await componentRepo.save(component);

      await this.events.publish(txManager, 'manufacturing.work_order.material_returned', {
        orgUnitId: wo.branchOrgUnitId ?? null, // WP-C: attributes the WIP / inventory entry to the work order's branch (null = company level, as before)
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
        txManager,
      );
    });
    await this.events.dispatchAfterCommit(manager);
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
    manager?: EntityManager,
  ): Promise<void> {
    if (!Number.isInteger(outputQuantity) || outputQuantity <= 0) {
      throw new ConflictException('outputQuantity must be a positive whole number.');
    }
    const wo = await this.getWorkOrderOrThrow(workOrderId, manager);
    // CTO D1 (UX redesign stage 4): a process-bound order has ONE receipt path - the multi-output receipt, which honours the version's final outputs and cost allocation. The
    // single-output path would receive only the primary product and silently skip co-/by-products, so it is refused here (basic orders are unchanged).
    if (wo.processVersionId) {
      throw new ConflictException(
        `Work Order "${wo.workOrderNumber}" is bound to a process definition - receive its outputs with the multi-output receipt (POST manufacturing/process-orders/${wo.id}/output). The basic finished-goods output is only for basic orders.`,
      );
    }
    const outputEventId = requestId;
    const state = await this.getWorkOrderState(workOrderId, manager);
    if (state !== 'in_progress') {
      throw new ConflictException(`Work Order "${workOrderId}" cannot record a Finished Goods Output from state "${state}".`);
    }
    if (!wo.wipWarehouseId) throw new ConflictException(`Work Order "${workOrderId}" has no WIP sub-warehouse.`);

    // ADR-061 §7 — hard guard: no over-production beyond plan.
    if (wo.quantityProduced + wo.quantityScrapped + outputQuantity > wo.quantityPlanned) {
      throw new ConflictException(
        `Cannot output ${outputQuantity} — Work Order "${workOrderId}" has only ${wo.quantityPlanned - wo.quantityProduced - wo.quantityScrapped} remaining of its ${wo.quantityPlanned}-unit plan.`,
      );
    }

    await (manager ?? this.dataSource).transaction(async (txManager) => {
      const { valueOutput, unitCostOutput } = await this.consumePooledForOutput(
        txManager,
        wo,
        outputQuantity,
        requestId,
        'fg_output',
        'work_order_finished_goods_output',
        actorUserId,
        `${wo.warehouseId}:${wo.finishedProductId}`,
      );
      await this.inventory.recordMovement(wo.warehouseId, wo.finishedProductId, outputQuantity, 'work_order_finished_goods_output', 'work_order', wo.id, actorUserId, txManager);
      await this.valuation.recordReceiptCost(
        wo.finishedProductId,
        wo.warehouseId,
        outputQuantity,
        unitCostOutput.toFixed(4),
        `manufacturing:work_order:${wo.id}:fg_output:${outputEventId}:receipt`,
        txManager,
      );

      const woRepo = txManager.getRepository(WorkOrder);
      await woRepo.update(wo.id, { quantityProduced: wo.quantityProduced + outputQuantity });

      await this.events.publish(txManager, 'manufacturing.work_order.finished_goods_received', {
        orgUnitId: wo.branchOrgUnitId ?? null, // WP-C: attributes the entry to the work order's branch (null = company level, as before)
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
        txManager,
      );
    });
    await this.events.dispatchAfterCommit(manager);
  }

  // ---------------------------------------------------------------------
  // Manufacturing Engine S1 — production results by outcome class (decisions D-ME-1 / D-ME-4)
  // ---------------------------------------------------------------------


  /**
   * Manufacturing Engine S5 (decision D-ME-4) - MULTI-OUTPUT receipt for a process-bound order. `units` plan-units are completed: their components are consumed at the SAME pooled
   * cost the single-output path uses, and that pooled value is shared over the version's FINAL outputs (good / co-product / by-product) by allocationWeight x quantity. Each output
   * is received into the order's warehouse at its share (a weight-0 output carries no value) and recorded as a result row of its class. Nothing is invented or lost: the shares
   * add up to the pooled value. Idempotent per `requestId`. The single-output `finishedGoodsOutput` stays for the Basic Profile.
   */
  async receiveProcessOutputs(workOrderId: string, units: number, actorUserId: string | null, requestId: string = randomUUID(), manager?: EntityManager): Promise<WorkOrderResult[]> {
    if (!Number.isInteger(units) || units <= 0) throw new ConflictException('units must be a positive whole number.');
    const wo = await this.getWorkOrderOrThrow(workOrderId, manager);
    if (!wo.processVersionId || !this.processes) throw new ConflictException(`Work Order "${workOrderId}" is not process-bound - use the single-output Finished Goods Output.`);
    const state = await this.getWorkOrderState(workOrderId, manager);
    if (state !== 'in_progress') throw new ConflictException(`Work Order "${workOrderId}" cannot receive outputs from state "${state}".`);
    if (!wo.wipWarehouseId) throw new ConflictException(`Work Order "${workOrderId}" has no WIP sub-warehouse.`);
    const def = await this.processes.get(wo.processVersionId, manager);
    const finals = def.outputs.filter((o) => !o.intermediate);
    if (finals.length === 0) throw new ConflictException('The process has no final output.');

    const saved = await (manager ?? this.dataSource).transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manufacturing:work_order:${workOrderId}:results`]);
      const repo = tx.getRepository(WorkOrderResult);
      const primary = finals.find((o) => o.role === 'good' && o.productId === wo.finishedProductId) ?? finals[0];
      const done = await repo.find({ where: { workOrderId, requestId: Like(`${requestId}:%`) } });
      if (done.length > 0) return done;
      const fresh = await tx.getRepository(WorkOrder).findOneOrFail({ where: { id: workOrderId } });
      if (fresh.quantityProduced + fresh.quantityScrapped + units > fresh.quantityPlanned) {
        throw new ConflictException(`Cannot receive ${units} - Work Order "${workOrderId}" has only ${fresh.quantityPlanned - fresh.quantityProduced - fresh.quantityScrapped} remaining of its ${fresh.quantityPlanned}-unit plan.`);
      }
      for (const key of [...new Set(finals.map((o) => `${wo.warehouseId}:${o.productId}`))].sort()) await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const { valueOutput } = await this.consumePooledForOutput(tx, fresh, units, requestId, 'fg_output', 'work_order_finished_goods_output', actorUserId);
      const basis = finals.map((o) => o.allocationWeight * o.quantityPerUnit * units);
      const basisTotal = basis.reduce((s, b) => s + b, 0);
      if (basisTotal <= 0) throw new ConflictException('No final output carries an allocation weight - the pooled cost cannot be shared.');
      const rows: WorkOrderResult[] = [];
      let allocated = 0;
      for (let i = 0; i < finals.length; i++) {
        const o = finals[i];
        const q = o.quantityPerUnit * units;
        const lastWithValue = basis.slice(i + 1).every((b) => b === 0) && basis[i] > 0;
        const share = basis[i] === 0 ? 0 : lastWithValue ? valueOutput - allocated : Number(((valueOutput * basis[i]) / basisTotal).toFixed(4));
        allocated += share;
        const unit = (share / q).toFixed(4);
        const total = (Number(unit) * q).toFixed(4);
        await this.inventory.recordMovement(wo.warehouseId, o.productId, q, 'work_order_finished_goods_output', 'work_order', wo.id, actorUserId, tx);
        await this.valuation.recordReceiptCost(o.productId, wo.warehouseId, q, unit, `manufacturing:work_order:${wo.id}:fg_output:${requestId}:${o.productId}:receipt`, tx);
        if (Number(total) > 0) {
          await this.events.publish(tx, 'manufacturing.work_order.finished_goods_received', {
            orgUnitId: wo.branchOrgUnitId ?? null, // WP-C: attributes the entry to the work order's branch (null = company level, as before)
            idempotencyKey: `manufacturing:work_order:${wo.id}:fg_output:${requestId}:${o.productId}`,
            workOrderId: wo.id,
            finishedProductId: o.productId,
            quantity: q,
            unitCostBase: unit,
            totalValueBase: total,
          });
        }
        rows.push(await repo.save(repo.create({ workOrderId, operationId: null, outcomeClass: o.role === 'good' ? 'good' : o.role, productId: o.productId, quantity: q, valueBase: total, requestId: `${requestId}:${o.productId}`, reason: null, createdByUserId: actorUserId })));
      }
      await tx.getRepository(WorkOrder).update(workOrderId, { quantityProduced: fresh.quantityProduced + units });
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.process_outputs_received', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: requestId, after: { units, valueOutput: valueOutput.toFixed(4), outputs: rows.map((r) => ({ productId: r.productId, class: r.outcomeClass, quantity: r.quantity, valueBase: r.valueBase })) } },
        tx,
      );
      return rows;
    });
    await this.events.dispatchAfterCommit(manager);
    return saved;
  }

  async getResults(workOrderId: string, manager?: EntityManager): Promise<WorkOrderResult[]> {
    return (manager ?? this.dataSource).getRepository(WorkOrderResult).find({ where: { workOrderId }, order: { createdAt: 'ASC' } });
  }

  /** Quantities still open on the order: tracked units (rework / rejected / held) that have not been resolved yet. */
  async getOpenTrackedQuantity(workOrderId: string, manager?: EntityManager): Promise<number> {
    const rows: Array<{ n: string | null }> = await (manager ?? this.dataSource).query(
      `SELECT COALESCE(SUM("quantity"), 0) AS n FROM "work_order_results" WHERE "workOrderId" = $1 AND "outcomeClass" IN ('rework','rejected','held') AND "resolvedAt" IS NULL`,
      [workOrderId],
    );
    return Number(rows[0].n ?? 0);
  }

  /**
   * D-ME-1 — scrap is a result, not a material return. Takes `quantity` finished-unit equivalents out of the Work Order's WIP at the SAME pooled cost a good output would
   * have carried (so cost is never invented or lost), consumes their components physically, creates no stock, and posts the value to the configured scrap-loss account
   * (Dr Scrap loss / Cr WIP). The plan is exhausted by produced + scrapped. Idempotent per `requestId`.
   */
  async recordScrap(workOrderId: string, quantity: number, reason: string, actorUserId: string | null, requestId: string = randomUUID(), manager?: EntityManager, operationId: string | null = null): Promise<WorkOrderResult> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new ConflictException('Scrap quantity must be a positive whole number.');
    const why = (reason ?? '').trim();
    if (why.length < 3) throw new ConflictException('A reason is required to record scrap.');
    const initial = await this.getWorkOrderOrThrow(workOrderId, manager);
    const state = await this.getWorkOrderState(workOrderId, manager);
    if (state !== 'in_progress') throw new ConflictException(`Work Order "${workOrderId}" cannot record scrap from state "${state}".`);
    if (!initial.wipWarehouseId) throw new ConflictException(`Work Order "${workOrderId}" has no WIP sub-warehouse.`);

    const result = await (manager ?? this.dataSource).transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manufacturing:work_order:${workOrderId}:results`]);
      const repo = tx.getRepository(WorkOrderResult);
      const existing = await repo.findOne({ where: { workOrderId, outcomeClass: 'scrap', requestId } });
      if (existing) return existing; // a retried request: no second effect
      // D6: the accounts the scrap journal needs must resolve BEFORE anything is consumed or written (fail closed, actionable message, nothing recorded)
      await this.postingPolicy?.get()?.assertManufacturingScrapPostable?.('scrap', tx);
      const wo = await tx.getRepository(WorkOrder).findOneOrFail({ where: { id: workOrderId } });
      if (wo.quantityProduced + wo.quantityScrapped + quantity > wo.quantityPlanned) {
        throw new ConflictException(`Cannot scrap ${quantity} — Work Order "${workOrderId}" has only ${wo.quantityPlanned - wo.quantityProduced - wo.quantityScrapped} remaining of its ${wo.quantityPlanned}-unit plan.`);
      }
      const { valueOutput } = await this.consumePooledForOutput(tx, wo, quantity, requestId, 'scrap', 'work_order_scrap', actorUserId);
      await tx.getRepository(WorkOrder).update(wo.id, { quantityScrapped: wo.quantityScrapped + quantity });
      const saved = await repo.save(
        repo.create({ workOrderId: wo.id, operationId, outcomeClass: 'scrap', productId: wo.finishedProductId, quantity, valueBase: valueOutput.toFixed(4), requestId, reason: why, createdByUserId: actorUserId }),
      );
      if (valueOutput > 0) {
        await this.events.publish(tx, 'manufacturing.work_order.scrap_recognized', {
          orgUnitId: wo.branchOrgUnitId ?? null, // WP-C: attributes the entry to the work order's branch (null = company level, as before)
          idempotencyKey: `manufacturing:work_order:${wo.id}:scrap:${requestId}`,
          workOrderId: wo.id,
          finishedProductId: wo.finishedProductId,
          quantity,
          totalValueBase: valueOutput.toFixed(4),
          reason: why,
        });
      }
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.scrap_recorded', resource: 'work_order', resourceId: wo.id, result: 'success', correlationId: saved.id, after: { quantity, valueBase: valueOutput.toFixed(4), reason: why } },
        tx,
      );
      return saved;
    });
    await this.events.dispatchAfterCommit(manager);
    return result;
  }

  /**
   * D-ME-1 — salvage from scrap: the recovered material goes back into the Work Order's warehouse at a DECLARED value that can never exceed what the scrap it came from
   * wrote off (cumulatively). Dr Inventory / Cr Scrap loss. A recovery is the only legal way for scrapped value to return to stock.
   */
  async recordRecovery(
    workOrderId: string,
    productId: string,
    quantity: number,
    valueBase: string,
    sourceResultId: string,
    actorUserId: string | null,
    requestId: string = randomUUID(),
    manager?: EntityManager,
  ): Promise<WorkOrderResult> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new ConflictException('Recovered quantity must be a positive whole number.');
    if (!/^\d+(\.\d{1,4})?$/.test(valueBase) || Number(valueBase) <= 0) throw new ConflictException('The recovery value must be a positive amount (up to 4 decimals).');
    const wo = await this.getWorkOrderOrThrow(workOrderId, manager);
    const state = await this.getWorkOrderState(workOrderId, manager);
    if (state === 'draft' || state === 'cancelled') throw new ConflictException(`Work Order "${workOrderId}" cannot record a recovery from state "${state}".`);

    const result = await (manager ?? this.dataSource).transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manufacturing:work_order:${workOrderId}:results`]);
      const repo = tx.getRepository(WorkOrderResult);
      const existing = await repo.findOne({ where: { workOrderId, outcomeClass: 'recovered', requestId } });
      if (existing) return existing;
      await this.postingPolicy?.get()?.assertManufacturingScrapPostable?.('recovery', tx);
      const source = await repo.findOne({ where: { id: sourceResultId, workOrderId, outcomeClass: 'scrap' } });
      if (!source) throw new ConflictException(`Scrap result "${sourceResultId}" was not found on Work Order "${workOrderId}".`);
      const prior: Array<{ n: string | null }> = await tx.query(
        `SELECT COALESCE(SUM("valueBase"), 0) AS n FROM "work_order_results" WHERE "sourceResultId" = $1 AND "outcomeClass" = 'recovered'`,
        [source.id],
      );
      // unit cost is stored at 4 decimals, so the journal and the valuation row both use qty × unit (never the raw declared figure)
      const unit = (Number(valueBase) / quantity).toFixed(4);
      const total = (Number(unit) * quantity).toFixed(4);
      if (Number(prior[0].n ?? 0) + Number(total) > Number(source.valueBase) + 0.00005) {
        throw new ConflictException(`Recovery value ${total} would exceed what the scrap wrote off (${source.valueBase}; already recovered ${Number(prior[0].n ?? 0).toFixed(4)}).`);
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${wo.warehouseId}:${productId}`]);
      await this.inventory.recordMovement(wo.warehouseId, productId, quantity, 'work_order_recovery', 'work_order', wo.id, actorUserId, tx);
      await this.valuation.recordReceiptCost(productId, wo.warehouseId, quantity, unit, `manufacturing:work_order:${wo.id}:recovery:${requestId}:receipt`, tx);
      const saved = await repo.save(
        repo.create({ workOrderId: wo.id, operationId: null, outcomeClass: 'recovered', productId, quantity, valueBase: total, requestId, reason: null, sourceResultId: source.id, createdByUserId: actorUserId }),
      );
      await this.events.publish(tx, 'manufacturing.work_order.recovery_received', {
        orgUnitId: wo.branchOrgUnitId ?? null, // WP-C: attributes the entry to the work order's branch (null = company level, as before)
        idempotencyKey: `manufacturing:work_order:${wo.id}:recovery:${requestId}`,
        workOrderId: wo.id,
        productId,
        quantity,
        unitCostBase: unit,
        totalValueBase: total,
      });
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.recovery_recorded', resource: 'work_order', resourceId: wo.id, result: 'success', correlationId: saved.id, after: { productId, quantity, valueBase: total, sourceResultId } },
        tx,
      );
      return saved;
    });
    await this.events.dispatchAfterCommit(manager);
    return result;
  }

  /** rework / rejected / held — quantity-only tracking (no stock, no value). They must be resolved before the order can close. */
  async recordTrackedOutcome(
    workOrderId: string,
    outcomeClass: 'rework' | 'rejected' | 'held',
    quantity: number,
    reason: string,
    actorUserId: string | null,
    requestId: string = randomUUID(),
    manager?: EntityManager,
    operationId: string | null = null,
  ): Promise<WorkOrderResult> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new ConflictException('Quantity must be a positive whole number.');
    const why = (reason ?? '').trim();
    if (why.length < 3) throw new ConflictException('A reason is required.');
    const state = await this.getWorkOrderState(workOrderId, manager);
    if (state !== 'in_progress' && state !== 'on_hold') throw new ConflictException(`Work Order "${workOrderId}" cannot record a "${outcomeClass}" result from state "${state}".`);
    return (manager ?? this.dataSource).transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manufacturing:work_order:${workOrderId}:results`]);
      const repo = tx.getRepository(WorkOrderResult);
      const existing = await repo.findOne({ where: { workOrderId, outcomeClass, requestId } });
      if (existing) return existing;
      const wo = await tx.getRepository(WorkOrder).findOneOrFail({ where: { id: workOrderId } });
      const open = await this.getOpenTrackedQuantity(workOrderId, tx);
      if (open + quantity > wo.quantityPlanned - wo.quantityProduced - wo.quantityScrapped) {
        throw new ConflictException(`Cannot track ${quantity} as "${outcomeClass}" — it would exceed the quantity still to be produced (${wo.quantityPlanned - wo.quantityProduced - wo.quantityScrapped}, of which ${open} is already tracked).`);
      }
      const saved = await repo.save(repo.create({ workOrderId, operationId, outcomeClass, productId: wo.finishedProductId, quantity, valueBase: '0', requestId, reason: why, createdByUserId: actorUserId }));
      await this.audit.record(
        { actorUserId, organizationId: null, action: `manufacturing.work_order.${outcomeClass}_recorded`, resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: saved.id, after: { quantity, reason: why } },
        tx,
      );
      return saved;
    });
  }

  /** Closes a tracked row with its disposition. The disposition itself is then carried out with the normal output / scrap actions; this only lifts the closing block. */
  async resolveTrackedOutcome(workOrderId: string, resultId: string, resolution: 'good' | 'scrap' | 'rework', actorUserId: string | null, manager?: EntityManager): Promise<WorkOrderResult> {
    return (manager ?? this.dataSource).transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manufacturing:work_order:${workOrderId}:results`]);
      const repo = tx.getRepository(WorkOrderResult);
      const row = await repo.findOne({ where: { id: resultId, workOrderId } });
      if (!row || !['rework', 'rejected', 'held'].includes(row.outcomeClass)) throw new NotFoundException(`Tracked result "${resultId}" not found on Work Order "${workOrderId}".`);
      if (row.resolvedAt) throw new ConflictException(`Result "${resultId}" is already resolved (${row.resolution}).`);
      row.resolvedAt = new Date();
      row.resolution = resolution;
      row.resolvedByUserId = actorUserId;
      const saved = await repo.save(row);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.outcome_resolved', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: saved.id, after: { resolution, quantity: row.quantity } },
        tx,
      );
      return saved;
    });
  }

  /**
   * ADR-061 §7's Work-Order-pooled consumption, shared by every result that takes finished-unit equivalents out of the Work Order's WIP (a good output and, since S1, a
   * scrap): physical availability guard for every component first, pooled value `WIP ÷ remaining plan × quantity` (the last unit takes the whole remaining WIP),
   * pro-rata attribution across components, WIP movements. Returns the value and unit cost; the CALLER decides where that value goes (finished stock or loss).
   */
  private async consumePooledForOutput(
    txManager: EntityManager,
    wo: WorkOrder,
    outputQuantity: number,
    requestId: string,
    keyTag: string,
    movementType: 'work_order_finished_goods_output' | 'work_order_scrap',
    actorUserId: string | null,
    extraLockKey?: string,
  ): Promise<{ valueOutput: number; unitCostOutput: number }> {
      const componentRepo = txManager.getRepository(WorkOrderComponent);
      const components = await componentRepo.find({ where: { workOrderId: wo.id } });
      if (components.length === 0) throw new ConflictException(`Work Order "${wo.id}" has no components — cannot produce.`);

      const lockKeys = new Set<string>();
      for (const c of components) lockKeys.add(`${wo.wipWarehouseId}:${c.componentProductId}`);
      if (extraLockKey) lockKeys.add(extraLockKey);
      for (const key of Array.from(lockKeys).sort()) await txManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

      // ADR-061 §6/§7 — WIP(WO).value_before, read as F08's own authoritative `totalValueBase` for
      // the WIP sub-warehouse (see `computeWipValue`'s doc comment for why this must NOT be
      // re-derived as Σ(onHand × unitCost) in JS: a component whose on-hand hit zero after a prior
      // policy-valued consumption carries a null average but a real leftover `totalValueBase`).
      const wipTotals = await this.valuation.getValuedOnHandTotal(undefined, txManager);
      const wipValueBefore = Number(wipTotals.find((r) => r.warehouseId === wo.wipWarehouseId)?.totalValueBase ?? 0);

      const perComponent: Array<{ componentProductId: string; onHand: number; unitCost: number; qtyConsumed: number }> = [];
      for (const c of components) {
        const onHand = await this.inventory.getOnHandQuantityInTransaction(txManager, wo.wipWarehouseId!, c.componentProductId);
        const costRow = await this.valuation.getUnitCost(c.componentProductId, wo.wipWarehouseId!, undefined, txManager);
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
      const remainingPlannedQtyBefore = wo.quantityPlanned - wo.quantityProduced - wo.quantityScrapped;
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
          `manufacturing:work_order:${wo.id}:${keyTag}:${outputEventId}:${p.componentProductId}`,
          txManager,
        );
        if (!consumeResult || 'rejected' in consumeResult) {
          throw new ConflictException(`Finished Goods Output failed applying the policy-valued consumption for component "${p.componentProductId}".`);
        }
        await this.inventory.recordMovement(
          wo.wipWarehouseId!,
          p.componentProductId,
          -p.qtyConsumed,
          movementType,
          'work_order',
          wo.id,
          actorUserId,
          txManager,
        );
      }


      return { valueOutput, unitCostOutput };
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

  /**
   * ADR-061 Addendum 1 (A1) — start an operation of the routing snapshot. Pure execution tracking:
   * no inventory movement, no Financial Event, no cost. Allowed while the Work Order is `released` or
   * `in_progress` (not `on_hold`); operations run strictly in sequence (every lower sequence must be
   * `completed` first).
   */
  async startOperation(workOrderId: string, operationId: string, actorUserId: string | null, manager?: EntityManager): Promise<WorkOrderOperation> {
    return this.transitionOperation(workOrderId, operationId, 'start', actorUserId, manager);
  }

  async completeOperation(workOrderId: string, operationId: string, actorUserId: string | null, manager?: EntityManager): Promise<WorkOrderOperation> {
    return this.transitionOperation(workOrderId, operationId, 'complete', actorUserId, manager);
  }

  private async transitionOperation(
    workOrderId: string,
    operationId: string,
    action: 'start' | 'complete',
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<WorkOrderOperation> {
    await this.getWorkOrderOrThrow(workOrderId, manager);
    const state = await this.getWorkOrderState(workOrderId, manager);
    if (state !== 'released' && state !== 'in_progress') {
      throw new ConflictException(`Work Order "${workOrderId}" cannot ${action} an operation from state "${state}".`);
    }
    return (manager ?? this.dataSource).transaction(async (txManager) => {
      const repo = txManager.getRepository(WorkOrderOperation);
      const all = await repo.find({ where: { workOrderId }, order: { sequence: 'ASC' } });
      const op = all.find((o) => o.id === operationId);
      if (!op) throw new NotFoundException(`Operation "${operationId}" not found on Work Order "${workOrderId}".`);

      if (action === 'start') {
        if (op.status !== 'pending') throw new ConflictException(`Operation ${op.sequence} is already ${op.status}.`);
        const blocking = all.find((o) => o.sequence < op.sequence && o.status !== 'completed');
        if (blocking) throw new ConflictException(`Operation ${blocking.sequence} ("${blocking.name}") must be completed before operation ${op.sequence} can start.`);
        op.status = 'in_progress';
        op.startedAt = new Date();
        op.startedByUserId = actorUserId;
      } else {
        if (op.status !== 'in_progress') throw new ConflictException(`Operation ${op.sequence} must be in progress to complete (currently ${op.status}).`);
        op.status = 'completed';
        op.completedAt = new Date();
        op.completedByUserId = actorUserId;
      }
      const saved = await repo.save(op);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: `manufacturing.work_order.operation_${action === 'start' ? 'started' : 'completed'}`,
          resource: 'work_order',
          resourceId: workOrderId,
          result: 'success',
          correlationId: null,
          after: { operationId, sequence: op.sequence, name: op.name, workCenterCode: op.workCenterCode, status: op.status },
        },
        txManager,
      );
      return saved;
    });
  }

  async hold(workOrderId: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    await (manager ?? this.dataSource).transaction(async (txManager) => {
      await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, workOrderId, 'hold', actorUserId, txManager);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.held', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: null },
        txManager,
      );
    });
  }

  async resume(workOrderId: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    await (manager ?? this.dataSource).transaction(async (txManager) => {
      await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, workOrderId, 'resume', actorUserId, txManager);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.resumed', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: null },
        txManager,
      );
    });
  }

  /** ADR-061 §3 — hard guard: WIP(WO).value must be exactly zero (within rounding tolerance) before completion. */
  async complete(workOrderId: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    const wo = await this.getWorkOrderOrThrow(workOrderId, manager);
    if (!wo.wipWarehouseId) throw new ConflictException(`Work Order "${workOrderId}" has no WIP sub-warehouse.`);

    const wipValue = await this.computeWipValue(workOrderId, manager);
    const TOLERANCE = 0.01;
    if (Math.abs(wipValue) > TOLERANCE) {
      throw new ConflictException(
        `Cannot complete Work Order "${workOrderId}" — its WIP balance is ${wipValue.toFixed(4)}, not zero. Material-Return any remaining unconsumed component value first.`,
      );
    }

    // S1 (D-ME-4): rework / rejected / held units are open decisions — each must be resolved before the order closes.
    const openTracked = await this.getOpenTrackedQuantity(workOrderId, manager);
    if (openTracked > 0) {
      throw new ConflictException(`Cannot complete Work Order "${workOrderId}" — ${openTracked} unit(s) are still tracked as rework / rejected / held. Resolve them first.`);
    }

    // ADR-061 Addendum 1 (A1) — opt-in by data: a Work Order that snapshotted a routing may complete only
    // when every operation is completed. A Work Order without operations is unaffected.
    const operations = await this.getWorkOrderOperations(workOrderId, manager);
    const open = operations.filter((o) => o.status !== 'completed');
    if (open.length > 0) {
      throw new ConflictException(
        `Cannot complete Work Order "${workOrderId}" — ${open.length} routing operation(s) are not completed (first open: ${open[0].sequence} "${open[0].name}").`,
      );
    }

    // S4: a process-bound order closes only when every non-optional operation has a completed run and nothing is still running.
    if (wo.processVersionId) {
      const open: Array<{ code: string; why: string }> = await (manager ?? this.dataSource).query(
        `SELECT o."code", CASE WHEN EXISTS (SELECT 1 FROM "mfg_operation_runs" r WHERE r."workOrderId" = $1 AND r."operationId" = o."id" AND r."status" = 'running') THEN 'still running' ELSE 'not completed' END AS why
           FROM "mfg_process_operations" o
          WHERE o."versionId" = $2
            AND ( EXISTS (SELECT 1 FROM "mfg_operation_runs" r WHERE r."workOrderId" = $1 AND r."operationId" = o."id" AND r."status" = 'running')
               OR (o."optional" = false AND NOT EXISTS (SELECT 1 FROM "mfg_operation_runs" r WHERE r."workOrderId" = $1 AND r."operationId" = o."id" AND r."status" = 'completed')) )
          ORDER BY o."sequenceNo", o."code"`,
        [workOrderId, wo.processVersionId],
      );
      if (open.length > 0) throw new ConflictException(`Cannot complete Work Order "${workOrderId}" - process operation(s) not done: ${open.map((o) => `${o.code} (${o.why})`).join(', ')}.`);
    }

    await (manager ?? this.dataSource).transaction(async (txManager) => {
      await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, workOrderId, 'complete', actorUserId, txManager);
      await this.releaseRemainingReservations(workOrderId, wo.warehouseId, actorUserId, txManager);
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
        txManager,
      );
    });
  }

  /** ADR-061 §3 — `released -> cancelled` only if zero material has been issued; `draft -> cancelled` always allowed. */
  async cancel(workOrderId: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    const wo = await this.getWorkOrderOrThrow(workOrderId, manager);
    const state = await this.getWorkOrderState(workOrderId, manager);
    if (state === 'released') {
      const components = await this.getWorkOrderComponents(workOrderId, manager);
      if (components.some((c) => c.quantityIssued > 0)) {
        throw new ConflictException(`Cannot cancel Work Order "${workOrderId}" from "released" — material has already been issued.`);
      }
    } else if (state !== 'draft') {
      throw new ConflictException(`Work Order "${workOrderId}" cannot be cancelled from state "${state}".`);
    }

    await (manager ?? this.dataSource).transaction(async (txManager) => {
      await this.processEngine.transition(WORK_ORDER_PROCESS, WORK_ORDER_ENTITY_TYPE, workOrderId, 'cancel', actorUserId, txManager);
      if (state === 'released') {
        await this.releaseRemainingReservations(workOrderId, wo.warehouseId, actorUserId, txManager);
      }
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'manufacturing.work_order.cancelled', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: null },
        txManager,
      );
    });
  }
}
