import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TaxCode, TaxCodeType } from '../infrastructure/tax-code.entity';
import { AuditService } from '../../../foundation/audit/audit.service';

export interface CreateTaxCodeInput {
  code: string;
  name: string;
  rate: string;
  isInclusive?: boolean;
  accountMappingRef?: string | null;
  /** F10 (ADR-043 D2) — additive, all optional, safely defaulted. */
  type?: TaxCodeType;
  jurisdictionCode?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}
export interface UpdateTaxCodeInput {
  name?: string;
  rate?: string;
  isInclusive?: boolean;
  isActive?: boolean;
  accountMappingRef?: string | null;
  type?: TaxCodeType;
  jurisdictionCode?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

/** F01 — Financial Foundation (Blueprint §3.5). Settings scaffold only — the Tax Engine's runtime behavior is F10. */
@Injectable()
export class TaxCodeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async createTaxCode(input: CreateTaxCodeInput, actorUserId: string): Promise<TaxCode> {
    const repo = this.dataSource.getRepository(TaxCode);
    const saved = await repo.save(
      repo.create({
        code: input.code,
        name: input.name,
        rate: input.rate,
        isInclusive: input.isInclusive ?? false,
        isActive: true,
        accountMappingRef: input.accountMappingRef ?? null,
        type: input.type ?? 'standard',
        jurisdictionCode: input.jurisdictionCode ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
      }),
    );
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.tax_code.created',
      resource: 'tax_code',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { code: saved.code, rate: saved.rate },
    });
    return saved;
  }

  async listTaxCodes(): Promise<TaxCode[]> {
    return this.dataSource.getRepository(TaxCode).find({ order: { code: 'ASC' } });
  }

  async updateTaxCode(id: string, input: UpdateTaxCodeInput, actorUserId: string): Promise<TaxCode> {
    const repo = this.dataSource.getRepository(TaxCode);
    const taxCode = await repo.findOne({ where: { id } });
    if (!taxCode) throw new NotFoundException(`Tax code "${id}" not found.`);
    const before = { ...taxCode };
    Object.assign(taxCode, input);
    const saved = await repo.save(taxCode);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.tax_code.updated',
      resource: 'tax_code',
      resourceId: id,
      result: 'success',
      correlationId: null,
      before: { rate: before.rate, isInclusive: before.isInclusive, isActive: before.isActive },
      after: { rate: saved.rate, isInclusive: saved.isInclusive, isActive: saved.isActive },
    });
    return saved;
  }
}
