import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ProductItemRequest } from '../infrastructure/product-item-request.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { SALES_PRODUCTS_CONTRACT, SalesProductsContract } from '../../../foundation/module-registry/contracts/sales.contract';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
export const NEW_ITEM_REQUEST_TYPE = 'procurement.new_item_request';
export const ITEM_REQUEST_DOCUMENT_TYPE = 'new_item_request';
const ITEM_REQUEST_PREFIX = 'NEW';
/** The approver must hold the catalog-edit node — the same authority that activates a product from the Products screen. */
export const NEW_ITEM_APPROVER_NODE = 'sales.catalog.edit';

export interface CreateNewItemRequestInput {
  name: string;
  unit?: string | null;
  reason: string;
}

export interface NewItemRequestView extends ProductItemRequest {
  sku: string | null;
  name: string | null;
  productStatus: string | null;
}

/**
 * D7 (2026-10-05, CTO decision) — New Item Request. The requested item is a `draft` Product (id stable through the whole chain, so
 * `productId` stays NOT NULL on PR/RFQ/PO/GR lines and nothing is ever relinked); this service adds the request record and routes
 * the activation through the Approval Engine: ONE approver holding `sales.catalog.edit`, maker ≠ checker (engine-enforced). On
 * approval the product becomes `active` (draft → active through the Sales contract, never a raw table write); on rejection it stays
 * `draft` and the procurement gate (`ProductLifecycleGate`) keeps blocking every document that references it.
 */
