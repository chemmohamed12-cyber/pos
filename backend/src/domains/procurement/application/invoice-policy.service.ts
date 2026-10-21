import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ProcurementInvoicePolicy } from '../infrastructure/procurement-invoice-policy.entity';
import { AuditService } from '../../../foundation/audit/audit.service';

export interface InvoicePolicyView {
  approvalRequired: boolean;
  priceTolerancePct: number;
  priceToleranceAmount: number | null;
  toleranceDirection: 'both' | 'over_only';
}

export interface InvoicePolicyInput {
  approvalRequired?: boolean;
  priceTolerancePct?: number;
  /** null clears the amount limit */
  priceToleranceAmount?: number | null;
  toleranceDirection?: 'both' | 'over_only';
}

/** The legacy behaviour (no row): direct posting, informational price variance. */
export const LEGACY_INVOICE_POLICY: InvoicePolicyView = { approvalRequired: false, priceTolerancePct: 0, priceToleranceAmount: null, toleranceDirection: 'both' };

/**
 * Phase C-1 (D2 / D5) - the Company's supplier-invoice matching policy. One row per Company database; every read and write runs on the caller's Company manager, so a policy can never leak between Companies.
 */
@Injectable()
export class InvoicePolicyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit?: AuditService,
  ) {}

  async get(manager?: EntityManager): Promise<InvoicePolicyView> {
    const row = await (manager ?? this.dataSource).getRepository(ProcurementInvoicePolicy).findOne({ where: { singleton: true } });
    if (!row) return { ...LEGACY_INVOICE_POLICY };
    return {
      approvalRequired: row.approvalRequired,
      priceTolerancePct: Number(row.priceTolerancePct),
      priceToleranceAmount: row.priceToleranceAmount == null ? null : Number(row.priceToleranceAmount),
      toleranceDirection: row.toleranceDirection,
    };
  }

  async update(input: InvoicePolicyInput, actorUserId: string, manager?: EntityManager): Promise<InvoicePolicyView> {
    if (input.priceTolerancePct !== undefined && (!Number.isFinite(input.priceTolerancePct) || input.priceTolerancePct < 0 || input.priceTolerancePct > 100)) {
      throw new BadRequestException('The price tolerance percentage must be between 0 and 100.');
    }
    if (input.priceToleranceAmount != null && (!Number.isFinite(input.priceToleranceAmount) || input.priceToleranceAmount < 0)) {
      throw new BadRequestException('The price tolerance amount must be zero or more.');
    }
    if (input.toleranceDirection !== undefined && input.toleranceDirection !== 'both' && input.toleranceDirection !== 'over_only') {
      throw new BadRequestException('The tolerance direction must be "both" or "over_only".');
    }
    const run = async (m: EntityManager) => {
      const repo = m.getRepository(ProcurementInvoicePolicy);
      const before = await this.get(m);
      let row = await repo.findOne({ where: { singleton: true } });
      if (!row) row = repo.create({ singleton: true, approvalRequired: false, priceTolerancePct: '0', priceToleranceAmount: null, toleranceDirection: 'both' });
      if (input.approvalRequired !== undefined) row.approvalRequired = input.approvalRequired;
      if (input.priceTolerancePct !== undefined) row.priceTolerancePct = String(input.priceTolerancePct);
      if (input.priceToleranceAmount !== undefined) row.priceToleranceAmount = input.priceToleranceAmount == null ? null : input.priceToleranceAmount.toFixed(2);
      if (input.toleranceDirection !== undefined) row.toleranceDirection = input.toleranceDirection;
      row.updatedByUserId = actorUserId;
      row.updatedAt = new Date();
      await repo.save(row);
      const after = await this.get(m);
      await this.audit?.record(
        { actorUserId, organizationId: null, action: 'procurement.invoice_policy.updated', resource: 'procurement_invoice_policy', resourceId: row.id, result: 'success', correlationId: null, before: { ...before }, after: { ...after } },
        m,
      );
      return after;
    };
    return (manager ?? this.dataSource).transaction(run);
  }
}
