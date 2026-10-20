import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { SupplierInvoice } from '../infrastructure/supplier-invoice.entity';
import { SupplierInvoiceLine } from '../infrastructure/supplier-invoice-line.entity';
import { PurchaseOrderLine } from '../infrastructure/purchase-order-line.entity';
import { SUPPLIER_INVOICE_PROCESS } from '../domain/supplier-invoice-process';
import { InvoicePolicyService, InvoicePolicyView } from './invoice-policy.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';

const ENTITY_TYPE = 'supplier_invoice';
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface MatchLineResult {
  invoiceLineId: string;
  purchaseOrderLineId: string;
  poUnitCost: string;
  invoiceUnitCost: string;
  quantity: string;
  variancePct: number | null;
  varianceAmount: number;
  exceeded: Array<'percentage' | 'amount'>;
}
export interface MatchResult {
  status: 'within_tolerance' | 'exceeds_tolerance';
  lines: MatchLineResult[];
}

/**
 * Phase C-1 (CTO-approved 2026-10-20: D2 tolerances, D5 lifecycle, D1 exception) - Draft -> Submitted -> Approved -> Posted, with On Hold and Rejected.
 *
 * Submit computes the price match from the Company policy: a line exceeds when its price difference breaches the percentage limit OR the amount limit (when both are set both must pass; default = zero
 * tolerance); an exceeding invoice goes On Hold instead of Submitted. Approve needs a different person than the invoice's creator (segregation of duties); an On Hold invoice can only be approved as an
 * exception with a documented reason. Every transition runs inside ONE transaction that re-reads the state under the process-engine row lock, so two simultaneous decisions cannot both win. Nothing here
 * posts a journal or touches stock - posting stays in `SupplierInvoiceService.postInvoice` (approved -> posted), with its exactly-once guarantees.
 */
