import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Rfq } from '../infrastructure/rfq.entity';
import { RfqSupplierInvite } from '../infrastructure/rfq-supplier-invite.entity';
import { SupplierQuotation } from '../infrastructure/supplier-quotation.entity';
import { SupplierQuotationLine } from '../infrastructure/supplier-quotation-line.entity';
import { PurchaseRequest } from '../infrastructure/purchase-request.entity';
import { PurchaseRequestLine } from '../infrastructure/purchase-request-line.entity';
import { PurchaseOrder } from '../infrastructure/purchase-order.entity';
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

/** D6 — what the UI needs to show the award's approval status (read-only view of the Approval Engine request). */
export interface RfqAwardApprovalView {
  approvalRequestId: string;
  state: string;
  makerUserId: string;
  submittedAt: Date;
  decidedAt: Date | null;
  /** The permission node a DIFFERENT user must hold (at editable) to approve — the maker-checker rule is unchanged. */
  requiredNode: string;
  minApprovers: number;
  approvedCount: number;
  quotationId: string | null;
  supplierId: string | null;
  totalAmount: string;
  /** Set once the approved award created the Purchase Order. */
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
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

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async onModuleInit(): Promise<void> {
    await this.approvals.registerRequestType(RFQ_AWARD_REQUEST_TYPE, 'action.award_rfq');
    this.events.subscribe(
      'approval.request.approved',
      async (payload, ctx) => {
        if (String(payload.requestTypeCode ?? '') !== RFQ_AWARD_REQUEST_TYPE) return; // not ours
        await this.onAwardApproved((payload.payload ?? {}) as unknown as RfqAwardPayload, ctx.manager ?? undefined);
      },
      { scope: 'company' },
    );
  }

