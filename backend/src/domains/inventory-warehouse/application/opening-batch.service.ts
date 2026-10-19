import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OpeningBatch, OpeningBatchKind } from '../infrastructure/opening-batch.entity';
import { OpeningBatchLine } from '../infrastructure/opening-batch-line.entity';
import { OPENING_BATCH_ENTITY_TYPE, OPENING_BATCH_NUMBERING_SERIES, OPENING_BATCH_PROCESS, OPENING_BATCH_REQUEST_TYPES } from '../domain/opening-batch-process';
import { InventoryService } from './inventory.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { SALES_PRODUCTS_CONTRACT, SalesProductsContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
const DECIMAL = /^\d+(\.\d{1,4})?$/;

export interface OpeningLineInput {
  productId: string;
  /** opening: positive; correction: signed delta (non-zero) */
  quantity: number;
  unitCostBase?: string | null;
}
export interface CreateOpeningBatchInput {
  warehouseId: string;
  cutOffDate: string;
  lines: OpeningLineInput[];
  notes?: string | null;
  /** eligibility exception - the CONTROLLER only passes it when the caller holds `inventory.opening_batch.override`. */
  allowExistingActivity?: boolean;
  overrideReason?: string | null;
}
export interface ControlTotals {
  declaredLineCount: number;
  declaredTotalQuantity: number;
  declaredTotalValueBase: string;
}
export interface OpeningBatchView {
  batch: OpeningBatch;
  lines: OpeningBatchLine[];
  state: string;
}

/**
 * C4 (ADR-INV-01) - the Opening Balance Batch workflow. The ONLY governed way for opening stock to enter once `inventory.opening_batch_required` is on.
 *
 *  - `createDraft` / `createDraftFromRows`: a draft with row-level validation; nothing touches stock, valuation or the ledger.
 *  - `submit`: control totals must equal the lines, the cut-off must be a real, non-future date in an OPEN fiscal period, the accounts the journal needs must resolve,
 *    every (warehouse, product) pair must be eligible; then ONE FA-01 request (two distinct approvers; the maker can never be a checker). Nothing is written to stock.
 *  - approval outcome fires the process (`approve` / `reject`); `post` is a SEPARATE explicit action after approval, idempotent and atomic (one transaction under an
 *    advisory lock: everything re-validated, every line recorded, state flipped, or nothing at all).
 *  - `createReversalBatch`: the exceptional correction of an UNTOUCHED opening (no later movement); `createCorrectionBatch`: the approved, traceable correction of an
 *    opening AFTER stock has moved, posted against the configured EQUITY-side correction account (O-1), never through profit and loss.
 * Quantities, valuation and the ledger move only through `InventoryService.recordMovement` and the existing financial-event path (nothing is edited by hand).
 */
