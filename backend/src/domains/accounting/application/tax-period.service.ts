import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TaxPeriod } from '../infrastructure/tax-period.entity';
import { AuditService } from '../../../foundation/audit/audit.service';

export interface CreateTaxPeriodInput {
  code: string;
  startDate: string;
  endDate: string;
  jurisdictionCode?: string | null;
}

/**
 * F10-H5 (ADR-043 D8). Reporting-only — see `TaxPeriod`'s own doc comment.
 * No posting-control interaction of any kind; no dependency on
 * `JournalEntryService`/the Posting Gate.
 */
@Injectable()
export class TaxPeriodService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async createTaxPeriod(input: CreateTaxPeriodInput, actorUserId: string): Promise<TaxPeriod> {
    if (input.endDate < input.startDate) {
      throw new BadRequestException('Tax period endDate must be on or after startDate.');
    }
    const repo = this.dataSource.getRepository(TaxPeriod);
    const saved = await repo.save(
      repo.create({
        code: input.code,
        startDate: input.startDate,
        endDate: input.endDate,
        jurisdictionCode: input.jurisdictionCode ?? null,
      }),
    );
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.tax_period.created',
      resource: 'tax_period',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { code: saved.code, startDate: saved.startDate, endDate: saved.endDate },
    });
    return saved;
  }

  async listTaxPeriods(): Promise<TaxPeriod[]> {
    return this.dataSource.getRepository(TaxPeriod).find({ order: { startDate: 'ASC' } });
  }
}