@Injectable()
export class NewItemRequestService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalEngineService,
    private readonly events: EventBusService,
    private readonly numbering: NumberingService,
    @Inject(SALES_PRODUCTS_CONTRACT) private readonly products: SalesProductsContract,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async onModuleInit(): Promise<void> {
    await this.approvals.registerRequestType(NEW_ITEM_REQUEST_TYPE, 'action.new_item_request');
    await this.approvals
      .upsertMatrixRule(
        { requestTypeCode: NEW_ITEM_REQUEST_TYPE, minApprovers: 1, requiredPermissionNode: NEW_ITEM_APPROVER_NODE, valueThreshold: null, orgUnitId: null },
        SYSTEM_ACTOR,
      )
      .catch(() => undefined); // idempotent-ish; a concurrent init is harmless
    this.events.subscribe(
      'approval.request.approved',
      async (payload, ctx) => {
        if (String(payload.requestTypeCode ?? '') !== NEW_ITEM_REQUEST_TYPE) return; // not ours
        await this.onApproved(String(payload.approvalRequestId), String(payload.resourceId), ctx.manager ?? undefined);
      },
      { scope: 'company' },
    );
    this.events.subscribe(
      'approval.request.rejected',
      async (payload, ctx) => {
        if (String(payload.requestTypeCode ?? '') !== NEW_ITEM_REQUEST_TYPE) return;
        await this.onRejected(String(payload.approvalRequestId), String(payload.resourceId), ctx.manager ?? undefined);
      },
      { scope: 'company' },
    );
  }

  private async decider(approvalRequestId: string, manager?: EntityManager): Promise<string | null> {
    const view = await this.approvals.getRequest(approvalRequestId, manager);
    const last = [...view.decisions].reverse()[0];
    return last?.approverUserId ?? null;
  }

  private async onApproved(approvalRequestId: string, productId: string, manager?: EntityManager): Promise<void> {
    const repo = this.em(manager).getRepository(ProductItemRequest);
    const request = await repo.findOne({ where: { productId } });
    if (!request || request.status !== 'pending') return; // unknown / already decided — idempotent no-op
    const decidedBy = await this.decider(approvalRequestId, manager);
    await this.em(manager).transaction(async (tx) => {
      const snapshot = await this.products.getProductSnapshot(productId, tx);
      if (snapshot?.status === 'draft') await this.products.activateDraftProduct(productId, decidedBy ?? SYSTEM_ACTOR, tx);
      await tx.getRepository(ProductItemRequest).update({ id: request.id }, { status: 'approved', decidedByUserId: decidedBy, decidedAt: new Date() });
      await this.audit.record(
        { actorUserId: decidedBy ?? SYSTEM_ACTOR, organizationId: null, action: 'procurement.new_item_request.approved', resource: 'product_item_request', resourceId: request.id, result: 'success', correlationId: approvalRequestId, after: { productId } },
        tx,
      );
    });
  }

  private async onRejected(approvalRequestId: string, productId: string, manager?: EntityManager): Promise<void> {
    const repo = this.em(manager).getRepository(ProductItemRequest);
    const request = await repo.findOne({ where: { productId } });
    if (!request || request.status !== 'pending') return;
    const decidedBy = await this.decider(approvalRequestId, manager);
    await repo.update({ id: request.id }, { status: 'rejected', decidedByUserId: decidedBy, decidedAt: new Date() });
    await this.audit.record(
      { actorUserId: decidedBy ?? SYSTEM_ACTOR, organizationId: null, action: 'procurement.new_item_request.rejected', resource: 'product_item_request', resourceId: request.id, result: 'success', correlationId: approvalRequestId, after: { productId } },
      manager,
    );
  }

  /** Creates the draft Product + the request record + the approval request, atomically. Nothing is created if any step fails. */
  async create(input: CreateNewItemRequestInput, actorUserId: string, manager?: EntityManager): Promise<{ request: ProductItemRequest; productId: string; sku: string; approvalRequestId: string }> {
    const name = input.name?.trim();
    const reason = input.reason?.trim();
    if (!name) throw new BadRequestException('A new item needs a name.');
    if (!reason) throw new BadRequestException('A new item request needs a reason.');
    await this.numbering.registerDocumentType(ITEM_REQUEST_DOCUMENT_TYPE, ITEM_REQUEST_PREFIX, false, manager);

    return this.em(manager).transaction(async (tx) => {
      const sku = await this.numbering.getNextNumber(ITEM_REQUEST_DOCUMENT_TYPE, tx);
      const product = await this.products.createDraftProduct({ sku, name, unit: input.unit?.trim() || null }, actorUserId, tx);
      const repo = tx.getRepository(ProductItemRequest);
      const saved = await repo.save(repo.create({ productId: product.id, requestedByUserId: actorUserId, reason, status: 'pending' }));
      const approval = await this.approvals.submit(
        {
          requestTypeCode: NEW_ITEM_REQUEST_TYPE,
          resourceType: 'product',
          resourceId: product.id,
          requestedAction: 'activate',
          payload: { itemRequestId: saved.id, productId: product.id, sku, name, reason },
          makerUserId: actorUserId,
        },
        tx,
      );
      await repo.update({ id: saved.id }, { approvalRequestId: approval.id });
      saved.approvalRequestId = approval.id;
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'procurement.new_item_request.created', resource: 'product_item_request', resourceId: saved.id, result: 'success', correlationId: approval.id, after: { productId: product.id, sku, name, reason } },
        tx,
      );
      return { request: saved, productId: product.id, sku, approvalRequestId: approval.id };
    });
  }

  async list(status?: string, manager?: EntityManager): Promise<NewItemRequestView[]> {
    const rows = await this.em(manager).getRepository(ProductItemRequest).find({ where: status ? { status: status as never } : {}, order: { createdAt: 'DESC' } });
    return Promise.all(rows.map((r) => this.toView(r, manager)));
  }

  async getById(id: string, manager?: EntityManager): Promise<NewItemRequestView> {
    const r = await this.em(manager).getRepository(ProductItemRequest).findOne({ where: { id } });
    if (!r) throw new NotFoundException(`Item request "${id}" not found.`);
    return this.toView(r, manager);
  }

  private async toView(r: ProductItemRequest, manager?: EntityManager): Promise<NewItemRequestView> {
    const p = await this.products.getProductSnapshot(r.productId, manager);
    return Object.assign(r, { sku: p?.sku ?? null, name: p?.name ?? null, productStatus: p?.status ?? null });
  }
}
