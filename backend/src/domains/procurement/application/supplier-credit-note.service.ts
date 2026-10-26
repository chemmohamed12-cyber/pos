import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { SupplierCreditNote } from '../infrastructure/supplier-credit-note.entity';
import { SupplierCreditNoteLine } from '../infrastructure/supplier-credit-note-line.entity';
import { SupplierInvoice } from '../infrastructure/supplier-invoice.entity';
import { SUPPLIER_CREDIT_NOTE_PROCESS } from '../domain/supplier-credit-note-process';
import { InvoiceCreditCapService } from './invoice-credit-cap.service';
import { SupplierLedgerService } from './supplier-ledger.service';
import { SupplierInvoiceService } from './supplier-invoice.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { AP_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ap-events.contract';
import { purchaseOrderBranchOf } from './procurement-org';

const ENTITY_TYPE = 'supplier_credit_note';
const DOCUMENT_TYPE = 'supplier_credit_note';
const PREFIX = 'SCN';
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export interface CreateSupplierCreditNoteInput {
  supplierInvoiceId: string;
  reason: string;
  supplierReference?: string | null;
  /** `purchaseReturnLineId` (optional): the posted return line of invoiced goods this credit SETTLES - the financial side of that physical return */
  lines: Array<{ supplierInvoiceLineId: string; amount: string; purchaseReturnLineId?: string | null }>;
}

/**
 * Phase D-2 (owner decisions D6 / E1, 2026-10-20) - the Supplier Credit Note linked to the original invoice and its lines: Draft -> Submitted -> Approved -> Posted (independent approver).
 *
 * Caps: the net credited per invoice line can never exceed the line's net minus everything already credited by live credit notes AND by returns of invoiced goods (`InvoiceCreditCapService`);
 * the VAT credited is proportional to the invoice's VAT and never above the VAT not yet credited. A credit after partial or full payment is allowed: it never edits or deletes a payment; the
 * invoice's balance simply goes down and may become a credit balance with the supplier (no automatic refund).
 *
 * Policy 2026-10-21 (physical return vs financial settlement): a credit line may LINK a posted return line of invoiced goods. Linked lines SETTLE that return (`finance.supplier_credit_note.return_settled`:
 * Dr AP / Cr the returns clearing account at the book value the return parked / the difference to the separate cost-difference account) and mark the return line settled; unlinked lines are price credits
 * (`finance.supplier_credit_note.cost_adjusted`: Dr AP, Cr Inventory for the share still on hand, Cr the separate "purchase cost differences after receipt" account for the share already sold/consumed - the E1
 * rule). The note's VAT is its own event (`finance.supplier_credit_note.tax_adjusted`: Dr AP / Cr Input VAT). Together they equal the ONE Supplier Ledger debit (net + VAT) linked to the invoice.
 * Posting is one atomic unit under per-invoice-line / per-return-line advisory locks; every account is checked BEFORE any write. A posted credit note is never edited or voided.
 */
