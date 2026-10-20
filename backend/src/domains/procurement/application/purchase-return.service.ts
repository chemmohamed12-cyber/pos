import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { PurchaseReturn } from '../infrastructure/purchase-return.entity';
import { PurchaseReturnLine } from '../infrastructure/purchase-return-line.entity';
import { GoodsReceipt } from '../infrastructure/goods-receipt.entity';
import { GoodsReceiptLine } from '../infrastructure/goods-receipt-line.entity';
import { PURCHASE_RETURN_PROCESS } from '../domain/purchase-return-process';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { AP_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ap-events.contract';

const ENTITY_TYPE = 'purchase_return';
const DOCUMENT_TYPE = 'purchase_return';
const PREFIX = 'PRET';
const q3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export interface CreatePurchaseReturnInput {
  reason: string;
  lines: Array<{ goodsReceiptLineId: string; quantity: string }>;
}

/**
 * Phase D-1 (owner decisions D7 / E3, 2026-10-20) - the formal Purchase Return of goods that are RECEIVED BUT NOT YET INVOICED (the GRNI path). Lifecycle Draft -> Submitted -> Approved -> Posted.
 *
 * Posting is one atomic unit under per-order-line advisory locks (the SAME lock the invoice allocation takes, so a return and an invoice can never both claim the same received units):
 *  1. the returnable quantity of every receipt line is re-checked: received - already returned - allocated to live invoices (an invoiced unit is NOT returned here - that needs a credit note);
 *  2. the stock leaves at the ACTUAL book cost (moving average) - the valuation engine's own issue cost, E3 - and the physical `purchase_return_out` movement is recorded once;
 *  3. the receipt / order-line returned counters rise, so the quantity available to invoice and the GRNI sub-ledger fall by the same amount;
 *  4. ONE `procurement.purchase_return.posted` event: Dr GRNI (the receipt's own cost) / Cr Inventory (the value that left) / the difference to the separately configured supplier-return cost-difference
 *     account. Every account is checked BEFORE any mutation. Exactly-once: the state transition is taken under the row lock and the event has its own idempotency key.
 * A posted return is never edited or voided; no posted source document is rewritten.
 */
@Injectable()
export class PurchaseReturnService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly inventory: InventoryService,
    @Inject(INVENTORY_VALUATION_CONTRACT) private readonly valuation: InventoryValuationContract,
    @Optional() private readonly postingPolicy?: InventoryPostingPolicyRegistry,
  ) {}

  private run<T>(manager: EntityManager | undefined, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    // ALWAYS a transaction: a caller's manager that is not already inside one must not turn the document's writes into separate commits
    return (manager ?? this.dataSource).transaction(fn);
  }

  private async load(id: string, m: EntityManager): Promise<PurchaseReturn> {
    const found = await m.getRepository(PurchaseReturn).findOne({ where: { id } });
    if (!found) throw new NotFoundException(`Purchase return "${id}" not found.`);
    return found;
  }

  private text(value: string | undefined | null, label: string, min = 3): string {
    const v = (value ?? '').trim();
    if (v.length < min) throw new BadRequestException(`${label} is required (at least ${min} characters).`);
    return v.slice(0, 500);
  }

  /** received - returned - allocated to live invoices, for one receipt line (the units that can still go back WITHOUT a credit note). */
  async returnableQuantity(goodsReceiptLineId: string, m: EntityManager): Promise<number> {
    const [row]: Array<{ received: string; returned: string; allocated: string }> = await m.query(
      `SELECT grl."quantityReceived"::text AS received, grl."quantityReturned"::text AS returned,
              COALESCE((SELECT SUM(r."quantity") FROM "supplier_invoice_line_receipts" r WHERE r."goodsReceiptLineId" = grl."id"), 0)::text AS allocated
         FROM "goods_receipt_lines" grl WHERE grl."id" = $1`,
      [goodsReceiptLineId],
    );
    if (!row) throw new NotFoundException(`Goods receipt line "${goodsReceiptLineId}" not found.`);
    return q3(Number(row.received) - Number(row.returned) - Number(row.allocated));
  }

  async createDraft(input: CreatePurchaseReturnInput, actorUserId: string, manager?: EntityManager): Promise<PurchaseReturn & { lines: PurchaseReturnLine[] }> {
    const reason = this.text(input.reason, 'The return reason');
    if (!input.lines || input.lines.length === 0) throw new BadRequestException('A purchase return needs at least one line.');
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (seen.has(l.goodsReceiptLineId)) throw new BadRequestException('A goods receipt line can appear only once on a purchase return.');
      seen.add(l.goodsReceiptLineId);
      const qty = Number(l.quantity);
      if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('Every returned quantity must be a positive number.');
    }
    return this.run(manager, async (m) => {
      const grLines = await m.getRepository(GoodsReceiptLine).find({ where: { id: In(input.lines.map((l) => l.goodsReceiptLineId)) } });
      if (grLines.length !== input.lines.length) throw new NotFoundException('A goods receipt line of this return was not found.');
      const receipts = await m.getRepository(GoodsReceipt).find({ where: { id: In([...new Set(grLines.map((g) => g.goodsReceiptId))]) } });
      const receiptById = new Map(receipts.map((r) => [r.id, r]));
      const supplierIds = new Set(receipts.map((r) => r.supplierId));
      const warehouseIds = new Set(receipts.map((r) => r.warehouseId));
      if (supplierIds.size > 1) throw new ConflictException('One purchase return can cover receipts of one supplier only.');
      if (warehouseIds.size > 1) throw new ConflictException('One purchase return can cover one warehouse only.');
      const [supplierId] = [...supplierIds];
      const [warehouseId] = [...warehouseIds];

      const lineRows: Array<Partial<PurchaseReturnLine>> = [];
      for (const l of input.lines) {
        const g = grLines.find((x) => x.id === l.goodsReceiptLineId)!;
        const available = await this.returnableQuantity(g.id, m);
        if (Number(l.quantity) > available) {
          throw new ConflictException(`Cannot return ${l.quantity} - only ${available} of this receipt line can still be returned without a credit note (received ${g.quantityReceived}, already returned, or already invoiced).`);
        }
        lineRows.push({ goodsReceiptLineId: g.id, purchaseOrderLineId: g.purchaseOrderLineId, productId: g.productId, quantity: l.quantity, receiptUnitCostBase: g.unitCostBase });
        void receiptById;
      }

      await this.numbering.registerDocumentType(DOCUMENT_TYPE, PREFIX, true, m);
      const returnNumber = await this.numbering.getNextNumber(DOCUMENT_TYPE, m);
      const repo = m.getRepository(PurchaseReturn);
      const saved = await repo.save(repo.create({ returnNumber, supplierId, warehouseId, reason, createdByUserId: actorUserId }));
      const lineRepo = m.getRepository(PurchaseReturnLine);
      const lines = await lineRepo.save(lineRows.map((r) => lineRepo.create({ ...r, purchaseReturnId: saved.id })));
      await this.processEngine.start(PURCHASE_RETURN_PROCESS, ENTITY_TYPE, saved.id, m);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'purchase_return.created', resource: 'purchase_return', resourceId: saved.id, result: 'success', correlationId: null, after: { returnNumber, supplierId, warehouseId, lines: lines.length } },
        m,
      );
      return Object.assign(saved, { lines });
    });
  }

  private async transition(id: string, action: string, actorUserId: string, patch: (r: PurchaseReturn) => void, auditAction: string, manager?: EntityManager, independent = false): Promise<PurchaseReturn> {
    return this.run(manager, async (m) => {
      const doc = await this.load(id, m);
      if (independent && doc.createdByUserId === actorUserId) {
        throw new ConflictException('The person who created the return cannot approve it - a different authorised user must approve it. / لا يجوز لمنشئ المردود اعتماده - يلزم مستخدم آخر مخوّل.');
      }
      await this.processEngine.transition(PURCHASE_RETURN_PROCESS, ENTITY_TYPE, id, action, actorUserId, m); // state re-checked under the row lock
      patch(doc);
      const saved = await m.getRepository(PurchaseReturn).save(doc);
      await this.audit.record({ actorUserId, organizationId: null, action: auditAction, resource: 'purchase_return', resourceId: id, result: 'success', correlationId: null }, m);
      return saved;
    });
  }

  submit(id: string, actorUserId: string, manager?: EntityManager) {
    return this.transition(id, 'submit', actorUserId, (r) => (r.submittedByUserId = actorUserId), 'purchase_return.submitted', manager);
  }

  approve(id: string, actorUserId: string, manager?: EntityManager) {
    return this.transition(id, 'approve', actorUserId, (r) => ((r.approvedByUserId = actorUserId), (r.approvedAt = new Date())), 'purchase_return.approved', manager, true);
  }

  async reject(id: string, reason: string, actorUserId: string, manager?: EntityManager) {
    const why = this.text(reason, 'The rejection reason');
    return this.transition(id, 'reject', actorUserId, (r) => (r.rejectedReason = why), 'purchase_return.rejected', manager);
  }

  reopen(id: string, actorUserId: string, manager?: EntityManager) {
    return this.transition(id, 'reopen', actorUserId, (r) => ((r.rejectedReason = null), (r.submittedByUserId = null)), 'purchase_return.reopened', manager);
  }

  async cancel(id: string, reason: string, actorUserId: string, manager?: EntityManager) {
    const why = this.text(reason, 'The cancellation reason');
    return this.transition(id, 'cancel', actorUserId, (r) => (r.voidedReason = why.slice(0, 255)), 'purchase_return.cancelled', manager);
  }

  /** Posts an APPROVED return: stock leaves at book cost, counters rise, one accounting event. All or nothing. */
  async post(id: string, actorUserId: string, manager?: EntityManager): Promise<PurchaseReturn> {
    const saved = await this.run(manager, async (m) => {
      const doc = await this.load(id, m);
      const lines = await m.getRepository(PurchaseReturnLine).find({ where: { purchaseReturnId: id }, order: { id: 'ASC' } });
      if (lines.length === 0) throw new ConflictException('This purchase return has no lines.');

      // serialise with invoicing on the same order lines (fixed order -> no deadlock), then take the state transition under its row lock
      for (const key of [...new Set(lines.map((l) => l.purchaseOrderLineId))].sort()) await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier_invoice_po_line:${key}`]);
      for (const key of [...new Set(lines.map((l) => `${doc.warehouseId}:${l.productId}`))].sort()) await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      await this.processEngine.transition(PURCHASE_RETURN_PROCESS, ENTITY_TYPE, id, 'post', actorUserId, m);

      // 1. quantity re-check under the locks; 2. expected difference -> account pre-flight BEFORE any mutation
      let expectedDifference = 0;
      for (const l of lines) {
        const available = await this.returnableQuantity(l.goodsReceiptLineId, m);
        if (Number(l.quantity) > available) throw new ConflictException(`Cannot post: ${l.quantity} of a receipt line is no longer returnable without a credit note (available ${available}).`);
        const unit = await this.valuation.getUnitCost(l.productId, doc.warehouseId, undefined, m);
        if (!unit) throw new ConflictException(`Cannot post: no valued stock exists for product "${l.productId}" in the return warehouse.`);
        expectedDifference += Number(l.quantity) * (Number(l.receiptUnitCostBase) - Number(unit.unitCostBase));
      }
      const policy = this.postingPolicy?.get();
      if (!policy?.assertPurchaseReturnPostable) throw new ConflictException('The accounting posting policy for purchase returns is not available - nothing was changed.');
      await policy.assertPurchaseReturnPostable({ expectedDifference: r4(expectedDifference).toFixed(4) }, m);

      // 3. stock leaves at the actual book cost; physical movement once; counters
      let totalReceiptValue = 0;
      let totalExitValue = 0;
      const eventLines: Array<{ purchaseReturnLineId: string; productId: string; quantity: string; receiptValueBase: string; exitValueBase: string; differenceBase: string }> = [];
      for (const l of lines) {
        const consumed = await this.valuation.consumeIssueCost(l.productId, doc.warehouseId, Number(l.quantity), `procurement:purchase_return:${id}:line:${l.id}:consume`, m);
        if (!consumed || 'rejected' in consumed) throw new ConflictException(`Cannot post: insufficient valued stock to return ${l.quantity} of product "${l.productId}".`);
        await this.inventory.recordMovement(doc.warehouseId, l.productId, -Number(l.quantity), 'purchase_return_out', 'purchase_return', id, actorUserId, m);
        await m.query(`UPDATE "goods_receipt_lines" SET "quantityReturned" = "quantityReturned" + $2 WHERE "id" = $1`, [l.goodsReceiptLineId, l.quantity]);
        await m.query(`UPDATE "purchase_order_lines" SET "quantityReturned" = "quantityReturned" + $2 WHERE "id" = $1`, [l.purchaseOrderLineId, l.quantity]);
        const receiptValue = r4(Number(l.quantity) * Number(l.receiptUnitCostBase));
        const exitValue = Number(consumed.totalCostBase);
        const diff = r4(receiptValue - exitValue);
        l.exitValueBase = exitValue.toFixed(4);
        l.differenceBase = diff.toFixed(4);
        totalReceiptValue += receiptValue;
        totalExitValue += exitValue;
        eventLines.push({ purchaseReturnLineId: l.id, productId: l.productId, quantity: l.quantity, receiptValueBase: receiptValue.toFixed(4), exitValueBase: exitValue.toFixed(4), differenceBase: diff.toFixed(4) });
      }
      await m.getRepository(PurchaseReturnLine).save(lines);

      doc.postedByUserId = actorUserId;
      doc.postedAt = new Date();
      const savedDoc = await m.getRepository(PurchaseReturn).save(doc);

      await this.events.publish(m, AP_EVENT_TOPICS.purchaseReturnPosted, {
        idempotencyKey: `procurement:purchase_return:${id}:posted`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null,
        currency: 'EGP',
        sourceEntityType: 'purchase_return' as const,
        sourceEntityId: id,
        externalDocument: null,
        payloadVersion: 1,
        purchaseReturnId: id,
        returnNumber: doc.returnNumber,
        supplierId: doc.supplierId,
        warehouseId: doc.warehouseId,
        receiptValueBase: r4(totalReceiptValue).toFixed(4),
        exitValueBase: r4(totalExitValue).toFixed(4),
        differenceBase: r4(totalReceiptValue - totalExitValue).toFixed(4),
        lines: eventLines,
      });
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'purchase_return.posted',
          resource: 'purchase_return',
          resourceId: id,
          result: 'success',
          correlationId: null,
          after: { receiptValueBase: r4(totalReceiptValue).toFixed(4), exitValueBase: r4(totalExitValue).toFixed(4), differenceBase: r4(totalReceiptValue - totalExitValue).toFixed(4) },
        },
        m,
      );
      return savedDoc;
    });
    await this.events.dispatchAfterCommit(manager);
    return saved;
  }

  async get(id: string, manager?: EntityManager): Promise<PurchaseReturn & { state: string; lines: PurchaseReturnLine[] }> {
    const m = manager ?? this.dataSource.manager;
    const doc = await this.load(id, m);
    const lines = await m.getRepository(PurchaseReturnLine).find({ where: { purchaseReturnId: id }, order: { id: 'ASC' } });
    const state = await this.processEngine.getState(PURCHASE_RETURN_PROCESS, ENTITY_TYPE, id, m);
    return Object.assign(doc, { state, lines });
  }

  async list(manager?: EntityManager): Promise<Array<PurchaseReturn & { state: string }>> {
    const m = manager ?? this.dataSource.manager;
    const rows = await m.getRepository(PurchaseReturn).find({ order: { createdAt: 'DESC' } });
    return Promise.all(rows.map(async (r) => Object.assign(r, { state: await this.processEngine.getState(PURCHASE_RETURN_PROCESS, ENTITY_TYPE, r.id, m) })));
  }

  /** Receipt lines of a supplier with a returnable quantity (for the create form). */
  async returnableLines(supplierId: string, manager?: EntityManager) {
    const m = manager ?? this.dataSource.manager;
    const rows: Array<{ goodsReceiptLineId: string; grNumber: string; productId: string; warehouseId: string; unitCostBase: string; returnable: string }> = await m.query(
      `SELECT grl."id" AS "goodsReceiptLineId", gr."grNumber", grl."productId", gr."warehouseId", grl."unitCostBase"::text AS "unitCostBase",
              (grl."quantityReceived" - grl."quantityReturned" - COALESCE((SELECT SUM(r."quantity") FROM "supplier_invoice_line_receipts" r WHERE r."goodsReceiptLineId" = grl."id"), 0))::text AS returnable
         FROM "goods_receipt_lines" grl JOIN "goods_receipts" gr ON gr."id" = grl."goodsReceiptId"
        WHERE gr."supplierId" = $1
          AND (grl."quantityReceived" - grl."quantityReturned" - COALESCE((SELECT SUM(r."quantity") FROM "supplier_invoice_line_receipts" r WHERE r."goodsReceiptLineId" = grl."id"), 0)) > 0
        ORDER BY gr."createdAt", grl."id"`,
      [supplierId],
    );
    return rows;
  }
}