  private async onAwardApproved(p: RfqAwardPayload, manager?: EntityManager): Promise<void> {
    const rfq = await this.em(manager).getRepository(Rfq).findOne({ where: { id: p.rfqId } });
    if (!rfq) return; // defensive — the RFQ this approval referenced no longer exists
    const state = await this.processEngine.getState(RFQ_PROCESS, RFQ_ENTITY_TYPE, rfq.id, manager);
    if (state !== 'sent') return; // already awarded/cancelled — idempotent no-op, never a duplicate PO

    const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
    await this.em(manager).transaction(async (manager) => {
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

  async list(manager?: EntityManager): Promise<Array<Rfq & { state: string }>> {
    const rows = await this.em(manager).getRepository(Rfq).find({ order: { createdAt: 'DESC' } });
    const states = await Promise.all(rows.map((r) => this.processEngine.getState(RFQ_PROCESS, RFQ_ENTITY_TYPE, r.id, manager)));
    return rows.map((r, i) => ({ ...r, state: states[i] }));
  }

  /**
   * D6 (2026-10-05) — the VISIBLE state of an RFQ's award. The award is a maker-checker approval (unchanged): this only reports
   * the latest award request so the UI can show "Pending Approval" with its `approvalRequestId`, who must approve it, and — once
   * approved — the Purchase Order it created. Read-only; `null` when no award was ever submitted for this RFQ.
   */
  async getAwardApproval(rfqId: string, manager?: EntityManager): Promise<RfqAwardApprovalView | null> {
    const requests = await this.approvals.listRequests({ requestTypeCode: RFQ_AWARD_REQUEST_TYPE, resourceType: 'rfq', resourceId: rfqId }, manager);
    if (requests.length === 0) return null;
    const view = await this.approvals.getRequest(requests[0].id, manager); // listRequests is newest-first
    const payload = (view.payload ?? {}) as unknown as RfqAwardPayload;
    const totalAmount = (payload.lines ?? []).reduce((sum, l) => sum + Number(l.quantity) * Number(l.unitCostBase), 0);
    const po = await this.em(manager).getRepository(PurchaseOrder).findOne({ where: { sourceRfqId: rfqId } });
    return {
      approvalRequestId: view.id,
      state: view.state,
      makerUserId: view.makerUserId,
      submittedAt: view.createdAt,
      decidedAt: view.decidedAt,
      requiredNode: view.resolvedRequiredNode,
      minApprovers: view.resolvedMinApprovers,
      approvedCount: view.decisions.filter((d) => String(d.decision) === 'approved').length,
      quotationId: payload.quotationId ?? null,
      supplierId: payload.supplierId ?? null,
      totalAmount: totalAmount.toFixed(2),
      purchaseOrderId: po?.id ?? null,
      purchaseOrderNumber: po?.poNumber ?? null,
    };
  }

  async getById(id: string, manager?: EntityManager): Promise<{ rfq: Rfq; state: string; invitedSupplierIds: string[]; quotations: SupplierQuotation[]; purchaseRequestLines: PurchaseRequestLine[]; awardApproval: RfqAwardApprovalView | null; warehouseId: string | null }> {
    const rfq = await this.em(manager).getRepository(Rfq).findOne({ where: { id } });
    if (!rfq) throw new NotFoundException(`RFQ "${id}" not found.`);
    const [invites, quotations, state, purchaseRequestLines] = await Promise.all([
      this.em(manager).getRepository(RfqSupplierInvite).find({ where: { rfqId: id } }),
      this.em(manager).getRepository(SupplierQuotation).find({ where: { rfqId: id }, order: { totalAmount: 'ASC' } }),
      this.processEngine.getState(RFQ_PROCESS, RFQ_ENTITY_TYPE, id, manager),
      this.em(manager).getRepository(PurchaseRequestLine).find({ where: { purchaseRequestId: rfq.purchaseRequestId } }),
    ]);
    // PRC-01 — the originating request's warehouse, so the screen can show the official stock figures for the quoted items
    const pr = await this.em(manager).getRepository(PurchaseRequest).findOne({ where: { id: rfq.purchaseRequestId } });
    return { rfq, state, invitedSupplierIds: invites.map((i) => i.supplierId), quotations, purchaseRequestLines, awardApproval: await this.getAwardApproval(id, manager), warehouseId: pr?.warehouseId ?? null };
  }

  async getQuotationLines(quotationId: string, manager?: EntityManager): Promise<SupplierQuotationLine[]> {
    return this.em(manager).getRepository(SupplierQuotationLine).find({ where: { supplierQuotationId: quotationId } });
  }

  async send(id: string, actorUserId: string, manager?: EntityManager): Promise<{ state: string }> {
    const instance = await this.processEngine.transition(RFQ_PROCESS, RFQ_ENTITY_TYPE, id, 'send', actorUserId, manager);
    await this.audit.record({ actorUserId, organizationId: null, action: 'rfq.sent', resource: 'rfq', resourceId: id, result: 'success', correlationId: id, after: { state: instance.currentState } }, manager);
    return { state: instance.currentState };
  }

  async cancel(id: string, actorUserId: string, manager?: EntityManager): Promise<{ state: string }> {
    const instance = await this.processEngine.transition(RFQ_PROCESS, RFQ_ENTITY_TYPE, id, 'cancel', actorUserId, manager);
    await this.audit.record({ actorUserId, organizationId: null, action: 'rfq.cancelled', resource: 'rfq', resourceId: id, result: 'success', correlationId: id, after: { state: instance.currentState } }, manager);
    return { state: instance.currentState };
  }

  async recordQuotation(input: RecordQuotationInput, actorUserId: string, manager?: EntityManager): Promise<SupplierQuotation> {
    if (input.lines.length === 0) throw new BadRequestException('A quotation needs at least one line.');
    const rfq = await this.em(manager).getRepository(Rfq).findOne({ where: { id: input.rfqId } });
    if (!rfq) throw new NotFoundException(`RFQ "${input.rfqId}" not found.`);
    const state = await this.processEngine.getState(RFQ_PROCESS, RFQ_ENTITY_TYPE, rfq.id, manager);
    if (state !== 'sent') throw new ConflictException(`RFQ is "${state}" — a quotation can only be recorded while it is "sent".`);

    const invited = await this.em(manager).getRepository(RfqSupplierInvite).findOne({ where: { rfqId: rfq.id, supplierId: input.supplierId } });
    if (!invited) throw new BadRequestException('This supplier was not invited to this RFQ.');

    const prLines = await this.em(manager).getRepository(PurchaseRequestLine).find({ where: { purchaseRequestId: rfq.purchaseRequestId } });
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

    await this.numbering.registerDocumentType(QUOTATION_DOCUMENT_TYPE, 'SQ', undefined, manager);

    return this.em(manager).transaction(async (manager) => {
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
  async awardToSupplier(rfqId: string, quotationId: string, actorUserId: string, manager?: EntityManager): Promise<{ approvalRequestId: string }> {
    const rfq = await this.em(manager).getRepository(Rfq).findOne({ where: { id: rfqId } });
    if (!rfq) throw new NotFoundException(`RFQ "${rfqId}" not found.`);
    const state = await this.processEngine.getState(RFQ_PROCESS, RFQ_ENTITY_TYPE, rfq.id, manager);
    if (state !== 'sent') throw new ConflictException(`RFQ is "${state}" — it can only be awarded while "sent".`);

    const quotation = await this.em(manager).getRepository(SupplierQuotation).findOne({ where: { id: quotationId, rfqId: rfq.id } });
    if (!quotation) throw new NotFoundException(`Quotation "${quotationId}" does not belong to RFQ "${rfqId}".`);

    // D6 — one live award request per RFQ: a second submission while the first is still undecided is rejected (and points at it)
    // instead of silently stacking another approval. A decided one (rejected / withdrawn / expired) can be re-awarded.
    const current = await this.getAwardApproval(rfq.id, manager);
    if (current && (current.state === 'pending' || current.state === 'escalated')) {
      throw new ConflictException(`This RFQ already has an award waiting for approval (request ${current.approvalRequestId}, awaiting a different approver holding "${current.requiredNode}").`);
    }

    const pr = await this.em(manager).getRepository(PurchaseRequest).findOne({ where: { id: rfq.purchaseRequestId } });
    if (!pr) throw new NotFoundException(`Purchase Request "${rfq.purchaseRequestId}" not found.`);

    const lines = await this.em(manager).getRepository(SupplierQuotationLine).find({ where: { supplierQuotationId: quotation.id } });

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
    }, manager);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'rfq.award_submitted',
      resource: 'rfq',
      resourceId: rfq.id,
      result: 'success',
      correlationId: request.id,
      after: { quotationId, supplierId: quotation.supplierId, totalAmount: quotation.totalAmount },
    }, manager);

    return { approvalRequestId: request.id };
  }
}