@Injectable()
export class SupplierCreditNoteService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly ledger: SupplierLedgerService,
    private readonly invoices: SupplierInvoiceService,
    private readonly caps: InvoiceCreditCapService,
    @Optional() private readonly postingPolicy?: InventoryPostingPolicyRegistry,
  ) {}

  private run<T>(manager: EntityManager | undefined, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return (manager ?? this.dataSource).transaction(fn);
  }

  private async load(id: string, m: EntityManager): Promise<SupplierCreditNote> {
    const found = await m.getRepository(SupplierCreditNote).findOne({ where: { id } });
    if (!found) throw new NotFoundException(`Supplier credit note "${id}" not found.`);
    return found;
  }

  private text(value: string | undefined | null, label: string, min = 3): string {
    const v = (value ?? '').trim();
    if (v.length < min) throw new BadRequestException(`${label} is required (at least ${min} characters).`);
    return v.slice(0, 500);
  }

  async createDraft(input: CreateSupplierCreditNoteInput, actorUserId: string, manager?: EntityManager): Promise<SupplierCreditNote & { lines: SupplierCreditNoteLine[] }> {
    const reason = this.text(input.reason, 'The credit note reason');
    if (!input.lines || input.lines.length === 0) throw new BadRequestException('A credit note needs at least one line.');
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (seen.has(l.supplierInvoiceLineId)) throw new BadRequestException('An invoice line can appear only once on a credit note.');
      seen.add(l.supplierInvoiceLineId);
      const a = Number(l.amount);
      if (!Number.isFinite(a) || a <= 0) throw new BadRequestException('Every credited amount must be a positive number.');
    }
    return this.run(manager, async (m) => {
      const invoice = await m.getRepository(SupplierInvoice).findOne({ where: { id: input.supplierInvoiceId } });
      if (!invoice) throw new NotFoundException(`Supplier invoice "${input.supplierInvoiceId}" not found.`);
      const state = await this.invoices.getStatus(invoice.id, m);
      if (state !== 'posted' && state !== 'partially_paid' && state !== 'paid') {
        throw new ConflictException(`A credit note needs a posted invoice - invoice ${invoice.invoiceNumber} is "${state}".`);
      }
      // serialise the cap check with other credits on the same lines / the same returned lines
      for (const key of [...seen].sort()) await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier_credit:invoice_line:${key}`]);
      for (const key of input.lines.map((l) => l.purchaseReturnLineId).filter(Boolean).sort() as string[]) await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier_credit:return_line:${key}`]);
      let net = 0;
      const lineRows: Array<Partial<SupplierCreditNoteLine>> = [];
      for (const l of input.lines) {
        if (l.purchaseReturnLineId) await this.assertReturnLineSettleable(l.purchaseReturnLineId, l.supplierInvoiceLineId, m);
        const pos = await this.caps.linePosition(l.supplierInvoiceLineId, m);
        if (!pos || pos.invoiceId !== invoice.id) throw new BadRequestException(`Invoice line "${l.supplierInvoiceLineId}" does not belong to invoice ${invoice.invoiceNumber}.`);
        const amount = r2(Number(l.amount));
        if (amount > pos.remainingNet + 0.00001) {
          throw new ConflictException(`Cannot credit ${amount.toFixed(2)} on this line - only ${pos.remainingNet.toFixed(2)} remains creditable (line ${pos.lineNet.toFixed(2)}, already credited ${(pos.creditedByNotes + pos.creditedByReturns).toFixed(2)}).`);
        }
        net += amount;
        lineRows.push({ supplierInvoiceLineId: l.supplierInvoiceLineId, amount: amount.toFixed(2), purchaseReturnLineId: l.purchaseReturnLineId ?? null });
      }
      net = r2(net);
      const tax = await this.caps.proportionalTax(invoice.id, net, m);

      await this.numbering.registerDocumentType(DOCUMENT_TYPE, PREFIX, true, m);
      const creditNoteNumber = await this.numbering.getNextNumber(DOCUMENT_TYPE, m);
      const repo = m.getRepository(SupplierCreditNote);
      const saved = await repo.save(
        repo.create({
          creditNoteNumber,
          supplierInvoiceId: invoice.id,
          supplierId: invoice.supplierId,
          supplierReference: input.supplierReference?.trim() || null,
          reason,
          netAmount: net.toFixed(2),
          taxAmount: tax.toFixed(2),
          createdByUserId: actorUserId,
        }),
      );
      const lineRepo = m.getRepository(SupplierCreditNoteLine);
      const lines = await lineRepo.save(lineRows.map((r) => lineRepo.create({ ...r, supplierCreditNoteId: saved.id })));
      await this.processEngine.start(SUPPLIER_CREDIT_NOTE_PROCESS, ENTITY_TYPE, saved.id, m);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'supplier_credit_note.created',
          resource: 'supplier_credit_note',
          resourceId: saved.id,
          result: 'success',
          correlationId: null,
          after: { creditNoteNumber, supplierInvoiceId: invoice.id, netAmount: net.toFixed(2), taxAmount: tax.toFixed(2) },
        },
        m,
      );
      return Object.assign(saved, { lines });
    });
  }

  /** A returned line can be settled by a note only if it is a POSTED return of THIS invoice line, not yet settled, and not already claimed by another live credit note. */
  private async assertReturnLineSettleable(purchaseReturnLineId: string, supplierInvoiceLineId: string, m: EntityManager): Promise<void> {
    const [row]: Array<{ invoiceLineId: string | null; settled: string | null; state: string }> = await m.query(
      `SELECT rl."supplierInvoiceLineId" AS "invoiceLineId", rl."settledByCreditNoteId" AS settled, pi."currentState" AS state
         FROM "purchase_return_lines" rl JOIN "purchase_returns" pr ON pr."id" = rl."purchaseReturnId"
         JOIN "process_instances" pi ON pi."definitionKey" = 'purchase_return_lifecycle' AND pi."entityId" = pr."id"::text WHERE rl."id" = $1`,
      [purchaseReturnLineId],
    );
    if (!row) throw new NotFoundException(`Purchase return line "${purchaseReturnLineId}" not found.`);
    if (row.state !== 'posted') throw new ConflictException('Only a POSTED purchase return can be settled by a credit note.');
    if (row.invoiceLineId !== supplierInvoiceLineId) throw new ConflictException('The returned line was not billed on this invoice line.');
    if (row.settled) throw new ConflictException('This returned line is already settled by another credit note.');
    const [claimed]: Array<{ n: string }> = await m.query(
      `SELECT COUNT(*)::text AS n FROM "supplier_credit_note_lines" cl JOIN "supplier_credit_notes" cn ON cn."id" = cl."supplierCreditNoteId"
         JOIN "process_instances" pi ON pi."definitionKey" = 'supplier_credit_note_lifecycle' AND pi."entityId" = cn."id"::text
        WHERE cl."purchaseReturnLineId" = $1 AND pi."currentState" <> 'void'`,
      [purchaseReturnLineId],
    );
    if (Number(claimed.n) > 0) throw new ConflictException('This returned line is already claimed by another live credit note.');
  }

  private async transition(id: string, action: string, actorUserId: string, patch: (r: SupplierCreditNote) => void, auditAction: string, manager?: EntityManager, independent = false): Promise<SupplierCreditNote> {
    return this.run(manager, async (m) => {
      const doc = await this.load(id, m);
      if (independent && doc.createdByUserId === actorUserId) {
        throw new ConflictException('The person who created the credit note cannot approve it - a different authorised user must approve it. / لا يجوز لمنشئ الإشعار اعتماده - يلزم مستخدم آخر مخوّل.');
      }
      await this.processEngine.transition(SUPPLIER_CREDIT_NOTE_PROCESS, ENTITY_TYPE, id, action, actorUserId, m);
      patch(doc);
      const saved = await m.getRepository(SupplierCreditNote).save(doc);
      await this.audit.record({ actorUserId, organizationId: null, action: auditAction, resource: 'supplier_credit_note', resourceId: id, result: 'success', correlationId: null }, m);
      return saved;
    });
  }

  submit(id: string, actorUserId: string, manager?: EntityManager) {
    return this.transition(id, 'submit', actorUserId, (r) => (r.submittedByUserId = actorUserId), 'supplier_credit_note.submitted', manager);
  }

  approve(id: string, actorUserId: string, manager?: EntityManager) {
    return this.transition(id, 'approve', actorUserId, (r) => ((r.approvedByUserId = actorUserId), (r.approvedAt = new Date())), 'supplier_credit_note.approved', manager, true);
  }

  async reject(id: string, reason: string, actorUserId: string, manager?: EntityManager) {
    const why = this.text(reason, 'The rejection reason');
    return this.transition(id, 'reject', actorUserId, (r) => (r.rejectedReason = why), 'supplier_credit_note.rejected', manager);
  }

  reopen(id: string, actorUserId: string, manager?: EntityManager) {
    return this.transition(id, 'reopen', actorUserId, (r) => ((r.rejectedReason = null), (r.submittedByUserId = null)), 'supplier_credit_note.reopened', manager);
  }

  async cancel(id: string, reason: string, actorUserId: string, manager?: EntityManager) {
    const why = this.text(reason, 'The cancellation reason');
    return this.transition(id, 'cancel', actorUserId, (r) => (r.voidedReason = why.slice(0, 255)), 'supplier_credit_note.cancelled', manager);
  }

  /** Posts an APPROVED credit note: Supplier Ledger debit + the cost and tax GL events, all or nothing. */
  async post(id: string, actorUserId: string, manager?: EntityManager): Promise<SupplierCreditNote> {
    const saved = await this.run(manager, async (m) => {
      const doc = await this.load(id, m);
      const lines = await m.getRepository(SupplierCreditNoteLine).find({ where: { supplierCreditNoteId: id }, order: { id: 'ASC' } });
      if (lines.length === 0) throw new ConflictException('This credit note has no lines.');
      const invoice = await m.getRepository(SupplierInvoice).findOneOrFail({ where: { id: doc.supplierInvoiceId } });

      for (const key of lines.map((l) => l.supplierInvoiceLineId).sort()) await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier_credit:invoice_line:${key}`]);
      await this.processEngine.transition(SUPPLIER_CREDIT_NOTE_PROCESS, ENTITY_TYPE, id, 'post', actorUserId, m); // state re-checked under the row lock

      // caps re-checked under the locks (this note itself is live, so its own amounts are inside "credited")
      for (const l of lines) {
        const pos = await this.caps.linePosition(l.supplierInvoiceLineId, m);
        if (!pos || pos.remainingNet < -0.00001) throw new ConflictException('Cannot post: the credited value of an invoice line now exceeds the line (another credit was posted meanwhile).');
      }
      if ((await this.caps.invoiceTaxCredited(invoice.id, m)) > Number(invoice.taxAmount ?? 0) + 0.00001) {
        throw new ConflictException('Cannot post: the VAT credited would exceed the invoice VAT.');
      }

      const net = Number(doc.netAmount);
      const tax = Number(doc.taxAmount);
      // linked lines settle a physical return (clearing -> AP); the rest are price credits (E1 cost leg)
      const linked = lines.filter((l) => l.purchaseReturnLineId);
      const unlinked = lines.filter((l) => !l.purchaseReturnLineId);
      const settledNet = r2(linked.reduce((s, l) => s + Number(l.amount), 0));
      const unlinkedNet = r2(unlinked.reduce((s, l) => s + Number(l.amount), 0));
      let clearingValue = 0;
      for (const l of linked) {
        await this.assertReturnLineSettleableForPost(l.purchaseReturnLineId!, l.supplierInvoiceLineId, id, m);
        const [rl]: Array<{ exit: string }> = await m.query(`SELECT "exitValueBase"::text AS exit FROM "purchase_return_lines" WHERE "id" = $1`, [l.purchaseReturnLineId]);
        clearingValue += Number(rl.exit);
      }
      clearingValue = r4(clearingValue);
      const policy = this.postingPolicy?.get();
      if (!policy?.assertPurchaseReturnPostable) throw new ConflictException('The accounting posting policy is not available - nothing was changed.');
      await policy.assertSupplierInvoicePostable({ ppvBase: '0', taxAmount: tax.toFixed(2), discountAmount: unlinkedNet.toFixed(2) }, m); // inventory / cost-difference / VAT accounts, fail-closed
      if (settledNet > 0) await policy.assertPurchaseReturnPostable({ expectedDifference: r4(settledNet - clearingValue).toFixed(4), clearingValue: clearingValue.toFixed(4), settledNet: settledNet.toFixed(2) }, m);

      doc.postedByUserId = actorUserId;
      doc.postedAt = new Date();
      const savedDoc = await m.getRepository(SupplierCreditNote).save(doc);

      await this.ledger.postEntry(
        {
          supplierId: doc.supplierId,
          entryType: 'credit_note',
          direction: 'debit',
          amount: r2(net + tax).toFixed(2),
          purchaseOrderId: invoice.purchaseOrderId,
          supplierInvoiceId: invoice.id,
          reference: doc.creditNoteNumber,
          reason: `Supplier credit note: ${doc.reason}`.slice(0, 255),
          createdByUserId: actorUserId,
        },
        m,
      );

      // cost leg: the credited net is allocated line by line (the credit lines ARE the allocation); on-hand vs sold/consumed is decided by the handler (E1)
      const lineRows: Array<{ id: string; productId: string; quantity: string; warehouseId: string }> = await m.query(
        `SELECT sil."id", sil."productId", sil."quantity"::text AS quantity, po."warehouseId"
           FROM "supplier_invoice_lines" sil JOIN "purchase_order_lines" pol ON pol."id" = sil."purchaseOrderLineId" JOIN "purchase_orders" po ON po."id" = pol."purchaseOrderId"
          WHERE sil."id" = ANY($1::uuid[])`,
        [unlinked.map((l) => l.supplierInvoiceLineId)],
      );
      const byId = new Map(lineRows.map((r) => [r.id, r]));
      const base = {
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: await purchaseOrderBranchOf(m, invoice.purchaseOrderId),
        currency: 'EGP',
        sourceEntityType: 'supplier_credit_note' as const,
        sourceEntityId: id,
        externalDocument: null,
        payloadVersion: 1,
        supplierInvoiceId: invoice.id,
        invoiceNumber: doc.creditNoteNumber,
        supplierId: doc.supplierId,
      };
      if (unlinkedNet > 0) {
        await this.events.publish(m, AP_EVENT_TOPICS.supplierCreditNoteCostAdjusted, {
          ...base,
          idempotencyKey: `procurement:supplier_credit_note:${id}:cost_adjusted`,
          discountAmount: unlinkedNet.toFixed(2),
          freightCapitalizedAmount: '0.00',
          expensedChargesAmount: '0.00',
          allocationBasis: 'line_value' as const,
          lines: unlinked.map((l) => {
            const r = byId.get(l.supplierInvoiceLineId)!;
            return { invoiceLineId: r.id, productId: r.productId, warehouseId: r.warehouseId, quantity: r.quantity, discountShare: r4(Number(l.amount)).toFixed(4), freightShare: '0.0000' };
          }),
        });
      }
      if (settledNet > 0) {
        await this.events.publish(m, AP_EVENT_TOPICS.supplierCreditNoteReturnSettled, {
          ...base,
          idempotencyKey: `procurement:supplier_credit_note:${id}:return_settled`,
          settledNetAmount: settledNet.toFixed(2),
          clearingValueBase: clearingValue.toFixed(4),
        });
        await m.query(`UPDATE "purchase_return_lines" SET "settledByCreditNoteId" = $2 WHERE "id" = ANY($1::uuid[])`, [linked.map((l) => l.purchaseReturnLineId), id]);
      }
      if (tax > 0) {
        await this.events.publish(m, AP_EVENT_TOPICS.supplierCreditNoteTaxAdjusted, {
          ...base,
          idempotencyKey: `procurement:supplier_credit_note:${id}:tax_adjusted`,
          taxAmount: tax.toFixed(2),
        });
      }

      await this.invoices.recomputeStatus(invoice.id, actorUserId, m);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'supplier_credit_note.posted', resource: 'supplier_credit_note', resourceId: id, result: 'success', correlationId: null, after: { netAmount: net.toFixed(2), taxAmount: tax.toFixed(2) } },
        m,
      );
      return savedDoc;
    });
    await this.events.dispatchAfterCommit(manager);
    return saved;
  }

  async get(id: string, manager?: EntityManager): Promise<SupplierCreditNote & { state: string; lines: SupplierCreditNoteLine[] }> {
    const m = manager ?? this.dataSource.manager;
    const doc = await this.load(id, m);
    const lines = await m.getRepository(SupplierCreditNoteLine).find({ where: { supplierCreditNoteId: id }, order: { id: 'ASC' } });
    const state = await this.processEngine.getState(SUPPLIER_CREDIT_NOTE_PROCESS, ENTITY_TYPE, id, m);
    return Object.assign(doc, { state, lines });
  }

  async list(manager?: EntityManager): Promise<Array<SupplierCreditNote & { state: string }>> {
    const m = manager ?? this.dataSource.manager;
    const rows = await m.getRepository(SupplierCreditNote).find({ order: { createdAt: 'DESC' } });
    return Promise.all(rows.map(async (r) => Object.assign(r, { state: await this.processEngine.getState(SUPPLIER_CREDIT_NOTE_PROCESS, ENTITY_TYPE, r.id, m) })));
  }

  /** At posting: the linked returned line must still be a posted, unsettled return of the same invoice line (the note itself is the only live claim on it). */
  private async assertReturnLineSettleableForPost(purchaseReturnLineId: string, supplierInvoiceLineId: string, creditNoteId: string, m: EntityManager): Promise<void> {
    const [row]: Array<{ invoiceLineId: string | null; settled: string | null; state: string }> = await m.query(
      `SELECT rl."supplierInvoiceLineId" AS "invoiceLineId", rl."settledByCreditNoteId" AS settled, pi."currentState" AS state
         FROM "purchase_return_lines" rl JOIN "purchase_returns" pr ON pr."id" = rl."purchaseReturnId"
         JOIN "process_instances" pi ON pi."definitionKey" = 'purchase_return_lifecycle' AND pi."entityId" = pr."id"::text WHERE rl."id" = $1`,
      [purchaseReturnLineId],
    );
    if (!row || row.state !== 'posted' || row.invoiceLineId !== supplierInvoiceLineId || (row.settled && row.settled !== creditNoteId)) {
      throw new ConflictException('Cannot post: a returned line settled by this credit note is no longer a posted, unsettled return of this invoice line.');
    }
  }

  /** Creditable lines of an invoice for the create form: net, credited so far, remaining, and the posted returns still pending supplier credit. */
  async creditableLines(supplierInvoiceId: string, manager?: EntityManager) {
    const m = manager ?? this.dataSource.manager;
    const lines: Array<{ id: string; productId: string; quantity: string }> = await m.query(`SELECT "id", "productId", "quantity"::text AS quantity FROM "supplier_invoice_lines" WHERE "supplierInvoiceId" = $1 ORDER BY "id"`, [supplierInvoiceId]);
    const out = [];
    for (const l of lines) {
      const pos = await this.caps.linePosition(l.id, m);
      const pending: Array<{ purchaseReturnLineId: string; returnNumber: string; quantity: string; clearingValueBase: string }> = await m.query(
        `SELECT rl."id" AS "purchaseReturnLineId", pr."returnNumber", rl."quantity"::text AS quantity, rl."exitValueBase"::text AS "clearingValueBase"
           FROM "purchase_return_lines" rl JOIN "purchase_returns" pr ON pr."id" = rl."purchaseReturnId"
           JOIN "process_instances" pi ON pi."definitionKey" = 'purchase_return_lifecycle' AND pi."entityId" = pr."id"::text
          WHERE rl."supplierInvoiceLineId" = $1 AND pi."currentState" = 'posted' AND rl."settledByCreditNoteId" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "supplier_credit_note_lines" cl JOIN "supplier_credit_notes" cn ON cn."id" = cl."supplierCreditNoteId"
                              JOIN "process_instances" cpi ON cpi."definitionKey" = 'supplier_credit_note_lifecycle' AND cpi."entityId" = cn."id"::text
                             WHERE cl."purchaseReturnLineId" = rl."id" AND cpi."currentState" <> 'void')
          ORDER BY pr."createdAt", rl."id"`,
        [l.id],
      );
      if (pos) out.push({ supplierInvoiceLineId: l.id, productId: l.productId, quantity: l.quantity, lineNet: pos.lineNet.toFixed(2), credited: (pos.creditedByNotes + pos.creditedByReturns).toFixed(2), remaining: pos.remainingNet.toFixed(2), pendingReturns: pending });
    }
    return out;
  }
}
