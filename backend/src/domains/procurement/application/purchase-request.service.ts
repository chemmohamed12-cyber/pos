import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { PurchaseRequest } from '../infrastructure/purchase-request.entity';
import { PurchaseRequestLine } from '../infrastructure/purchase-request-line.entity';
import { Rfq } from '../infrastructure/rfq.entity';
import { RfqSupplierInvite } from '../infrastructure/rfq-supplier-invite.entity';
import { PURCHASE_REQUEST_PROCESS } from '../domain/purchase-request-process';
import { RFQ_PROCESS } from '../domain/rfq-process';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ProcessInstance } from '../../../foundation/process-engine/process-instance.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';

const PR_ENTITY_TYPE = 'purchase_request';
const PR_DOCUMENT_TYPE = 'purchase_request';
const RFQ_ENTITY_TYPE = 'rfq';
const RFQ_DOCUMENT_TYPE = 'rfq';

export interface CreatePurchaseRequestLineInput {
  productId: string;
  quantity: string;
  neededByDate?: string | null;
}
export interface CreatePurchaseRequestInput {
  warehouseId: string;
  notes?: string | null;
  lines: CreatePurchaseRequestLineInput[];
}

/**
 * ADR-048 — Path B (Controlled Procurement Cycle), first step: Purchase
 * Request. No cost on a PR line by design — cost is what the RFQ/
 * Quotation stage solicits from suppliers; a PR only states the internal
 * need (what, how much, by when).
 */
@Injectable()
export class PurchaseRequestService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  private async statesFor(entityType: string, definition: typeof PURCHASE_REQUEST_PROCESS, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.dataSource
      .getRepository(ProcessInstance)
      .find({ where: { definitionKey: definition.key, entityType, entityId: In(ids) } });
    return new Map(rows.map((r) => [r.entityId, r.currentState]));
  }

  async list(): Promise<Array<PurchaseRequest & { state: string }>> {
    const rows = await this.dataSource.getRepository(PurchaseRequest).find({ order: { createdAt: 'DESC' } });
    const states = await this.statesFor(PR_ENTITY_TYPE, PURCHASE_REQUEST_PROCESS, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, state: states.get(r.id) ?? 'draft' }));
  }

  async getById(id: string): Promise<{ purchaseRequest: PurchaseRequest; state: string; lines: PurchaseRequestLine[] }> {
    const purchaseRequest = await this.dataSource.getRepository(PurchaseRequest).findOne({ where: { id } });
    if (!purchaseRequest) throw new NotFoundException(`Purchase Request "${id}" not found.`);
    const lines = await this.dataSource.getRepository(PurchaseRequestLine).find({ where: { purchaseRequestId: id } });
    const state = await this.processEngine.getState(PURCHASE_REQUEST_PROCESS, PR_ENTITY_TYPE, id);
    return { purchaseRequest, state, lines };
  }

  async create(input: CreatePurchaseRequestInput, actorUserId: string): Promise<PurchaseRequest> {
    if (input.lines.length === 0) throw new BadRequestException('A Purchase Request needs at least one line.');
    for (const l of input.lines) {
      if (!Number.isFinite(Number(l.quantity)) || Number(l.quantity) <= 0) {
        throw new BadRequestException('Every line quantity must be a positive number.');
      }
    }

    await this.numbering.registerDocumentType(PR_DOCUMENT_TYPE, 'PR');

    return this.dataSource.transaction(async (manager) => {
      const prNumber = await this.numbering.getNextNumber(PR_DOCUMENT_TYPE, manager);
      const prRepo = manager.getRepository(PurchaseRequest);
      const lineRepo = manager.getRepository(PurchaseRequestLine);

      const saved = await prRepo.save(
        prRepo.create({
          prNumber,
          warehouseId: input.warehouseId,
          notes: input.notes ?? null,
          requestedByUserId: actorUserId,
        }),
      );
      await lineRepo.save(
        input.lines.map((l) => lineRepo.create({ purchaseRequestId: saved.id, productId: l.productId, quantity: l.quantity, neededByDate: l.neededByDate ?? null })),
      );
      await this.processEngine.start(PURCHASE_REQUEST_PROCESS, PR_ENTITY_TYPE, saved.id, manager);

      await this.audit.record(
        { actorUserId, organizationId: null, action: 'purchase_request.created', resource: 'purchase_request', resourceId: saved.id, result: 'success', correlationId: saved.id, after: { prNumber } },
        manager,
      );
      return saved;
    });
  }

  async transition(id: string, action: 'submit' | 'approve' | 'reject' | 'cancel', actorUserId: string): Promise<{ state: string }> {
    const exists = await this.dataSource.getRepository(PurchaseRequest).findOne({ where: { id } });
    if (!exists) throw new NotFoundException(`Purchase Request "${id}" not found.`);
    const instance = await this.processEngine.transition(PURCHASE_REQUEST_PROCESS, PR_ENTITY_TYPE, id, action, actorUserId);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: `purchase_request.${action}`,
      resource: 'purchase_request',
      resourceId: id,
      result: 'success',
      correlationId: id,
      after: { state: instance.currentState },
    });
    return { state: instance.currentState };
  }

  /** The PR → RFQ handoff (Path B directive §9). Copies every PR line onto the new RFQ 1:1 (id-linked, never re-typed) and invites the given suppliers. */
  async createRfqFromRequest(purchaseRequestId: string, supplierIds: string[], notes: string | null, actorUserId: string): Promise<Rfq> {
    if (supplierIds.length === 0) throw new BadRequestException('An RFQ needs at least one invited supplier.');
    const pr = await this.dataSource.getRepository(PurchaseRequest).findOne({ where: { id: purchaseRequestId } });
    if (!pr) throw new NotFoundException(`Purchase Request "${purchaseRequestId}" not found.`);
    const state = await this.processEngine.getState(PURCHASE_REQUEST_PROCESS, PR_ENTITY_TYPE, pr.id);
    if (state !== 'approved') throw new ConflictException(`Purchase Request is "${state}" — an RFQ can only be raised from an "approved" request.`);

    const prLines = await this.dataSource.getRepository(PurchaseRequestLine).find({ where: { purchaseRequestId: pr.id } });
    if (prLines.length === 0) throw new ConflictException('This Purchase Request has no lines.');

    await this.numbering.registerDocumentType(RFQ_DOCUMENT_TYPE, 'RFQ');

    const rfq = await this.dataSource.transaction(async (manager) => {
      const rfqNumber = await this.numbering.getNextNumber(RFQ_DOCUMENT_TYPE, manager);
      const rfqRepo = manager.getRepository(Rfq);
      const inviteRepo = manager.getRepository(RfqSupplierInvite);

      const savedRfq = await rfqRepo.save(rfqRepo.create({ rfqNumber, purchaseRequestId: pr.id, notes, createdByUserId: actorUserId }));
      await inviteRepo.save(supplierIds.map((supplierId) => inviteRepo.create({ rfqId: savedRfq.id, supplierId })));
      await this.processEngine.start(RFQ_PROCESS, RFQ_ENTITY_TYPE, savedRfq.id, manager);
      await this.processEngine.transition(PURCHASE_REQUEST_PROCESS, PR_ENTITY_TYPE, pr.id, 'convert_to_rfq', actorUserId, manager);

      await this.audit.record(
        { actorUserId, organizationId: null, action: 'rfq.created', resource: 'rfq', resourceId: savedRfq.id, result: 'success', correlationId: savedRfq.id, after: { rfqNumber, purchaseRequestId: pr.id, supplierIds } },
        manager,
      );
      return savedRfq;
    });

    return rfq;
  }
}
