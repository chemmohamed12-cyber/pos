import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
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
import { ProductLifecycleGate } from './product-lifecycle-gate.service';

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
    private readonly lifecycleGate: ProductLifecycleGate,
  ) {}

  private async statesFor(
    entityType: string,
    definition: typeof PURCHASE_REQUEST_PROCESS,
    ids: string[],
    manager?: EntityManager,
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await (manager ?? this.dataSource)
      .getRepository(ProcessInstance)
      .find({ where: { definitionKey: definition.key, entityType, entityId: In(ids) } });
    return new Map(rows.map((r) => [r.entityId, r.currentState]));
  }

  async list(manager?: EntityManager, visibleWarehouseIds?: string[]): Promise<Array<PurchaseRequest & { state: string }>> {
    const rows = await (manager ?? this.dataSource).getRepository(PurchaseRequest).find({ where: visibleWarehouseIds ? { warehouseId: In(visibleWarehouseIds) } : undefined, order: { createdAt: 'DESC' } });
    const states = await this.statesFor(PR_ENTITY_TYPE, PURCHASE_REQUEST_PROCESS, rows.map((r) => r.id), manager);
    return rows.map((r) => ({ ...r, state: states.get(r.id) ?? 'draft' }));
  }

  async getById(id: string, manager?: EntityManager): Promise<{ purchaseRequest: PurchaseRequest; state: string; lines: PurchaseRequestLine[] }> {
    const purchaseRequest = await (manager ?? this.dataSource).getRepository(PurchaseRequest).findOne({ where: { id } });
    if (!purchaseRequest) throw new NotFoundException(`Purchase Request "${id}" not found.`);
    const lines = await (manager ?? this.dataSource).getRepository(PurchaseRequestLine).find({ where: { purchaseRequestId: id } });
    const state = await this.processEngine.getState(PURCHASE_REQUEST_PROCESS, PR_ENTITY_TYPE, id, manager);
    return { purchaseRequest, state, lines };
  }

  async create(input: CreatePurchaseRequestInput, actorUserId: string, manager?: EntityManager): Promise<PurchaseRequest> {
    if (input.lines.length === 0) throw new BadRequestException('A Purchase Request needs at least one line.');
    for (const l of input.lines) {
      if (!Number.isFinite(Number(l.quantity)) || Number(l.quantity) <= 0) {
        throw new BadRequestException('Every line quantity must be a positive number.');
      }
    }

    await this.numbering.registerDocumentType(PR_DOCUMENT_TYPE, 'PR', true, manager);

    return (manager ?? this.dataSource).transaction(async (txManager) => {
      const prNumber = await this.numbering.getNextNumber(PR_DOCUMENT_TYPE, txManager);
      const prRepo = txManager.getRepository(PurchaseRequest);
      const lineRepo = txManager.getRepository(PurchaseRequestLine);

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
      await this.processEngine.start(PURCHASE_REQUEST_PROCESS, PR_ENTITY_TYPE, saved.id, txManager);

      await this.audit.record(
        { actorUserId, organizationId: null, action: 'purchase_request.created', resource: 'purchase_request', resourceId: saved.id, result: 'success', correlationId: saved.id, after: { prNumber } },
        txManager,
      );
      return saved;
    });
  }

  async transition(
    id: string,
    action: 'submit' | 'approve' | 'reject' | 'cancel',
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ state: string }> {
    const exists = await (manager ?? this.dataSource).getRepository(PurchaseRequest).findOne({ where: { id } });
    if (!exists) throw new NotFoundException(`Purchase Request "${id}" not found.`);
    if (action === 'approve') {
      // ESC-3 (CTO, 2026-10-06, Option B) — maker != checker: the requester may not approve their own Purchase Request. The approver must be another
      // user who already holds the existing approve permission (the permission model itself is unchanged). Checked BEFORE any state change.
      if (exists.requestedByUserId === actorUserId) {
        await this.audit.record(
          { actorUserId, organizationId: null, action: 'purchase_request.approve', resource: 'purchase_request', resourceId: id, result: 'failure', correlationId: id, after: { reason: 'maker_cannot_approve_own_request' } },
          manager,
        );
        throw new ForbiddenException('Maker/checker: the user who created this Purchase Request cannot approve it. Another authorized user must approve it.');
      }
      // D7 — the lifecycle gate: an approved PR never points at an unapproved (draft) or discontinued item. Checked BEFORE the transition.
      const lines = await (manager ?? this.dataSource).getRepository(PurchaseRequestLine).find({ where: { purchaseRequestId: id } });
      await this.lifecycleGate.assertAllActive(lines.map((l) => l.productId), 'Cannot approve this Purchase Request', manager);
    }
    const instance = await this.processEngine.transition(PURCHASE_REQUEST_PROCESS, PR_ENTITY_TYPE, id, action, actorUserId, manager);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: `purchase_request.${action}`,
        resource: 'purchase_request',
        resourceId: id,
        result: 'success',
        correlationId: id,
        after: { state: instance.currentState },
      },
      manager,
    );
    return { state: instance.currentState };
  }

  /** The PR → RFQ handoff (Path B directive §9). Copies every PR line onto the new RFQ 1:1 (id-linked, never re-typed) and invites the given suppliers. */
  async createRfqFromRequest(
    purchaseRequestId: string,
    supplierIds: string[],
    notes: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<Rfq> {
    if (supplierIds.length === 0) throw new BadRequestException('An RFQ needs at least one invited supplier.');
    const pr = await (manager ?? this.dataSource).getRepository(PurchaseRequest).findOne({ where: { id: purchaseRequestId } });
    if (!pr) throw new NotFoundException(`Purchase Request "${purchaseRequestId}" not found.`);
    const state = await this.processEngine.getState(PURCHASE_REQUEST_PROCESS, PR_ENTITY_TYPE, pr.id, manager);
    if (state !== 'approved') throw new ConflictException(`Purchase Request is "${state}" — an RFQ can only be raised from an "approved" request.`);

    const prLines = await (manager ?? this.dataSource).getRepository(PurchaseRequestLine).find({ where: { purchaseRequestId: pr.id } });
    if (prLines.length === 0) throw new ConflictException('This Purchase Request has no lines.');
    await this.lifecycleGate.assertAllActive(prLines.map((l) => l.productId), 'Cannot raise an RFQ from this Purchase Request', manager); // D7 gate

    await this.numbering.registerDocumentType(RFQ_DOCUMENT_TYPE, 'RFQ', true, manager);

    const rfq = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const rfqNumber = await this.numbering.getNextNumber(RFQ_DOCUMENT_TYPE, txManager);
      const rfqRepo = txManager.getRepository(Rfq);
      const inviteRepo = txManager.getRepository(RfqSupplierInvite);

      const savedRfq = await rfqRepo.save(rfqRepo.create({ rfqNumber, purchaseRequestId: pr.id, notes, createdByUserId: actorUserId }));
      await inviteRepo.save(supplierIds.map((supplierId) => inviteRepo.create({ rfqId: savedRfq.id, supplierId })));
      await this.processEngine.start(RFQ_PROCESS, RFQ_ENTITY_TYPE, savedRfq.id, txManager);
      await this.processEngine.transition(PURCHASE_REQUEST_PROCESS, PR_ENTITY_TYPE, pr.id, 'convert_to_rfq', actorUserId, txManager);

      await this.audit.record(
        { actorUserId, organizationId: null, action: 'rfq.created', resource: 'rfq', resourceId: savedRfq.id, result: 'success', correlationId: savedRfq.id, after: { rfqNumber, purchaseRequestId: pr.id, supplierIds } },
        txManager,
      );
      return savedRfq;
    });

    return rfq;
  }
}
