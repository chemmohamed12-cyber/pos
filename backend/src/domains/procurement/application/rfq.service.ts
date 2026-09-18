import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Rfq } from '../infrastructure/rfq.entity';
import { RfqSupplierInvite } from '../infrastructure/rfq-supplier-invite.entity';
import { SupplierQuotation } from '../infrastructure/supplier-quotation.entity';
import { SupplierQuotationLine } from '../infrastructure/supplier-quotation-line.entity';
import { PurchaseRequest } from '../infrastructure/purchase-request.entity';
import { PurchaseRequestLine } from '../infrastructure/purchase-request-line.entity';
import { RFQ_PROCESS } from '../domain/rfq-process';
import { PurchaseOrderService } from './purchase-order.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';

const RFQ_ENTITY_TYPE = 'rfq';
const QUOTATION_DOCUMENT_TYPE = 'supplier_quotation';
const RFQ_AWARD_REQUEST_TYPE = 'procurement.rfq_award';

export interface RecordQuotationLineInput {
  purchaseRequestLineId: string;
  quantity: string;
  unitCostBase: string;
}
export interface RecordQuotationInput {
  rfqId: string;
  supplierId: string;
  notes?: string | null;
  lines: RecordQuotationLineInput[];
}

interface RfqAwardPayload {
  rfqId: string;
  quotationId: string;
  warehouseId: string;
  supplierId: string;
  lines: Array<{ productId: string; quantity: string; unitCostBase: string }>;
}

/**
 * ADR-048 — Path B: RFQ + Supplier Quotation + the Evaluation/Approval
 * step. `awardToSupplier` is a maker action (submits to the generic
 * Approval Engine, the SAME segregation-of-duties mechanism
 * `SupplierBankAccount` changes already use — this is the CTO directive's
 * explicit "Evaluation/Approval" step, not a rubber-stamp). On approval,
 * `onApprovalApproved` (the SAME self-registering
 * `events.subscribe('approval.request.approved', ...)` pattern
 * `ApAdjustmentService` already uses) creates the real Purchase Order
 * from the WINNING quotation's own lines/prices — never re-typed, never
 * re-priced — atomically with the RFQ's `sent -> awarded` transition.
 */
