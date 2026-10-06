import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { FinancialDimensionType } from '../infrastructure/financial-dimension-type.entity';
import { FinancialDimensionValue } from '../infrastructure/financial-dimension-value.entity';
import { AuditService } from '../../../foundation/audit/audit.service';

export interface CreateDimensionTypeInput {
  code: string;
  name: string;
}
export interface UpdateDimensionTypeInput {
  name?: string;
  isActive?: boolean;
}
export interface CreateDimensionValueInput {
  code: string;
  name: string;
  orgUnitId?: string | null;
}
export interface UpdateDimensionValueInput {
  name?: string;
  isActive?: boolean;
}

/**
 * F01 — Financial Foundation (Blueprint §3.6). The dimension attachment
 * MECHANISM — vocabulary definition (this file) + attaching values to
 * actual GL postings (`JournalEntryService`/`GLAccountService`, F03).
 *
 * F11 (ADR-044 D8/D11) — added `updateDimensionType`/`deactivateDimensionType`/
 * `updateDimensionValue`/`deactivateDimensionValue`, closing the "create+list
 * only" gap the RBW found. Deactivating never deletes: `assertPostable`'s
 * existing active-value check (unchanged) already rejects an inactive value
 * on any NEW posting; historical `JournalLineDimension` rows referencing a
 * since-deactivated value or type are never touched by anything in this
 * file and remain fully readable via every existing GL/ledger read path —
 * this class has no read method that filters or hides on `isActive`.
 */
@Injectable()
export class FinancialDimensionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async createDimensionType(input: CreateDimensionTypeInput, actorUserId: string, manager?: EntityManager): Promise<FinancialDimensionType> {
    const repo = this.em(manager).getRepository(FinancialDimensionType);
    const saved = await repo.save(repo.create({ code: input.code, name: input.name, isActive: true }));
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.dimension_type.created',
      resource: 'financial_dimension_type',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { code: saved.code },
    }, manager);
    return saved;
  }

  async listDimensionTypes(manager?: EntityManager): Promise<FinancialDimensionType[]> {
    return this.em(manager).getRepository(FinancialDimensionType).find({ order: { code: 'ASC' } });
  }

  /** F11 (ADR-044 D10) — used by `JournalEntryService`'s P&L implicit-policy check to resolve a configured type code to its id. Returns null for an unknown code (the caller treats this as "nothing to enforce", never a crash). */
  async findTypeByCode(code: string, manager?: EntityManager): Promise<FinancialDimensionType | null> {
    if (!code) return null;
    return (manager ?? this.dataSource).getRepository(FinancialDimensionType).findOne({ where: { code } });
  }

  /** F11 (ADR-044 D8/D11). Mirrors `TaxCodeService.updateTaxCode`'s before/after audit shape. */
  async updateDimensionType(id: string, input: UpdateDimensionTypeInput, actorUserId: string, manager?: EntityManager): Promise<FinancialDimensionType> {
    const repo = this.em(manager).getRepository(FinancialDimensionType);
    const type = await repo.findOne({ where: { id } });
    if (!type) throw new NotFoundException(`Financial dimension type "${id}" not found.`);
    const before = { name: type.name, isActive: type.isActive };
    if (input.name !== undefined) type.name = input.name;
    if (input.isActive !== undefined) type.isActive = input.isActive;
    const saved = await repo.save(type);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.dimension_type.updated',
      resource: 'financial_dimension_type',
      resourceId: id,
      result: 'success',
      correlationId: null,
      before,
      after: { name: saved.name, isActive: saved.isActive },
    }, manager);
    return saved;
  }

  /** F11 (ADR-044 D8) — deactivation only, never a delete (platform "correction, not deletion" principle). */
  async deactivateDimensionType(id: string, actorUserId: string, manager?: EntityManager): Promise<FinancialDimensionType> {
    return this.updateDimensionType(id, { isActive: false }, actorUserId, manager);
  }

  async createDimensionValue(dimensionTypeId: string, input: CreateDimensionValueInput, actorUserId: string, manager?: EntityManager): Promise<FinancialDimensionValue> {
    const typeRepo = this.em(manager).getRepository(FinancialDimensionType);
    const type = await typeRepo.findOne({ where: { id: dimensionTypeId } });
    if (!type) throw new NotFoundException(`Financial dimension type "${dimensionTypeId}" not found.`);

    const repo = this.em(manager).getRepository(FinancialDimensionValue);
    const saved = await repo.save(
      repo.create({ dimensionTypeId, code: input.code, name: input.name, orgUnitId: input.orgUnitId ?? null, isActive: true }),
    );
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.dimension_value.created',
      resource: 'financial_dimension_value',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { dimensionTypeId, code: saved.code },
    }, manager);
    return saved;
  }

  async listDimensionValues(dimensionTypeId: string, manager?: EntityManager): Promise<FinancialDimensionValue[]> {
    return this.em(manager).getRepository(FinancialDimensionValue).find({ where: { dimensionTypeId }, order: { code: 'ASC' } });
  }

  /** F11 (ADR-044 D8/D11). Mirrors `TaxCodeService.updateTaxCode`'s before/after audit shape. */
  async updateDimensionValue(id: string, input: UpdateDimensionValueInput, actorUserId: string, manager?: EntityManager): Promise<FinancialDimensionValue> {
    const repo = this.em(manager).getRepository(FinancialDimensionValue);
    const value = await repo.findOne({ where: { id } });
    if (!value) throw new NotFoundException(`Financial dimension value "${id}" not found.`);
    const before = { name: value.name, isActive: value.isActive };
    if (input.name !== undefined) value.name = input.name;
    if (input.isActive !== undefined) value.isActive = input.isActive;
    const saved = await repo.save(value);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.dimension_value.updated',
      resource: 'financial_dimension_value',
      resourceId: id,
      result: 'success',
      correlationId: null,
      before,
      after: { name: saved.name, isActive: saved.isActive },
    }, manager);
    return saved;
  }

  /** F11 (ADR-044 D8) — deactivation only, never a delete. */
  async deactivateDimensionValue(id: string, actorUserId: string, manager?: EntityManager): Promise<FinancialDimensionValue> {
    return this.updateDimensionValue(id, { isActive: false }, actorUserId, manager);
  }
}
