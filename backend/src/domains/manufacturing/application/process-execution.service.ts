import { unmetPredecessors } from './process-readiness';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../../../foundation/audit/audit.service';
import { INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { WorkOrder } from '../infrastructure/work-order.entity';
import { WorkOrderComponent } from '../infrastructure/work-order-component.entity';
import { OperationFlow, OperationRun } from '../infrastructure/operation-run.entity';
import { ProcessEdge, ProcessInput, ProcessOperation, ProcessOutput } from '../infrastructure/process-definition.entity';
import { WorkOrderService } from './work-order.service';
import { ProcessDefinitionService, ProcessVersionView } from './process-definition.service';

export interface OperationLedgerRow {
  code: string;
  name: string;
  kind: string | null;
  optional: boolean;
  maxRuns: number;
  status: 'pending' | 'ready' | 'running' | 'completed' | 'skipped';
  blockedBy: string[];
  runs: number;
  consumed: Array<{ productId: string; sku: string | null; quantity: number; valueBase: string }>;
  yielded: Array<{ productId: string; sku: string | null; quantity: number; valueBase: string }>;
  /** Material value consumed by this operation and not (yet) carried out by its outputs - what is "inside" the operation right now. */
  wipValueBase: string;
  /** Value of the scrap recorded against this operation (it left the operation's WIP at the pooled cost - D7). */
  scrappedValueBase: string;
  /** Scrap / rework / rejected / held recorded against this operation (quantity only - no cost element). */
  outcomes: Array<{ outcomeClass: string; quantity: number }>;
  /** What the definition plans for this order: inputs under its alternate choices and outputs, in whole base units for the full plan. */
  plan: { inputs: Array<{ productId: string; sku: string | null; quantity: number }>; outputs: Array<{ productId: string; sku: string | null; quantity: number; intermediate: boolean }> };
}

export interface ProcessExecutionView {
  workOrderId: string;
  version: ProcessVersionView['version'];
  operations: OperationLedgerRow[];
  runs: OperationRun[];
  /** Intermediate items yielded and not yet consumed by a later operation, with the value they carry. */
  intermediateOnHand: Array<{ productId: string; sku: string | null; quantity: number; valueBase: string }>;
  totals: { rawConsumedValueBase: string; operationWipValueBase: string; intermediateOnHandValueBase: string; scrappedValueBase: string };
}

/**
 * Manufacturing Engine S4 (decision D-ME-3) - EXECUTION of a process version on a Work Order: graph-gated operation runs, per-operation material consumption and yields, and
 * the derived production ledger. It moves NO stock and posts NOTHING: physical movements and journals stay on the unchanged order lifecycle (issue / output / scrap), and
 * the per-operation WIP is a read model over `mfg_operation_flows` (quantity + material value at the order's WIP unit cost). No labour / machine / overhead element exists.
 */
@Injectable()
export class ProcessExecutionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly workOrders: WorkOrderService,
    private readonly definitions: ProcessDefinitionService,
    private readonly audit: AuditService,
    @Inject(INVENTORY_VALUATION_CONTRACT) private readonly valuation: InventoryValuationContract,
  ) {}

  // ---- reads ----
  async getExecution(workOrderId: string, manager?: EntityManager): Promise<ProcessExecutionView> {
    const m = manager ?? this.dataSource;
    const wo = await this.workOrders.getWorkOrderOrThrow(workOrderId, manager);
    if (!wo.processVersionId) throw new ConflictException(`Work Order "${workOrderId}" is not process-bound (Basic Profile).`);
    const def = await this.definitions.get(wo.processVersionId, manager);
    const runs = await m.getRepository(OperationRun).find({ where: { workOrderId }, order: { startedAt: 'ASC' } });
    const flows = await m.getRepository(OperationFlow).find({ where: { workOrderId } });
    const results = await m.query(`SELECT "operationId", "outcomeClass", SUM("quantity")::int AS quantity, SUM("valueBase")::text AS value FROM "work_order_results" WHERE "workOrderId" = $1 AND "operationId" IS NOT NULL GROUP BY 1, 2`, [workOrderId]) as Array<{ operationId: string; outcomeClass: string; quantity: number; value: string }>;
    const skuOf = new Map<string, string | null>();
    const ids = [...new Set(flows.map((f) => f.productId))];
    if (ids.length) for (const p of (await m.query(`SELECT "id","sku" FROM "products" WHERE "id" = ANY($1)`, [ids])) as Array<{ id: string; sku: string }>) skuOf.set(p.id, p.sku);
    const preds = new Map<string, string[]>();
    for (const e of def.edges) (preds.get(e.to) ?? preds.set(e.to, []).get(e.to)!).push(e.from);
    const byOp = new Map(def.operations.map((o) => [o.code, o]));
    const runsOf = (code: string) => runs.filter((r) => r.operationCode === code);
    const optionalOf = new Map(def.operations.map((o) => [o.code, o.optional]));
    const sum = (rows: OperationFlow[]) => {
      const agg = new Map<string, { quantity: number; value: number }>();
      for (const f of rows) {
        const a = agg.get(f.productId) ?? { quantity: 0, value: 0 };
        a.quantity += f.quantity;
        a.value += Number(f.valueBase);
        agg.set(f.productId, a);
      }
      return [...agg.entries()].map(([productId, a]) => ({ productId, sku: skuOf.get(productId) ?? null, quantity: a.quantity, valueBase: a.value.toFixed(4) }));
    };
    const operations: OperationLedgerRow[] = def.operations.map((o) => {
      const rs = runsOf(o.code);
      const blockedBy = unmetPredecessors(o.code, preds, optionalOf, runs);
      const opFlows = flows.filter((f) => f.operationId === o.id);
      const valueIn = opFlows.filter((f) => f.direction === 'in').reduce((s, f) => s + Number(f.valueBase), 0);
      const valueOut = opFlows.filter((f) => f.direction === 'out').reduce((s, f) => s + Number(f.valueBase), 0);
      // D7: value written off as scrap AT this operation has left its WIP too (the good yield carries input value minus this scrap)
      const scrapValue = results.filter((r) => r.operationId === o.id && r.outcomeClass === 'scrap').reduce((s, r) => s + Number(r.value ?? 0), 0);
      const status: OperationLedgerRow['status'] = rs.some((r) => r.status === 'running')
        ? 'running'
        : rs.some((r) => r.status === 'completed')
          ? 'completed'
          : rs.some((r) => r.status === 'skipped')
            ? 'skipped'
            : blockedBy.length > 0
              ? 'pending'
              : 'ready';
      return {
        code: o.code,
        name: o.name,
        kind: o.operationTypeKind,
        optional: o.optional,
        maxRuns: o.maxRuns,
        status,
        blockedBy,
        runs: rs.filter((r) => r.status !== 'skipped').length,
        consumed: sum(opFlows.filter((f) => f.direction === 'in')),
        yielded: sum(opFlows.filter((f) => f.direction === 'out')),
        wipValueBase: Math.max(0, valueIn - valueOut - scrapValue).toFixed(4),
        scrappedValueBase: scrapValue.toFixed(4),
        outcomes: results.filter((r) => r.operationId === o.id).map((r) => ({ outcomeClass: r.outcomeClass, quantity: r.quantity })),
        plan: {
          inputs: def.inputs
            .filter((i) => i.operationCode === o.code && (!i.alternateGroup || wo.processChoices?.[`${o.code}|${i.alternateGroup}`] === i.componentProductId))
            .map((i) => ({ productId: i.componentProductId, sku: i.componentSku, quantity: i.quantityPerUnit * wo.quantityPlanned })),
          outputs: def.outputs.filter((x) => x.operationCode === o.code).map((x) => ({ productId: x.productId, sku: x.sku, quantity: x.quantityPerUnit * wo.quantityPlanned, intermediate: x.intermediate })),
        },
      };
    });
    const intermediates = new Set(def.outputs.filter((x) => x.intermediate).map((x) => x.productId));
    const onHand = [...intermediates]
      .map((pid) => {
        const out = flows.filter((f) => f.direction === 'out' && f.productId === pid);
        const inn = flows.filter((f) => f.direction === 'in' && f.productId === pid);
        const qty = out.reduce((s, f) => s + f.quantity, 0) - inn.reduce((s, f) => s + f.quantity, 0);
        const val = out.reduce((s, f) => s + Number(f.valueBase), 0) - inn.reduce((s, f) => s + Number(f.valueBase), 0);
        return { productId: pid, sku: skuOf.get(pid) ?? null, quantity: qty, valueBase: val.toFixed(4) };
      })
      .filter((x) => x.quantity !== 0 || Number(x.valueBase) !== 0);
    const raw = flows.filter((f) => f.direction === 'in' && !intermediates.has(f.productId)).reduce((s, f) => s + Number(f.valueBase), 0);
    return {
      workOrderId,
      version: def.version,
      operations,
      runs,
      intermediateOnHand: onHand,
      totals: {
        rawConsumedValueBase: raw.toFixed(4),
        operationWipValueBase: operations.reduce((s, o) => s + Number(o.wipValueBase), 0).toFixed(4),
        intermediateOnHandValueBase: onHand.reduce((s, x) => s + Number(x.valueBase), 0).toFixed(4),
        scrappedValueBase: operations.reduce((s, o) => s + Number(o.scrappedValueBase), 0).toFixed(4),
      },
    };
  }

  // ---- runs ----
  async startOperation(workOrderId: string, operationCode: string, actorUserId: string | null, requestId: string = randomUUID(), manager?: EntityManager): Promise<OperationRun> {
    return (manager ?? this.dataSource).transaction(async (tx) => {
      const { wo, op, def } = await this.context(workOrderId, operationCode, tx);
      this.assertExecutable(wo, await this.workOrders.getWorkOrderState(workOrderId, tx));
      await this.lock(workOrderId, tx);
      const existing = await tx.getRepository(OperationRun).findOne({ where: { workOrderId, operationId: op.id, requestId } });
      if (existing) return existing;
      const runs = await tx.getRepository(OperationRun).find({ where: { workOrderId, operationId: op.id } });
      if (runs.some((r) => r.status === 'skipped')) throw new ConflictException(`Operation "${operationCode}" was skipped on this order.`);
      if (runs.some((r) => r.status === 'running')) throw new ConflictException(`Operation "${operationCode}" already has a run in progress.`);
      if (runs.length >= op.maxRuns) throw new ConflictException(`Operation "${operationCode}" has used its ${op.maxRuns} permitted run(s).`);
      const allRuns = await tx.getRepository(OperationRun).find({ where: { workOrderId } });
      const byId = new Map(def.operations.map((o) => [o.id, o]));
      const predMap = new Map<string, string[]>();
      for (const e of def.edges) (predMap.get(e.to) ?? predMap.set(e.to, []).get(e.to)!).push(e.from);
      const blocking = unmetPredecessors(operationCode, predMap, new Map(def.operations.map((o) => [o.code, o.optional])), allRuns).map((code) => ({ code }));
      if (blocking.length > 0) throw new ConflictException(`Operation "${operationCode}" cannot start - waiting for: ${blocking.map((b) => b.code).join(', ')}.`);
      const run = await tx.getRepository(OperationRun).save(
        tx.getRepository(OperationRun).create({ workOrderId, operationId: op.id, operationCode, runNo: runs.length + 1, status: 'running', startedByUserId: actorUserId, requestId }),
      );
      await this.audit.record({ actorUserId, organizationId: null, action: 'manufacturing.process.operation_started', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: run.id, after: { operationCode, runNo: run.runNo } }, tx);
      return run;
    });
  }

  async skipOperation(workOrderId: string, operationCode: string, actorUserId: string | null, requestId: string = randomUUID(), manager?: EntityManager): Promise<OperationRun> {
    return (manager ?? this.dataSource).transaction(async (tx) => {
      const { wo, op } = await this.context(workOrderId, operationCode, tx);
      this.assertExecutable(wo, await this.workOrders.getWorkOrderState(workOrderId, tx));
      await this.lock(workOrderId, tx);
      if (!op.optional) throw new ConflictException(`Operation "${operationCode}" is mandatory and cannot be skipped.`);
      const existing = await tx.getRepository(OperationRun).find({ where: { workOrderId, operationId: op.id } });
      if (existing.some((r) => r.requestId === requestId)) return existing.find((r) => r.requestId === requestId)!;
      if (existing.length > 0) throw new ConflictException(`Operation "${operationCode}" already has runs on this order and cannot be skipped.`);
      return tx.getRepository(OperationRun).save(
        tx.getRepository(OperationRun).create({ workOrderId, operationId: op.id, operationCode, runNo: 1, status: 'skipped', startedByUserId: actorUserId, completedAt: new Date(), completedByUserId: actorUserId, requestId }),
      );
    });
  }

  /** Material consumed by a RUNNING operation. Bounded by the operation's planned input, by what was actually issued (raw) and by what earlier operations yielded (intermediates). */
  async recordConsumption(workOrderId: string, runId: string, productId: string, quantity: number, actorUserId: string | null, requestId: string = randomUUID(), manager?: EntityManager): Promise<OperationFlow> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new ConflictException('quantity must be a positive whole number of base units.');
    return (manager ?? this.dataSource).transaction(async (tx) => {
      const { wo, def, run, op } = await this.runContext(workOrderId, runId, tx);
      this.assertExecutable(wo, await this.workOrders.getWorkOrderState(workOrderId, tx));
      await this.lock(workOrderId, tx);
      const dup = await tx.getRepository(OperationFlow).findOne({ where: { runId, direction: 'in', productId, requestId } });
      if (dup) return dup;
      const lines = await tx.getRepository(ProcessInput).find({ where: { versionId: def.version.id, operationId: op.id, componentProductId: productId } });
      const eligible = lines.filter((l) => !l.alternateGroup || wo.processChoices?.[`${op.code}|${l.alternateGroup}`] === productId);
      if (eligible.length === 0) throw new ConflictException(`Operation "${op.code}" does not consume "${productId}" under this order's choices.`);
      const plannedTotal = eligible.reduce((s, l) => s + l.quantityPerUnit, 0) * wo.quantityPlanned;
      const flows = await tx.getRepository(OperationFlow).find({ where: { workOrderId } });
      const consumedHere = flows.filter((f) => f.direction === 'in' && f.operationId === op.id && f.productId === productId).reduce((s, f) => s + f.quantity, 0);
      if (consumedHere + quantity > plannedTotal) throw new ConflictException(`Cannot consume ${quantity} - operation "${op.code}" plans ${plannedTotal} of this item and has consumed ${consumedHere}.`);
      const intermediateOuts = def.outputs.filter((x) => x.intermediate && x.productId === productId);
      let valueBase: string;
      if (intermediateOuts.length > 0) {
        const outs = flows.filter((f) => f.direction === 'out' && f.productId === productId);
        const ins = flows.filter((f) => f.direction === 'in' && f.productId === productId);
        const outQty = outs.reduce((s, f) => s + f.quantity, 0);
        const available = outQty - ins.reduce((s, f) => s + f.quantity, 0);
        if (quantity > available) throw new ConflictException(`Cannot consume ${quantity} - only ${available} of this intermediate item has been yielded and not yet consumed.`);
        const outValue = outs.reduce((s, f) => s + Number(f.valueBase), 0);
        valueBase = outQty > 0 ? ((outValue / outQty) * quantity).toFixed(4) : '0.0000';
      } else {
        const component = await tx.getRepository(WorkOrderComponent).findOne({ where: { workOrderId, componentProductId: productId } });
        if (!component) throw new ConflictException(`"${productId}" is not part of this order's released material snapshot.`);
        const consumedAll = flows.filter((f) => f.direction === 'in' && f.productId === productId).reduce((s, f) => s + f.quantity, 0);
        if (consumedAll + quantity > component.quantityIssued) throw new ConflictException(`Cannot consume ${quantity} - only ${component.quantityIssued} has been issued to this order and ${consumedAll} is already consumed by operations.`);
        const cost = wo.wipWarehouseId ? await this.valuation.getUnitCost(productId, wo.wipWarehouseId, undefined, tx) : null;
        valueBase = (Number(cost?.unitCostBase ?? 0) * quantity).toFixed(4);
      }
      const flow = await tx.getRepository(OperationFlow).save(
        tx.getRepository(OperationFlow).create({ runId, workOrderId, operationId: op.id, direction: 'in', productId, quantity, valueBase, requestId, createdByUserId: actorUserId }),
      );
      await this.audit.record({ actorUserId, organizationId: null, action: 'manufacturing.process.consumption_recorded', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: flow.id, after: { operationCode: op.code, productId, quantity, valueBase } }, tx);
      return flow;
    });
  }

  /** Quantity yielded by a RUNNING operation, one of the operation's defined outputs, bounded by plan. Its value is stamped when the run completes. */
  async recordYield(workOrderId: string, runId: string, productId: string, quantity: number, actorUserId: string | null, requestId: string = randomUUID(), manager?: EntityManager): Promise<OperationFlow> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new ConflictException('quantity must be a positive whole number of base units.');
    return (manager ?? this.dataSource).transaction(async (tx) => {
      const { wo, def, run, op } = await this.runContext(workOrderId, runId, tx);
      this.assertExecutable(wo, await this.workOrders.getWorkOrderState(workOrderId, tx));
      await this.lock(workOrderId, tx);
      const dup = await tx.getRepository(OperationFlow).findOne({ where: { runId, direction: 'out', productId, requestId } });
      if (dup) return dup;
      const outs = await tx.getRepository(ProcessOutput).find({ where: { versionId: def.version.id, operationId: op.id, productId } });
      if (outs.length === 0) throw new ConflictException(`Operation "${op.code}" does not yield "${productId}".`);
      const planned = outs.reduce((s, o) => s + o.quantityPerUnit, 0) * wo.quantityPlanned;
      const flows = await tx.getRepository(OperationFlow).find({ where: { workOrderId, operationId: op.id, direction: 'out', productId } });
      const already = flows.reduce((s, f) => s + f.quantity, 0);
      if (already + quantity > planned) throw new ConflictException(`Cannot record a yield of ${quantity} - operation "${op.code}" plans ${planned} of this item and has yielded ${already}.`);
      const flow = await tx.getRepository(OperationFlow).save(
        tx.getRepository(OperationFlow).create({ runId: run.id, workOrderId, operationId: op.id, direction: 'out', productId, quantity, valueBase: '0', requestId, createdByUserId: actorUserId }),
      );
      await this.audit.record({ actorUserId, organizationId: null, action: 'manufacturing.process.yield_recorded', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: flow.id, after: { operationCode: op.code, productId, quantity } }, tx);
      return flow;
    });
  }

  /**
   * Completes a run and stamps the value of its yields: the material value the run consumed is shared over its yields by (allocation weight x quantity). A run that
   * yielded nothing carries no value forward (its consumed value stays visible as the operation's WIP). Idempotent for an already completed run.
   */
  async completeRun(workOrderId: string, runId: string, actorUserId: string | null, manager?: EntityManager): Promise<OperationRun> {
    return (manager ?? this.dataSource).transaction(async (tx) => {
      const { wo, def, run, op } = await this.runContext(workOrderId, runId, tx, true);
      if (run.status === 'completed') return run;
      this.assertExecutable(wo, await this.workOrders.getWorkOrderState(workOrderId, tx));
      await this.lock(workOrderId, tx);
      const flows = await tx.getRepository(OperationFlow).find({ where: { runId } });
      const valueIn = flows.filter((f) => f.direction === 'in').reduce((s, f) => s + Number(f.valueBase), 0);
      const outs = flows.filter((f) => f.direction === 'out');
      // D7 (UX stage 5): value already written off as SCRAP booked against this operation during this run left the operation's WIP - it is not carried by the good yield.
      // Yield value = run input value - that scrap (a later run of the same operation only sees scrap recorded after it started). No schema change: the result rows already carry operationId + valueBase.
      const scrapRows = (await tx.query(`SELECT COALESCE(SUM("valueBase"), 0) AS n FROM "work_order_results" WHERE "workOrderId" = $1 AND "operationId" = $2 AND "outcomeClass" = 'scrap' AND "createdAt" >= $3`, [workOrderId, op.id, run.startedAt])) as Array<{ n: string }>;
      const scrapValue = Number(scrapRows[0]?.n ?? 0);
      const valueOut = Math.max(0, valueIn - scrapValue);
      if (outs.length > 0 && valueOut > 0) {
        const outDefs = await tx.getRepository(ProcessOutput).find({ where: { versionId: def.version.id, operationId: op.id } });
        const weightOf = (productId: string) => outDefs.filter((d) => d.productId === productId).reduce((s, d) => Math.max(s, d.allocationWeight), 0);
        const basis = outs.map((f) => weightOf(f.productId) * f.quantity);
        const total = basis.reduce((s, b) => s + b, 0);
        if (total > 0) {
          let assigned = 0;
          for (let i = 0; i < outs.length; i++) {
            const share = i === outs.length - 1 ? valueOut - assigned : Number(((valueOut * basis[i]) / total).toFixed(4));
            assigned += share;
            await tx.getRepository(OperationFlow).update(outs[i].id, { valueBase: Math.max(0, share).toFixed(4) });
          }
        }
      }
      run.status = 'completed';
      run.completedAt = new Date();
      run.completedByUserId = actorUserId;
      const saved = await tx.getRepository(OperationRun).save(run);
      await this.audit.record({ actorUserId, organizationId: null, action: 'manufacturing.process.operation_completed', resource: 'work_order', resourceId: workOrderId, result: 'success', correlationId: run.id, after: { operationCode: op.code, runNo: run.runNo, valueIn: valueIn.toFixed(4), scrapValue: scrapValue.toFixed(4), valueOut: valueOut.toFixed(4) } }, tx);
      return saved;
    });
  }

  /** Scrap found while a run is in progress: the order-level scrap (pooled cost -> loss account, S1) tagged to the operation. */
  async recordScrapAt(workOrderId: string, runId: string, quantity: number, reason: string, actorUserId: string | null, requestId: string = randomUUID(), manager?: EntityManager) {
    const { op } = await this.runContext(workOrderId, runId, manager ?? this.dataSource.manager);
    return this.workOrders.recordScrap(workOrderId, quantity, reason, actorUserId, requestId, manager, op.id);
  }

  /** Rework / rejected / held units found by a run (a quality operation typically): quantity-only tracking, blocks closing until resolved. */
  async recordOutcomeAt(workOrderId: string, runId: string, outcomeClass: 'rework' | 'rejected' | 'held', quantity: number, reason: string, actorUserId: string | null, requestId: string = randomUUID(), manager?: EntityManager) {
    const { op } = await this.runContext(workOrderId, runId, manager ?? this.dataSource.manager);
    return this.workOrders.recordTrackedOutcome(workOrderId, outcomeClass, quantity, reason, actorUserId, requestId, manager, op.id);
  }

  // ---- internals ----
  private assertExecutable(wo: WorkOrder, state: string): void {
    if (state !== 'in_progress') throw new ConflictException(`Work Order "${wo.id}" is "${state}" - operations run only while it is in progress (issue material first).`);
  }

  private async lock(workOrderId: string, tx: EntityManager): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manufacturing:work_order:${workOrderId}:process`]);
  }

  private async context(workOrderId: string, operationCode: string, tx: EntityManager) {
    const wo = await this.workOrders.getWorkOrderOrThrow(workOrderId, tx);
    if (!wo.processVersionId) throw new ConflictException(`Work Order "${workOrderId}" is not process-bound (Basic Profile).`);
    const def = await this.definitions.get(wo.processVersionId, tx);
    const op = def.operations.find((o) => o.code === operationCode);
    if (!op) throw new NotFoundException(`Operation "${operationCode}" is not part of process version ${def.version.versionNo}.`);
    return { wo, def, op: op as ProcessOperation };
  }

  private async runContext(workOrderId: string, runId: string, tx: EntityManager, allowCompleted = false) {
    const run = await tx.getRepository(OperationRun).findOne({ where: { id: runId, workOrderId } });
    if (!run) throw new NotFoundException(`Run "${runId}" not found on Work Order "${workOrderId}".`);
    if (run.status !== 'running' && !(allowCompleted && run.status === 'completed')) throw new ConflictException(`Run "${runId}" is ${run.status}; only a running operation accepts this.`);
    const { wo, def, op } = await this.context(workOrderId, run.operationCode, tx);
    return { wo, def, run, op };
  }
}