@Injectable()
export class InvoiceApprovalService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
    private readonly policies: InvoicePolicyService,
  ) {}

  /** Pure: the price match of the stored invoice lines against their order lines under the policy. */
  computeMatch(lines: Array<Pick<SupplierInvoiceLine, 'id' | 'purchaseOrderLineId' | 'quantity' | 'unitCostBase' | 'unitCostVariance'>>, poLines: Map<string, PurchaseOrderLine>, policy: InvoicePolicyView): MatchResult {
    const out: MatchLineResult[] = [];
    for (const l of lines) {
      const po = poLines.get(l.purchaseOrderLineId);
      const poCost = Number(po?.unitCostBase ?? 0);
      const variance = Number(l.unitCostVariance); // signed: invoice price - order price
      const counted = policy.toleranceDirection === 'over_only' ? Math.max(variance, 0) : Math.abs(variance);
      const pct = poCost > 0 ? (counted / poCost) * 100 : counted > 0 ? null : 0;
      const amount = r2(counted * Number(l.quantity));
      const exceeded: Array<'percentage' | 'amount'> = [];
      if (counted > 0) {
        if (pct === null || pct > policy.priceTolerancePct + 1e-9) exceeded.push('percentage');
      }
      if (policy.priceToleranceAmount != null && amount > policy.priceToleranceAmount + 1e-9) exceeded.push('amount');
      out.push({
        invoiceLineId: l.id,
        purchaseOrderLineId: l.purchaseOrderLineId,
        poUnitCost: String(po?.unitCostBase ?? '0'),
        invoiceUnitCost: l.unitCostBase,
        quantity: l.quantity,
        variancePct: pct === null ? null : Math.round(pct * 10000) / 10000,
        varianceAmount: amount,
        exceeded,
      });
    }
    return { status: out.some((x) => x.exceeded.length > 0) ? 'exceeds_tolerance' : 'within_tolerance', lines: out };
  }

  private async load(invoiceId: string, m: EntityManager): Promise<SupplierInvoice> {
    const invoice = await m.getRepository(SupplierInvoice).findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice "${invoiceId}" not found.`);
    return invoice;
  }

  private requireText(value: string | undefined | null, label: string, min = 3): string {
    const v = (value ?? '').trim();
    if (v.length < min) throw new BadRequestException(`${label} is required (at least ${min} characters).`);
    return v.slice(0, 500);
  }

  private async run<T>(manager: EntityManager | undefined, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return manager ? fn(manager) : this.dataSource.transaction(fn);
  }

  /** Draft -> Submitted, or Draft -> On Hold when the price match exceeds the Company's limits. Requires the approval workflow to be on. */
  async submit(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<SupplierInvoice> {
    return this.run(manager, async (m) => {
      const policy = await this.policies.get(m);
      if (!policy.approvalRequired) throw new ConflictException('The supplier invoice approval workflow is not enabled for this Company - post the invoice directly.');
      const invoice = await this.load(invoiceId, m);
      const lines = await m.getRepository(SupplierInvoiceLine).find({ where: { supplierInvoiceId: invoiceId } });
      const poLines = new Map((await m.getRepository(PurchaseOrderLine).find({ where: { id: In(lines.map((l) => l.purchaseOrderLineId)) } })).map((p) => [p.id, p]));
      const match = this.computeMatch(lines, poLines, policy);
      const action = match.status === 'within_tolerance' ? 'submit' : 'submit_hold';
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, action, actorUserId, m); // state is re-checked under the row lock
      invoice.submittedByUserId = actorUserId;
      invoice.submittedAt = new Date();
      invoice.matchStatus = match.status;
      invoice.matchDetail = match.lines;
      invoice.holdReason =
        match.status === 'within_tolerance'
          ? null
          : `Price difference beyond the Company tolerance on ${match.lines.filter((x) => x.exceeded.length > 0).length} line(s) (limit ${policy.priceTolerancePct}%${policy.priceToleranceAmount != null ? ` / ${policy.priceToleranceAmount.toFixed(2)}` : ''}).`;
      invoice.rejectedReason = null;
      const saved = await m.getRepository(SupplierInvoice).save(invoice);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'supplier_invoice.submitted', resource: 'supplier_invoice', resourceId: invoiceId, result: 'success', correlationId: null, after: { matchStatus: match.status, held: action === 'submit_hold' } },
        m,
      );
      return saved;
    });
  }

  /** Submitted -> Approved. The approver must not be the invoice's creator (segregation of duties). */
  async approve(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<SupplierInvoice> {
    return this.run(manager, async (m) => {
      const invoice = await this.load(invoiceId, m);
      this.assertIndependent(invoice, actorUserId);
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'approve', actorUserId, m);
      invoice.approvedByUserId = actorUserId;
      invoice.approvedAt = new Date();
      const saved = await m.getRepository(SupplierInvoice).save(invoice);
      await this.audit.record({ actorUserId, organizationId: null, action: 'supplier_invoice.approved', resource: 'supplier_invoice', resourceId: invoiceId, result: 'success', correlationId: null, after: { matchStatus: invoice.matchStatus } }, m);
      return saved;
    });
  }

  /** On Hold -> Approved as a documented exception (dedicated permission at the controller, a reason here, independent person, audited). */
  async approveException(invoiceId: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<SupplierInvoice> {
    const why = this.requireText(reason, 'The exception reason');
    return this.run(manager, async (m) => {
      const invoice = await this.load(invoiceId, m);
      this.assertIndependent(invoice, actorUserId);
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'approve_exception', actorUserId, m);
      invoice.approvedByUserId = actorUserId;
      invoice.approvedAt = new Date();
      invoice.exceptionReason = why;
      const saved = await m.getRepository(SupplierInvoice).save(invoice);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'supplier_invoice.exception_approved', resource: 'supplier_invoice', resourceId: invoiceId, result: 'success', correlationId: null, after: { reason: why, holdReason: invoice.holdReason, matchDetail: invoice.matchDetail } },
        m,
      );
      return saved;
    });
  }

  /** Submitted / On Hold -> Rejected (with a reason). */
  async reject(invoiceId: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<SupplierInvoice> {
    const why = this.requireText(reason, 'The rejection reason');
    return this.run(manager, async (m) => {
      const invoice = await this.load(invoiceId, m);
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'reject', actorUserId, m);
      invoice.rejectedReason = why;
      const saved = await m.getRepository(SupplierInvoice).save(invoice);
      await this.audit.record({ actorUserId, organizationId: null, action: 'supplier_invoice.rejected', resource: 'supplier_invoice', resourceId: invoiceId, result: 'success', correlationId: null, after: { reason: why } }, m);
      return saved;
    });
  }

  /** Rejected -> Draft, so the maker can correct and submit again. The previous matching result is cleared; the audit log keeps the history. */
  async reopen(invoiceId: string, actorUserId: string, manager?: EntityManager): Promise<SupplierInvoice> {
    return this.run(manager, async (m) => {
      const invoice = await this.load(invoiceId, m);
      await this.processEngine.transition(SUPPLIER_INVOICE_PROCESS, ENTITY_TYPE, invoiceId, 'reopen', actorUserId, m);
      invoice.matchStatus = null;
      invoice.matchDetail = null;
      invoice.holdReason = null;
      invoice.submittedByUserId = null;
      invoice.submittedAt = null;
      const saved = await m.getRepository(SupplierInvoice).save(invoice);
      await this.audit.record({ actorUserId, organizationId: null, action: 'supplier_invoice.reopened', resource: 'supplier_invoice', resourceId: invoiceId, result: 'success', correlationId: null }, m);
      return saved;
    });
  }

  private assertIndependent(invoice: SupplierInvoice, actorUserId: string): void {
    if (invoice.createdByUserId === actorUserId) {
      throw new ConflictException('The person who created the invoice cannot approve it - a different authorised user must approve it. / لا يجوز لمنشئ الفاتورة اعتمادها - يلزم مستخدم آخر مخوّل.');
    }
  }
}