@Injectable()
export class RfqService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly approvals: ApprovalEngineService,
    private readonly purchaseOrders: PurchaseOrderService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.approvals.registerRequestType(RFQ_AWARD_REQUEST_TYPE, 'action.award_rfq');
    this.events.subscribe('approval.request.approved', async (payload) => {
      if (String(payload.requestTypeCode ?? '') !== RFQ_AWARD_REQUEST_TYPE) return; // not ours
      await this.onAwardApproved((payload.payload ?? {}) as unknown as RfqAwardPayload);
    });
  }

  private async onAwardApproved(p: RfqAwardPayload): Promise<void> {
    const rfq = await this.dataSource.getRepository(Rfq).findOne({ where: { id: p.rfqId } });
    if (!rfq) return; // defensive — the RFQ this approval referenced no longer exists
    const state = await this.processEngine.getState(RFQ_PROCESS, RFQ_ENTITY_TYPE, rfq.id);
    if (state !== 'sent') return; // already awarded/cancelled — idempotent no-op, never a duplicate PO

    const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
    await this.dataSource.transaction(async (manager) => {
      await this.purchaseOrders.create(
        {
          supplierId: p.supplierId,
          warehouseId: p.warehouseId,
          notes: `Awarded from RFQ ${rfq.rfqNumber}`,
          sourceRfqId: rfq.id,
          lines: p.lines,
        },
        SYSTEM_ACTOR,
        manager,
      );
      await this.processEngine.transition(RFQ_PROCESS, RFQ_ENTITY_TYPE, rfq.id, 'award', SYSTEM_ACTOR, manager);
    });
  }

  async list(): Promise<Array<Rfq & { state: string }>> {
    const rows = await this.dataSource.getRepository(Rfq).find({ order: { createdAt: 'DESC' } });
    const states = await Promise.all(rows.map((r) => this.processEngine.getState(RFQ_PROCESS, RFQ_ENTITY_TYPE, r.id)));
    return rows.map((r, i) => ({ ...r, state: states[i] }));
  }

  async getById(id: string): Promise<{ rfq: Rfq; state: string; invitedSupplierIds: string[]; quotations: SupplierQuotation[]; purchaseRequestLines: PurchaseRequestLine[] }> {
    const rfq = await this.dataSource.getRepository(Rfq).findOne({ where: { id } });
    if (!rfq) throw new NotFoundException(`RFQ "${id}" not found.`);
    const [invites, quotations, state, purchaseRequestLines] = await Promise.all([
      this.dataSource.getRepository(RfqSupplierInvite).find({ where: { rfqId: id } }),
      this.dataSource.getRepository(SupplierQuotation).find({ where: { rfqId: id }, order: { totalAmount: 'ASC' } }),
      this.processEngine.getState(RFQ_PROCESS, RFQ_ENTITY_TYPE, id),
      this.dataSource.getRepository(PurchaseRequestLine).find({ where: { purchaseRequestId: rfq.purchaseRequestId } }),
    ]);
    return { rfq, state, invitedSupplierIds: invites.map((i) => i.supplierId), quotations, purchaseRequestLines };
  }

  async getQuotationLines(quotationId: string): Promise<SupplierQuotationLine[]> {
    return this.dataSource.getRepository(SupplierQuotationLine).find({ where: { supplierQuotationId: quotationId } });
  }

  async send(id: string, actorUserId: string): Promise<{ state: string }> {
    const instance = await this.processEngine.transition(RFQ_PROCESS, RFQ_ENTITY_TYPE, id, 'send', actorUserId);
    await this.audit.record({ actorUserId, organizationId: null, action: 'rfq.sent', resource: 'rfq', resourceId: id, result: 'success', correlationId: id, after: { state: instance.currentState } });
    return { state: instance.currentState };
  }

  async cancel(id: string, actorUserId: string): Promise<{ state: string }> {
    const instance = await this.processEngine.transition(RFQ_PROCESS, RFQ_ENTITY_TYPE, id, 'cancel', actorUserId);
    await this.audit.record({ actorUserId, organizationId: null, action: 'rfq.cancelled', resource: 'rfq', resourceId: id, result: 'success', correlationId: id, after: { state: instance.currentState } });
    return { state: instance.currentState };
  }

  async recordQuotation(input: RecordQuotationInput, actorUserId: string): Promise<SupplierQuotation> {
    if (input.lines.length === 0) throw new BadRequestException('A quotation needs at least one line.');
    const rfq = await this.dataSource.getRepository(Rfq).findOne({ where: { id: input.rfqId } });
    if (!rfq) throw new NotFoundException(`RFQ "${input.rfqId}" not found.`);
    const state = await this.processEngine.getState(RFQ_PROCESS, RFQ_ENTITY_TYPE, rfq.id);
    if (state !== 'sent') throw new ConflictException(`RFQ is "${state}" — a quotation can only be recorded while it is "sent".`);

    const invited = await this.dataSource.getRepository(RfqSupplierInvite).findOne({ where: { rfqId: rfq.id, supplierId: input.supplierId } });
    if (!invited) throw new BadRequestException('This supplier was not invited to this RFQ.');

    const prLines = await this.dataSource.getRepository(PurchaseRequestLine).find({ where: { purchaseRequestId: rfq.purchaseRequestId } });
    const prLineById = new Map(prLines.map((l) => [l.id, l]));

    let totalAmount = 0;
    const lineEntities: Array<Omit<SupplierQuotationLine, 'id' | 'supplierQuotationId'>> = [];
    for (const line of input.lines) {
      const prLine = prLineById.get(line.purchaseRequestLineId);
      if (!prLine) throw new BadRequestException(`Purchase Request line "${line.purchaseRequestLineId}" does not belong to this RFQ's request.`);
      const qty = Number(line.quantity);
      const cost = Number(line.unitCostBase);
      if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('Every line quantity must be a positive number.');
      if (!Number.isFinite(cost) || cost < 0) throw new BadRequestException('Every line unit cost must be a non-negative number.');
      const lineTotal = qty * cost;
      totalAmount += lineTotal;
      lineEntities.push({
        purchaseRequestLineId: prLine.id,
        productId: prLine.productId,
        quantity: line.quantity,
        unitCostBase: line.unitCostBase,
        lineTotalBase: lineTotal.toFixed(2),
      } as Omit<SupplierQuotationLine, 'id' | 'supplierQuotationId'>);
    }

    await this.numbering.registerDocumentType(QUOTATION_DOCUMENT_TYPE, 'SQ');

    return this.dataSource.transaction(async (manager) => {
      const quotationNumber = await this.numbering.getNextNumber(QUOTATION_DOCUMENT_TYPE, manager);
      const qRepo = manager.getRepository(SupplierQuotation);
      const qLineRepo = manager.getRepository(SupplierQuotationLine);

      const saved = await qRepo.save(
        qRepo.create({
          quotationNumber,
          rfqId: rfq.id,
          supplierId: input.supplierId,
          totalAmount: totalAmount.toFixed(2),
          notes: input.notes ?? null,
          recordedByUserId: actorUserId,
        }),
      );
      await qLineRepo.save(lineEntities.map((l) => qLineRepo.create({ ...l, supplierQuotationId: saved.id })));

      await this.audit.record(
        { actorUserId, organizationId: null, action: 'supplier_quotation.recorded', resource: 'supplier_quotation', resourceId: saved.id, result: 'success', correlationId: saved.id, after: { rfqId: rfq.id, supplierId: input.supplierId, totalAmount: saved.totalAmount } },
        manager,
      );
      return saved;
    });
  }

  /** The Evaluation/Approval step (CTO directive §9). Submits to the generic Approval Engine — never awards straight-through. */
  async awardToSupplier(rfqId: string, quotationId: string, actorUserId: string): Promise<{ approvalRequestId: string }> {
    const rfq = await this.dataSource.getRepository(Rfq).findOne({ where: { id: rfqId } });
    if (!rfq) throw new NotFoundException(`RFQ "${rfqId}" not found.`);
    const state = await this.processEngine.getState(RFQ_PROCESS, RFQ_ENTITY_TYPE, rfq.id);
    if (state !== 'sent') throw new ConflictException(`RFQ is "${state}" — it can only be awarded while "sent".`);

    const quotation = await this.dataSource.getRepository(SupplierQuotation).findOne({ where: { id: quotationId, rfqId: rfq.id } });
    if (!quotation) throw new NotFoundException(`Quotation "${quotationId}" does not belong to RFQ "${rfqId}".`);

    const pr = await this.dataSource.getRepository(PurchaseRequest).findOne({ where: { id: rfq.purchaseRequestId } });
    if (!pr) throw new NotFoundException(`Purchase Request "${rfq.purchaseRequestId}" not found.`);

    const lines = await this.dataSource.getRepository(SupplierQuotationLine).find({ where: { supplierQuotationId: quotation.id } });

    const payload: RfqAwardPayload = {
      rfqId: rfq.id,
      quotationId: quotation.id,
      warehouseId: pr.warehouseId,
      supplierId: quotation.supplierId,
      lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCostBase: l.unitCostBase })),
    };

    const request = await this.approvals.submit({
      requestTypeCode: RFQ_AWARD_REQUEST_TYPE,
      resourceType: 'rfq',
      resourceId: rfq.id,
      requestedAction: 'award',
      payload: payload as unknown as Record<string, unknown>,
      makerUserId: actorUserId,
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'rfq.award_submitted',
      resource: 'rfq',
      resourceId: rfq.id,
      result: 'success',
      correlationId: request.id,
      after: { quotationId, supplierId: quotation.supplierId, totalAmount: quotation.totalAmount },
    });

    return { approvalRequestId: request.id };
  }
}
