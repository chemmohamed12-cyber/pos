import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { PurchaseReturn } from '../infrastructure/purchase-return.entity';
import { PurchaseReturnLine } from '../infrastructure/purchase-return-line.entity';
import { GoodsReceipt } from '../infrastructure/goods-receipt.entity';
import { GoodsReceiptLine } from '../infrastructure/goods-receipt-line.entity';
import { PURCHASE_RETURN_PROCESS } from '../domain/purchase-return-process';
import { SupplierInvoiceService } from './supplier-invoice.service';
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
  /** a line returns uninvoiced goods (GRNI path) or - with `supplierInvoiceLineId` - goods that were already invoiced (physical return only; the financial settlement is a separate credit note) */
  lines: Array<{ goodsReceiptLineId: string; quantity: string; supplierInvoiceLineId?: string | null }>;
}

/**
 * Phase D-1 / D-3 (owner decisions D7 / E3 and the policy of 2026-10-21) - the formal Purchase Return: the PHYSICAL return of goods. Lifecycle Draft -> Submitted -> Approved -> Posted (independent approver).
 *
 * The physical return and the financial settlement are separate:
 *  - Stock leaves ONCE at the actual book cost (moving average, E3) and the physical `purchase_return_out` movement is recorded - for every line.
 *  - UNINVOICED goods (GRNI path): Dr GRNI at the receipt cost / Cr Inventory at the book cost / the difference to the separate supplier-return cost-difference account. (The supplier has not billed them yet,
 *    so there is no payable to settle.)
 *  - INVOICED goods: the line names the invoice line the goods were billed on. The return does NOT reduce Accounts payable: Dr the clearing account "supplier returns pending credit" / Cr Inventory, both at the
 *    book value. Accounts payable falls only when a supplier credit note settles the return (`SupplierCreditNoteService`, which may link the returned lines); the difference between the book value
 *    and the credited value then goes to the separate cost-difference account. An unsettled return stays visible as "pending supplier credit".
 * A payment already made is never touched. Posting is one atomic unit under the per-order-line advisory lock (shared with invoicing): caps re-checked, counters raised, ONE accounting event; every account
 * is checked BEFORE any mutation. A posted return is never edited or voided.
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
    private readonly invoices: SupplierInvoiceService,
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

  /** received - returned - allocated to live invoices, for one receipt line (the units that can still go back WITHOUT an invoice behind them: not yet invoiced). */
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

  /** Units of ONE (invoice line, receipt line) allocation that can still be returned as INVOICED goods: allocated - already on live returns of that pair, limited by the units physically still there. */
  async returnableInvoicedQuantity(supplierInvoiceLineId: string, goodsReceiptLineId: string, m: EntityManager): Promise<number> {
    const [alloc]: Array<{ allocated: string; physical: string }> = await m.query(
      `SELECT r."quantity"::text AS allocated, (grl."quantityReceived" - grl."quantityReturned" - grl."quantityReturnedInvoiced")::text AS physical
         FROM "supplier_invoice_line_receipts" r JOIN "goods_receipt_lines" grl ON grl."id" = r."goodsReceiptLineId"
        WHERE r."supplierInvoiceLineId" = $1 AND r."goodsReceiptLineId" = $2`,
      [supplierInvoiceLineId, goodsReceiptLineId],
    );
    if (!alloc) return 0;
    const [used]: Array<{ q: string }> = await m.query(
      `SELECT COALESCE(SUM(rl."quantity"), 0)::text AS q FROM "purchase_return_lines" rl JOIN "purchase_returns" pr ON pr."id" = rl."purchaseReturnId"
         JOIN "process_instances" pi ON pi."definitionKey" = 'purchase_return_lifecycle' AND pi."entityId" = pr."id"::text
        WHERE rl."supplierInvoiceLineId" = $1 AND rl."goodsReceiptLineId" = $2 AND pi."currentState" <> 'void'`,
      [supplierInvoiceLineId, goodsReceiptLineId],
    );
    return Math.max(0, Math.min(q3(Number(alloc.allocated) - Number(used.q)), q3(Number(alloc.physical))));
  }

  async createDraft(input: CreatePurchaseReturnInput, actorUserId: string, manager?: EntityManager): Promise<PurchaseReturn & { lines: PurchaseReturnLine[] }> {
    const reason = this.text(input.reason, 'The return reason');
    if (!input.lines || input.lines.length === 0) throw new BadRequestException('A purchase return needs at least one line.');
    const seen = new Set<string>();
    for (const l of input.lines) {
      const key = `${l.goodsReceiptLineId}:${l.supplierInvoiceLineId ?? ''}`;
      if (seen.has(key)) throw new BadRequestException('A goods receipt line can appear only once on a purchase return.');
      seen.add(key);
      const qty = Number(l.quantity);
      if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('Every returned quantity must be a positive number.');
    }
    return this.run(manager, async (m) => {
      const grLines = await m.getRepository(GoodsReceiptLine).find({ where: { id: In([...new Set(input.lines.map((l) => l.goodsReceiptLineId))]) } });
      if (grLines.length !== new Set(input.lines.map((l) => l.goodsReceiptLineId)).size) throw new NotFoundException('A goods receipt line of this return was not found.');
      const receipts = await m.getRepository(GoodsReceipt).find({ where: { id: In([...new Set(grLines.map((g) => g.goodsReceiptId))]) } });
      const supplierIds = new Set(receipts.map((r) => r.supplierId));
      const warehouseIds = new Set(receipts.map((r) => r.warehouseId));
      if (supplierIds.size > 1) throw new ConflictException('One purchase return can cover receipts of one supplier only.');
      if (warehouseIds.size > 1) throw new ConflictException('One purchase return can cover one warehouse only.');
      const [supplierId] = [...supplierIds];
      const [warehouseId] = [...warehouseIds];

      const lineRows: Array<Partial<PurchaseReturnLine>> = [];
      for (const l of input.lines) {
        const g = grLines.find((x) => x.id === l.goodsReceiptLineId)!;
        if (!l.supplierInvoiceLineId) {
          const available = await this.returnableQuantity(g.id, m);
          if (Number(l.quantity) > available) {
            throw new ConflictException(`Cannot return ${l.quantity} - only ${available} of this receipt line can still be returned without an invoice behind it (received ${g.quantityReceived}, already returned, or already invoiced - invoiced goods are returned against their invoice line).`);
          }
          lineRows.push({ goodsReceiptLineId: g.id, purchaseOrderLineId: g.purchaseOrderLineId, productId: g.productId, quantity: l.quantity, receiptUnitCostBase: g.unitCostBase });
          continue;
        }
        // ---- invoiced goods (D-3): physical return only ----
        const [il]: Array<{ id: string; invoiceId: string; supplierId: string }> = await m.query(
          `SELECT sil."id", sil."supplierInvoiceId" AS "invoiceId", si."supplierId" FROM "supplier_invoice_lines" sil JOIN "supplier_invoices" si ON si."id" = sil."supplierInvoiceId" WHERE sil."id" = $1`,
          [l.supplierInvoiceLineId],
        );
        if (!il) throw new NotFoundException(`Supplier invoice line "${l.supplierInvoiceLineId}" not found.`);
        if (il.supplierId !== supplierId) throw new ConflictException('The invoice line belongs to a different supplier than the receipt.');
        const invState = await this.invoices.getStatus(il.invoiceId, m);
        if (invState !== 'posted' && invState !== 'partially_paid' && invState !== 'paid') throw new ConflictException(`The invoice of this line is "${invState}" - only goods on a posted invoice can be returned against it.`);
        const available = await this.returnableInvoicedQuantity(il.id, g.id, m);
        if (Number(l.quantity) > available) throw new ConflictException(`Cannot return ${l.quantity} of invoiced goods - only ${available} of this invoice line / receipt line can still be returned (billed to that receipt, not yet returned, still physically there).`);
        lineRows.push({ goodsReceiptLineId: g.id, purchaseOrderLineId: g.purchaseOrderLineId, productId: g.productId, quantity: l.quantity, receiptUnitCostBase: g.unitCostBase, supplierInvoiceLineId: il.id });
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

  /** Posts an APPROVED return: stock leaves at book cost, counters rise, ONE accounting event. Accounts payable is never touched. All or nothing. */
  async post(id: string, actorUserId: string, manager?: EntityManager): Promise<PurchaseReturn> {
    const saved = await this.run(manager, async (m) => {
      const doc = await this.load(id, m);
      const lines = await m.getRepository(PurchaseReturnLine).find({ where: { purchaseReturnId: id }, order: { id: 'ASC' } });
      if (lines.length === 0) throw new ConflictException('This purchase return has no lines.');

      // serialise with invoicing / other returns (fixed order -> no deadlock), then take the state transition under its row lock
      for (const key of [...new Set(lines.map((l) => l.purchaseOrderLineId))].sort()) await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier_invoice_po_line:${key}`]);
      for (const key of [...new Set(lines.map((l) => `${doc.warehouseId}:${l.productId}`))].sort()) await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      await this.processEngine.transition(PURCHASE_RETURN_PROCESS, ENTITY_TYPE, id, 'post', actorUserId, m);

      // 1. quantity caps re-checked under the locks; 2. expected difference and accounts pre-flight BEFORE any mutation
      let expectedDifference = 0;
      let clearingValue = 0;
      for (const l of lines) {
        const unit = await this.valuation.getUnitCost(l.productId, doc.warehouseId, undefined, m);
        if (!unit) throw new ConflictException(`Cannot post: no valued stock exists for product "${l.productId}" in the return warehouse.`);
        const book = Number(l.quantity) * Number(unit.unitCostBase);
        if (!l.supplierInvoiceLineId) {
          const available = await this.returnableQuantity(l.goodsReceiptLineId, m);
          if (Number(l.quantity) > available) throw new ConflictException(`Cannot post: ${l.quantity} of a receipt line is no longer returnable without an invoice behind it (available ${available}).`);
          expectedDifference += Number(l.quantity) * Number(l.receiptUnitCostBase) - book;
        } else {
          const [alloc]: Array<{ allocated: string; physical: string }> = await m.query(
            `SELECT r."quantity"::text AS allocated, (grl."quantityReceived" - grl."quantityReturned" - grl."quantityReturnedInvoiced")::text AS physical
               FROM "supplier_invoice_line_receipts" r JOIN "goods_receipt_lines" grl ON grl."id" = r."goodsReceiptLineId" WHERE r."supplierInvoiceLineId" = $1 AND r."goodsReceiptLineId" = $2`,
            [l.supplierInvoiceLineId, l.goodsReceiptLineId],
          );
          const [used]: Array<{ q: string }> = await m.query(
            `SELECT COALESCE(SUM(rl."quantity"), 0)::text AS q FROM "purchase_return_lines" rl JOIN "purchase_returns" pr ON pr."id" = rl."purchaseReturnId"
               JOIN "process_instances" pi ON pi."definitionKey" = 'purchase_return_lifecycle' AND pi."entityId" = pr."id"::text
              WHERE rl."supplierInvoiceLineId" = $1 AND rl."goodsReceiptLineId" = $2 AND pi."currentState" <> 'void'`,
            [l.supplierInvoiceLineId, l.goodsReceiptLineId],
          );
          if (!alloc || Number(used.q) > Number(alloc.allocated) + 0.0005 || Number(l.quantity) > Number(alloc.physical) + 0.0005) {
            throw new ConflictException('Cannot post: the invoiced goods of a line can no longer be returned (already returned, or no longer physically there).');
          }
          clearingValue += book; // parked in the clearing account at the book value; no difference is booked until the credit note settles it
        }
      }
      const policy = this.postingPolicy?.get();
      if (!policy?.assertPurchaseReturnPostable) throw new ConflictException('The accounting posting policy for purchase returns is not available - nothing was changed.');
      await policy.assertPurchaseReturnPostable({ expectedDifference: r4(expectedDifference).toFixed(4), clearingValue: r4(clearingValue).toFixed(4) }, m);

      // 3. stock leaves at the actual book cost; physical movement once; counters
      let totalReceiptValue = 0; // uninvoiced lines (GRNI)
      let exitUninvoiced = 0;
      let exitInvoiced = 0; // -> clearing
      const eventLines: Array<{ purchaseReturnLineId: string; productId: string; quantity: string; invoiced: boolean; receiptValueBase: string; exitValueBase: string; differenceBase: string }> = [];
      for (const l of lines) {
        const consumed = await this.valuation.consumeIssueCost(l.productId, doc.warehouseId, Number(l.quantity), `procurement:purchase_return:${id}:line:${l.id}:consume`, m);
        if (!consumed || 'rejected' in consumed) throw new ConflictException(`Cannot post: insufficient valued stock to return ${l.quantity} of product "${l.productId}".`);
        await this.inventory.recordMovement(doc.warehouseId, l.productId, -Number(l.quantity), 'purchase_return_out', 'purchase_return', id, actorUserId, m);
        const counter = l.supplierInvoiceLineId ? 'quantityReturnedInvoiced' : 'quantityReturned';
        await m.query(`UPDATE "goods_receipt_lines" SET "${counter}" = "${counter}" + $2 WHERE "id" = $1`, [l.goodsReceiptLineId, l.quantity]);
        await m.query(`UPDATE "purchase_order_lines" SET "${counter}" = "${counter}" + $2 WHERE "id" = $1`, [l.purchaseOrderLineId, l.quantity]);
        const exitValue = Number(consumed.totalCostBase);
        const receiptValue = l.supplierInvoiceLineId ? 0 : r4(Number(l.quantity) * Number(l.receiptUnitCostBase));
        const diff = l.supplierInvoiceLineId ? 0 : r4(receiptValue - exitValue);
        l.exitValueBase = exitValue.toFixed(4);
        l.differenceBase = diff.toFixed(4);
        totalReceiptValue += receiptValue;
        if (l.supplierInvoiceLineId) exitInvoiced += exitValue;
        else exitUninvoiced += exitValue;
        eventLines.push({ purchaseReturnLineId: l.id, productId: l.productId, quantity: l.quantity, invoiced: !!l.supplierInvoiceLineId, receiptValueBase: receiptValue.toFixed(4), exitValueBase: exitValue.toFixed(4), differenceBase: diff.toFixed(4) });
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
        payloadVersion: 3,
        purchaseReturnId: id,
        returnNumber: doc.returnNumber,
        supplierId: doc.supplierId,
        warehouseId: doc.warehouseId,
        receiptValueBase: r4(totalReceiptValue).toFixed(4),
        exitUninvoicedBase: r4(exitUninvoiced).toFixed(4),
        clearingValueBase: r4(exitInvoiced).toFixed(4),
        exitValueBase: r4(exitUninvoiced + exitInvoiced).toFixed(4),
        differenceBase: r4(totalReceiptValue - exitUninvoiced).toFixed(4),
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
          after: { receiptValueBase: r4(totalReceiptValue).toFixed(4), clearingValueBase: r4(exitInvoiced).toFixed(4), exitValueBase: r4(exitUninvoiced + exitInvoiced).toFixed(4), differenceBase: r4(totalReceiptValue - exitUninvoiced).toFixed(4) },
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

  /** Receipt lines of a supplier with a returnable (not yet invoiced) quantity (for the create form). */
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

  /** Invoiced goods of a supplier that can still go back against their invoice line (physical return; for the create form). */
  async returnableInvoicedLines(supplierId: string, manager?: EntityManager) {
    const m = manager ?? this.dataSource.manager;
    const rows: Array<{ supplierInvoiceLineId: string; invoiceNumber: string; goodsReceiptLineId: string; grNumber: string; productId: string; unitCostBase: string; warehouseId: string }> = await m.query(
      `SELECT sil."id" AS "supplierInvoiceLineId", si."invoiceNumber", grl."id" AS "goodsReceiptLineId", gr."grNumber", sil."productId", sil."unitCostBase"::text AS "unitCostBase", gr."warehouseId"
         FROM "supplier_invoice_line_receipts" r
         JOIN "supplier_invoice_lines" sil ON sil."id" = r."supplierInvoiceLineId" JOIN "supplier_invoices" si ON si."id" = sil."supplierInvoiceId"
         JOIN "goods_receipt_lines" grl ON grl."id" = r."goodsReceiptLineId" JOIN "goods_receipts" gr ON gr."id" = grl."goodsReceiptId"
         JOIN "process_instances" pi ON pi."definitionKey" = 'supplier_invoice_lifecycle' AND pi."entityId" = si."id"::text
        WHERE si."supplierId" = $1 AND pi."currentState" IN ('posted','partially_paid','paid')
        ORDER BY si."createdAt", sil."id", gr."createdAt"`,
      [supplierId],
    );
    const out = [];
    for (const r of rows) {
      const returnable = await this.returnableInvoicedQuantity(r.supplierInvoiceLineId, r.goodsReceiptLineId, m);
      if (returnable > 0) out.push({ ...r, returnable: returnable.toFixed(3) });
    }
    return out;
  }

  /** Posted returns of invoiced goods that no credit note has settled yet ("pending supplier credit"), with the book value waiting in the clearing account. */
  async pendingCredit(supplierId?: string, manager?: EntityManager) {
    const m = manager ?? this.dataSource.manager;
    const rows: Array<{ purchaseReturnLineId: string; returnNumber: string; supplierId: string; supplierInvoiceLineId: string; invoiceNumber: string; productId: string; quantity: string; clearingValueBase: string }> = await m.query(
      `SELECT rl."id" AS "purchaseReturnLineId", pr."returnNumber", pr."supplierId", rl."supplierInvoiceLineId", si."invoiceNumber", rl."productId", rl."quantity"::text AS quantity, rl."exitValueBase"::text AS "clearingValueBase"
         FROM "purchase_return_lines" rl JOIN "purchase_returns" pr ON pr."id" = rl."purchaseReturnId"
         JOIN "supplier_invoice_lines" sil ON sil."id" = rl."supplierInvoiceLineId" JOIN "supplier_invoices" si ON si."id" = sil."supplierInvoiceId"
         JOIN "process_instances" pi ON pi."definitionKey" = 'purchase_return_lifecycle' AND pi."entityId" = pr."id"::text
        WHERE rl."supplierInvoiceLineId" IS NOT NULL AND pi."currentState" = 'posted' AND rl."settledByCreditNoteId" IS NULL ${supplierId ? 'AND pr."supplierId" = $1' : ''}
        ORDER BY pr."createdAt", rl."id"`,
      supplierId ? [supplierId] : [],
    );
    return rows;
  }
}