@Injectable()
export class OpeningBatchService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly processEngine: ProcessEngineService,
    private readonly approvals: ApprovalEngineService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    @Inject(SALES_PRODUCTS_CONTRACT) private readonly products: SalesProductsContract,
    @Optional() private readonly postingPolicy?: InventoryPostingPolicyRegistry,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async onModuleInit(): Promise<void> {
    for (const t of Object.values(OPENING_BATCH_REQUEST_TYPES)) {
      await this.approvals.registerRequestType(t.code, t.titleCode);
      await this.approvals
        .upsertMatrixRule({ requestTypeCode: t.code, minApprovers: 2, requiredPermissionNode: t.node, valueThreshold: null, orgUnitId: null }, SYSTEM_ACTOR)
        .catch(() => undefined);
    }
    // the approval outcome drives the document's lifecycle (never a user action)
    this.events.subscribe(
      'approval.request.approved',
      async (payload, ctx) => {
        await this.onApprovalOutcome(payload as Record<string, unknown>, 'approve', ctx.manager ?? undefined);
      },
      { scope: 'company' },
    );
    this.events.subscribe(
      'approval.request.rejected',
      async (payload, ctx) => {
        await this.onApprovalOutcome(payload as Record<string, unknown>, 'reject', ctx.manager ?? undefined);
      },
      { scope: 'company' },
    );
  }

  private async onApprovalOutcome(payload: Record<string, unknown>, action: 'approve' | 'reject', manager?: EntityManager): Promise<void> {
    if (payload.resourceType !== OPENING_BATCH_ENTITY_TYPE || typeof payload.resourceId !== 'string') return;
    const state = await this.processEngine.getState(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, payload.resourceId, manager);
    if (state !== 'submitted') return; // already handled (a replayed event) - never a second transition
    await this.processEngine.transition(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, payload.resourceId, action, SYSTEM_ACTOR, manager);
    await this.audit.record(
      { actorUserId: null, organizationId: null, action: `inventory.opening_batch.${action === 'approve' ? 'approved' : 'rejected'}`, resource: 'inventory_opening_batch', resourceId: payload.resourceId, result: 'success', correlationId: String(payload.approvalRequestId ?? ''), after: { requestTypeCode: payload.requestTypeCode } },
      manager,
    );
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------------
  // drafts
  // ------------------------------------------------------------------------------------------------------------------------------------------------------------

  private assertCalendarDate(value: string, label: string): void {
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!ok) throw new BadRequestException(`${label} "${value}" is not a valid calendar date (YYYY-MM-DD).`);
  }

  private lineValue(quantity: number, unitCost: string): string {
    return (quantity * Number(unitCost)).toFixed(4); // the same expression the journal uses, so batch value = journal value
  }

  private sumScaled(values: string[]): string {
    const scaled = values.reduce((s, v) => s + Math.round(Number(v) * 10000), 0);
    const neg = scaled < 0;
    const abs = Math.abs(scaled);
    return `${neg ? '-' : ''}${Math.floor(abs / 10000)}.${String(abs % 10000).padStart(4, '0')}`;
  }

  async createDraft(input: CreateOpeningBatchInput, actorUserId: string, manager?: EntityManager): Promise<OpeningBatchView> {
    const m = this.em(manager);
    this.assertCalendarDate(input.cutOffDate, 'Cut-off date');
    if (input.cutOffDate > new Date().toISOString().slice(0, 10)) throw new BadRequestException('The cut-off date cannot be in the future.');
    if (input.allowExistingActivity && !(input.overrideReason ?? '').trim()) throw new BadRequestException('An eligibility override needs a written reason.');
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new BadRequestException('An opening batch needs at least one line.');
    const warehouse = await this.inventory.getWarehouse(input.warehouseId, m);
    if (warehouse.status !== 'active') throw new ConflictException(`Warehouse "${warehouse.code}" is inactive - no opening batch can target it.`);

    const seen = new Set<string>();
    for (const l of input.lines) {
      if (seen.has(l.productId)) throw new BadRequestException(`Product "${l.productId}" appears twice in the batch.`);
      seen.add(l.productId);
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new BadRequestException('Every opening line quantity must be a positive whole number.');
      if (!l.unitCostBase || !DECIMAL.test(String(l.unitCostBase)) || !(Number(l.unitCostBase) > 0)) {
        throw new BadRequestException('Every opening line needs a positive unit cost (no quantity without value, no fallback cost).');
      }
      if (!(await this.products.getProductSnapshot(l.productId, m))) throw new BadRequestException(`Product "${l.productId}" was not found.`);
    }
    return this.persistDraft('opening', input.warehouseId, input.cutOffDate, null, null, input, actorUserId, m, input.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCostBase: Number(l.unitCostBase).toFixed(4), lineValueBase: this.lineValue(l.quantity, String(l.unitCostBase)) })));
  }

  private async persistDraft(
    kind: OpeningBatchKind,
    warehouseId: string,
    cutOffDate: string,
    reversalOfBatchId: string | null,
    reason: string | null,
    input: { notes?: string | null; allowExistingActivity?: boolean; overrideReason?: string | null },
    actorUserId: string,
    m: EntityManager,
    lines: Array<{ productId: string; quantity: number; unitCostBase: string | null; lineValueBase: string }>,
  ): Promise<OpeningBatchView> {
    const batchNumber = await this.numbering.getNextNumber(OPENING_BATCH_NUMBERING_SERIES, m);
    return m.transaction(async (tx) => {
      const batches = tx.getRepository(OpeningBatch);
      const saved = await batches.save(
        batches.create({
          batchNumber,
          kind,
          warehouseId,
          cutOffDate,
          reversalOfBatchId,
          reason,
          notes: input.notes ?? null,
          allowExistingActivity: !!input.allowExistingActivity,
          overrideReason: input.allowExistingActivity ? (input.overrideReason ?? '').trim() : null,
          computedTotalValueBase: this.sumScaled(lines.map((l) => l.lineValueBase)),
          createdByUserId: actorUserId,
        }),
      );
      const lineRepo = tx.getRepository(OpeningBatchLine);
      const savedLines = await lineRepo.save(lines.map((l) => lineRepo.create({ batchId: saved.id, warehouseId, productId: l.productId, quantity: l.quantity, unitCostBase: l.unitCostBase, lineValueBase: l.lineValueBase, isActive: false })));
      await this.processEngine.start(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, saved.id, tx);
      await this.audit.record({ actorUserId, organizationId: null, action: `inventory.opening_batch.${kind}_created`, resource: 'inventory_opening_batch', resourceId: saved.id, result: 'success', correlationId: null, after: { batchNumber, warehouseId, cutOffDate, lines: savedLines.length } }, tx);
      return { batch: saved, lines: savedLines, state: 'draft' };
    });
  }

  /**
   * Excel / row import (ADR-INV-01 2.2.9): the existing template (`warehouseCode, productSku, quantity, unitCost`) loads into a DRAFT batch with row-level validation. Rows that fail
   * are returned with their errors and are NOT in the draft; when no row is valid no batch is created. One batch is one warehouse: a row naming another warehouse is rejected.
   */
  async createDraftFromRows(
    rows: Array<{ warehouseCode: string; productSku: string; quantity: string; unitCost: string }>,
    input: { cutOffDate: string; notes?: string | null },
    actorUserId: string,
    manager?: EntityManager,
    visibleWarehouseIds?: 'ALL' | string[],
  ): Promise<{ draft: OpeningBatchView | null; rejected: Array<{ row: number; errors: string[] }> }> {
    const m = this.em(manager);
    const allWarehouses = await this.inventory.listWarehouses(m);
    const warehouses = !visibleWarehouseIds || visibleWarehouseIds === 'ALL' ? allWarehouses : allWarehouses.filter((w) => visibleWarehouseIds.includes(w.id));
    const rejected: Array<{ row: number; errors: string[] }> = [];
    const valid: OpeningLineInput[] = [];
    let warehouseId: string | null = null;
    let warehouseCode: string | null = null;
    const seenProducts = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const errors: string[] = [];
      const code = (rows[i].warehouseCode ?? '').trim();
      const sku = (rows[i].productSku ?? '').trim();
      const qty = (rows[i].quantity ?? '').trim();
      const cost = (rows[i].unitCost ?? '').trim();
      const wh = code ? warehouses.find((w) => w.code === code) : undefined;
      if (!code) errors.push('Warehouse Code is required.');
      else if (!wh) errors.push(`Warehouse Code "${code}" was not found.`);
      else if (warehouseCode && warehouseCode !== code) errors.push(`A batch is one warehouse: this row names "${code}" but the batch is for "${warehouseCode}".`);
      const product = sku ? await this.products.getProductSnapshotBySku(sku, m) : null;
      if (!sku) errors.push('Product SKU is required.');
      else if (!product) errors.push(`Product SKU "${sku}" was not found.`);
      else if (seenProducts.has(product.id)) errors.push(`Product SKU "${sku}" appears twice.`);
      if (!qty || !Number.isInteger(Number(qty)) || Number(qty) <= 0) errors.push(`Quantity "${qty}" must be a positive whole number.`);
      if (!cost || !DECIMAL.test(cost) || !(Number(cost) > 0)) errors.push(`Unit Cost "${cost}" must be a positive number.`);
      if (errors.length > 0) {
        rejected.push({ row: i + 2, errors });
        continue;
      }
      warehouseId = warehouseId ?? wh!.id;
      warehouseCode = warehouseCode ?? code;
      seenProducts.add(product!.id);
      valid.push({ productId: product!.id, quantity: Number(qty), unitCostBase: cost });
    }
    if (valid.length === 0 || !warehouseId) return { draft: null, rejected };
    return { draft: await this.createDraft({ warehouseId, cutOffDate: input.cutOffDate, lines: valid, notes: input.notes ?? null }, actorUserId, m), rejected };
  }

  /** Reversal of an UNTOUCHED opening (ADR-INV-01 2.3): a new `reversal` batch that references the posted original and carries every one of its lines. */
  async createReversalBatch(originalBatchId: string, input: { cutOffDate: string; reason: string; notes?: string | null }, actorUserId: string, manager?: EntityManager): Promise<OpeningBatchView> {
    const m = this.em(manager);
    if (!(input.reason ?? '').trim()) throw new BadRequestException('A reversal needs a written reason.');
    this.assertCalendarDate(input.cutOffDate, 'Effective date');
    const original = await this.requirePostedOpening(originalBatchId, m);
    const lines = await m.getRepository(OpeningBatchLine).find({ where: { batchId: original.id } });
    return this.persistDraft('reversal', original.warehouseId, input.cutOffDate, original.id, input.reason.trim(), input, actorUserId, m, lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCostBase: l.unitCostBase, lineValueBase: l.lineValueBase })));
  }

  /** Correction AFTER stock has moved (O-1): an approved, traceable batch that references the original opening; posted against the equity-side correction account. */
  async createCorrectionBatch(
    originalBatchId: string,
    input: { cutOffDate: string; reason: string; lines: Array<{ productId: string; deltaQuantity: number; unitCostBase?: string | null }>; notes?: string | null },
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<OpeningBatchView> {
    const m = this.em(manager);
    if (!(input.reason ?? '').trim()) throw new BadRequestException('A correction needs a written reason.');
    this.assertCalendarDate(input.cutOffDate, 'Effective date');
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new BadRequestException('A correction needs at least one line.');
    const original = await this.requirePostedOpening(originalBatchId, m);
    const originalLines = await m.getRepository(OpeningBatchLine).find({ where: { batchId: original.id } });
    const seen = new Set<string>();
    const lines = input.lines.map((l) => {
      if (seen.has(l.productId)) throw new BadRequestException(`Product "${l.productId}" appears twice in the correction.`);
      seen.add(l.productId);
      if (!originalLines.some((o) => o.productId === l.productId)) throw new BadRequestException(`Product "${l.productId}" is not a line of the original batch ${original.batchNumber}.`);
      if (!Number.isInteger(l.deltaQuantity) || l.deltaQuantity === 0) throw new BadRequestException('A correction line needs a non-zero whole-number quantity change.');
      if (l.deltaQuantity > 0 && (!l.unitCostBase || !DECIMAL.test(String(l.unitCostBase)) || !(Number(l.unitCostBase) > 0))) {
        throw new BadRequestException('A correction that adds stock needs a positive unit cost (no fallback cost).');
      }
      return {
        productId: l.productId,
        quantity: l.deltaQuantity,
        unitCostBase: l.deltaQuantity > 0 ? Number(l.unitCostBase).toFixed(4) : null,
        lineValueBase: l.deltaQuantity > 0 ? this.lineValue(l.deltaQuantity, String(l.unitCostBase)) : '0.0000', // a decrease is valued at the moving average when it posts
      };
    });
    return this.persistDraft('correction', original.warehouseId, input.cutOffDate, original.id, input.reason.trim(), input, actorUserId, m, lines);
  }

  private async requirePostedOpening(batchId: string, m: EntityManager): Promise<OpeningBatch> {
    const batch = await m.getRepository(OpeningBatch).findOne({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(`Opening batch "${batchId}" not found.`);
    if (batch.kind !== 'opening') throw new ConflictException('Only an opening batch can be reversed or corrected.');
    const state = await this.processEngine.getState(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, batch.id, m);
    if (state !== 'posted') throw new ConflictException(`Opening batch ${batch.batchNumber} is "${state}", not posted - only a posted opening can be reversed or corrected.`);
    return batch;
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------------
  // validation (shared by submit and post)
  // ------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async onHand(m: EntityManager, warehouseId: string, productId: string): Promise<number> {
    return this.inventory.getOnHandQuantityInTransaction(m, warehouseId, productId);
  }

  /** Every reason this batch cannot be submitted / posted right now (an empty list = it can). */
  async validate(batch: OpeningBatch, lines: OpeningBatchLine[], m: EntityManager): Promise<string[]> {
    const problems: string[] = [];
    // "activity" = every stock movement of the pair EXCEPT those that belong to an inactive batch line: the original movement of a REVERSED opening and the movement of its
    // reversal net to zero, so a reversed opening re-opens the pair for a corrected batch (ADR-INV-01 2.3) instead of blocking it forever.
    const movementsOf = async (productId: string) =>
      (await m.query(
        `SELECT sm.id, sm."referenceType", sm."referenceId" FROM stock_movements sm
          WHERE sm."warehouseId" = $1 AND sm."productId" = $2
            AND NOT EXISTS (SELECT 1 FROM inventory_opening_batch_lines l WHERE l."stockMovementId" = sm.id AND NOT l."isActive")`,
        [batch.warehouseId, productId],
      )) as Array<{ id: string; referenceType: string | null; referenceId: string | null }>;

    if (batch.kind === 'opening') {
      for (const l of lines) {
        const active = await m.getRepository(OpeningBatchLine).findOne({ where: { warehouseId: batch.warehouseId, productId: l.productId, isActive: true } });
        if (active && active.batchId !== batch.id) problems.push(`product ${l.productId}: already has an active opening line (batch ${active.batchId}); reverse that batch first`);
        else if (!batch.allowExistingActivity && (await movementsOf(l.productId)).length > 0) problems.push(`product ${l.productId}: already has stock activity in this warehouse - an opening is only for an untouched pair`);
      }
    } else {
      const original = await m.getRepository(OpeningBatch).findOne({ where: { id: batch.reversalOfBatchId ?? '' } });
      if (!original) return [`the original batch ${batch.reversalOfBatchId} was not found`];
      const originalState = await this.processEngine.getState(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, original.id, m);
      if (originalState !== 'posted') problems.push(`the original batch ${original.batchNumber} is "${originalState}", not posted`);
      const originalLines = await m.getRepository(OpeningBatchLine).find({ where: { batchId: original.id } });
      for (const l of lines) {
        const o = originalLines.find((x) => x.productId === l.productId);
        if (!o || !o.isActive) {
          problems.push(`product ${l.productId}: has no active opening line in ${original.batchNumber}`);
          continue;
        }
        if (batch.kind === 'reversal') {
          const others = (await movementsOf(l.productId)).filter((mv) => mv.id !== o.stockMovementId);
          if (others.length > 0) problems.push(`product ${l.productId}: has later stock movements - an opening that has moved cannot be reversed; use a correction batch`);
        } else if (l.quantity < 0 && (await this.onHand(m, batch.warehouseId, l.productId)) < -l.quantity) {
          problems.push(`product ${l.productId}: the correction removes ${-l.quantity} but fewer are on hand`);
        }
      }
    }
    return problems;
  }

  private async assertPostable(batch: OpeningBatch, lines: OpeningBatchLine[], m: EntityManager): Promise<void> {
    await this.inventory.resolveBusinessDate(batch.cutOffDate, m); // real date, not in the future, OPEN fiscal period - before anything is written
    const policy = this.postingPolicy?.get();
    if (policy?.assertOpeningBatchPostable) await policy.assertOpeningBatchPostable(batch.kind, m);
    const problems = await this.validate(batch, lines, m);
    if (problems.length > 0) throw new ConflictException(`Opening batch ${batch.batchNumber} cannot proceed: ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? ` (+${problems.length - 20} more)` : ''}`);
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------------
  // submit / post
  // ------------------------------------------------------------------------------------------------------------------------------------------------------------

  async submit(batchId: string, totals: Partial<ControlTotals> | null, actorUserId: string, manager?: EntityManager): Promise<OpeningBatchView> {
    const m = this.em(manager);
    const batch = await m.getRepository(OpeningBatch).findOne({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(`Opening batch "${batchId}" not found.`);
    const state = await this.processEngine.getState(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, batch.id, m);
    if (state !== 'draft') throw new ConflictException(`Opening batch ${batch.batchNumber} is "${state}" - only a draft can be submitted.`);
    const lines = await m.getRepository(OpeningBatchLine).find({ where: { batchId: batch.id } });

    // control totals (opening batches): the maker's declaration must equal what the lines add up to
    const computedValue = this.sumScaled(lines.map((l) => l.lineValueBase));
    const computedQty = lines.reduce((s, l) => s + l.quantity, 0);
    if (batch.kind === 'opening') {
      if (!totals || totals.declaredLineCount === undefined || totals.declaredTotalQuantity === undefined || totals.declaredTotalValueBase === undefined) {
        throw new BadRequestException('The control totals (line count, total quantity, total value) are required to submit an opening batch.');
      }
      const mismatches: string[] = [];
      if (totals.declaredLineCount !== lines.length) mismatches.push(`line count declared ${totals.declaredLineCount} but the batch has ${lines.length}`);
      if (totals.declaredTotalQuantity !== computedQty) mismatches.push(`total quantity declared ${totals.declaredTotalQuantity} but the lines add up to ${computedQty}`);
      if (this.sumScaled([String(totals.declaredTotalValueBase)]) !== computedValue) mismatches.push(`total value declared ${totals.declaredTotalValueBase} but the lines add up to ${computedValue}`);
      if (mismatches.length > 0) throw new ConflictException(`Control totals do not match: ${mismatches.join('; ')}.`);
    } else if (!(batch.reason ?? '').trim()) {
      throw new BadRequestException('A reversal / correction needs a written reason.');
    }

    await this.assertPostable(batch, lines, m);

    const requestType = OPENING_BATCH_REQUEST_TYPES[batch.kind];
    return m.transaction(async (tx) => {
      await this.processEngine.transition(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, batch.id, 'submit', actorUserId, tx);
      const request = await this.approvals.submit(
        {
          requestTypeCode: requestType.code,
          resourceType: OPENING_BATCH_ENTITY_TYPE,
          resourceId: batch.id,
          requestedAction: `post_${batch.kind}_batch`,
          payload: { batchId: batch.id, batchNumber: batch.batchNumber, kind: batch.kind, cutOffDate: batch.cutOffDate, lines: lines.length, totalValueBase: computedValue },
          makerUserId: actorUserId,
          orgUnitId: null,
        },
        tx,
      );
      await tx.getRepository(OpeningBatch).update(batch.id, {
        ...(batch.kind === 'opening' ? { declaredLineCount: totals!.declaredLineCount!, declaredTotalQuantity: totals!.declaredTotalQuantity!, declaredTotalValueBase: Number(totals!.declaredTotalValueBase).toFixed(4) } : {}),
        computedTotalValueBase: computedValue,
        approvalRequestId: request.id,
        submittedAt: new Date(),
      });
      await this.audit.record({ actorUserId, organizationId: null, action: 'inventory.opening_batch.submitted', resource: 'inventory_opening_batch', resourceId: batch.id, result: 'success', correlationId: request.id, after: { kind: batch.kind, totalValueBase: computedValue } }, tx);
      return this.view(batch.id, tx);
    });
  }

  /**
   * The explicit, idempotent `post` after approval (ADR-INV-01 2.2.6). One transaction under an advisory lock on the batch: the state is re-read inside the lock (a replay of a
   * posted batch is a no-op), everything is re-validated, every line is recorded through `InventoryService.recordMovement` at the batch's cut-off date, the lines become active (or,
   * for a reversal, the original lines become inactive again), the state flips. Any failure rolls the WHOLE batch back and leaves it `approved`, retryable.
   */
  async post(batchId: string, actorUserId: string, manager?: EntityManager): Promise<{ posted: boolean; view: OpeningBatchView }> {
    const m = this.em(manager);
    const result = await m.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`opening_batch_post:${batchId}`]);
      const batch = await tx.getRepository(OpeningBatch).findOne({ where: { id: batchId } });
      if (!batch) throw new NotFoundException(`Opening batch "${batchId}" not found.`);
      const state = await this.processEngine.getState(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, batch.id, tx);
      if (state === 'posted' || state === 'reversed') return { posted: false, view: await this.view(batch.id, tx) };
      if (state !== 'approved') throw new ConflictException(`Opening batch ${batch.batchNumber} is "${state}" - it must be approved before it can be posted.`);
      const lineRepo = tx.getRepository(OpeningBatchLine);
      const lines = await lineRepo.find({ where: { batchId: batch.id }, order: { productId: 'ASC' } });
      await this.assertPostable(batch, lines, tx);

      const original = batch.kind === 'opening' ? null : await tx.getRepository(OpeningBatch).findOneOrFail({ where: { id: batch.reversalOfBatchId! } });
      const originalLines = original ? await lineRepo.find({ where: { batchId: original.id } }) : [];
      for (const line of lines) {
        const extras: Record<string, unknown> = { batchId: batch.id, batchNumber: batch.batchNumber, batchLineId: line.id, batchKind: batch.kind };
        let movementId: string;
        if (batch.kind === 'opening') {
          movementId = (await this.inventory.recordMovement(batch.warehouseId, line.productId, line.quantity, 'receipt', 'opening_batch', batch.id, actorUserId, tx, line.unitCostBase, undefined, batch.cutOffDate, extras)).id;
          await lineRepo.update(line.id, { stockMovementId: movementId, isActive: true });
        } else if (batch.kind === 'reversal') {
          const o = originalLines.find((x) => x.productId === line.productId)!;
          movementId = (await this.inventory.recordMovement(batch.warehouseId, line.productId, -line.quantity, 'adjustment', 'opening_batch_reversal', batch.id, actorUserId, tx, undefined, undefined, batch.cutOffDate, { ...extras, originalBatchId: original!.id, originalMovementId: o.stockMovementId, reason: batch.reason })).id;
          await lineRepo.update(line.id, { stockMovementId: movementId });
          await lineRepo.update(o.id, { isActive: false }); // re-opens the pair for a corrected batch
        } else {
          movementId = (await this.inventory.recordMovement(batch.warehouseId, line.productId, line.quantity, 'adjustment', 'opening_batch_correction', batch.id, actorUserId, tx, line.unitCostBase, undefined, batch.cutOffDate, { ...extras, originalBatchId: original!.id, reason: batch.reason })).id;
          await lineRepo.update(line.id, { stockMovementId: movementId });
        }
      }
      await tx.getRepository(OpeningBatch).update(batch.id, { postedAt: new Date() });
      await this.processEngine.transition(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, batch.id, 'post', actorUserId, tx);
      if (batch.kind === 'reversal') await this.processEngine.transition(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, original!.id, 'reverse', actorUserId, tx);
      await this.audit.record({ actorUserId, organizationId: null, action: 'inventory.opening_batch.posted', resource: 'inventory_opening_batch', resourceId: batch.id, result: 'success', correlationId: batch.approvalRequestId, after: { kind: batch.kind, lines: lines.length, cutOffDate: batch.cutOffDate } }, tx);
      return { posted: true, view: await this.view(batch.id, tx) };
    });
    return result;
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------------
  // reads
  // ------------------------------------------------------------------------------------------------------------------------------------------------------------

  async view(batchId: string, manager?: EntityManager): Promise<OpeningBatchView> {
    const m = this.em(manager);
    const batch = await m.getRepository(OpeningBatch).findOne({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(`Opening batch "${batchId}" not found.`);
    const lines = await m.getRepository(OpeningBatchLine).find({ where: { batchId }, order: { productId: 'ASC' } });
    const state = await this.processEngine.getState(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, batchId, m);
    return { batch, lines, state };
  }

  async list(manager?: EntityManager, visibleWarehouseIds?: string[]): Promise<Array<{ batch: OpeningBatch; state: string }>> {
    const m = this.em(manager);
    const all = await m.getRepository(OpeningBatch).find({ order: { createdAt: 'DESC' }, take: 200 });
    const visible = visibleWarehouseIds ? all.filter((b) => visibleWarehouseIds.includes(b.warehouseId)) : all;
    const out: Array<{ batch: OpeningBatch; state: string }> = [];
    for (const batch of visible) out.push({ batch, state: await this.processEngine.getState(OPENING_BATCH_PROCESS, OPENING_BATCH_ENTITY_TYPE, batch.id, m) });
    return out;
  }
}
