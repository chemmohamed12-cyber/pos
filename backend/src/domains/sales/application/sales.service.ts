import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { SalesRepProfile } from '../infrastructure/sales-rep-profile.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';

const SALES_REP_ROLE = 'sales_rep';

@Injectable()
export class SalesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async createSalesRepProfile(
    userId: string,
    territory: string | null,
    actorUserId: string | null, manager?: EntityManager): Promise<SalesRepProfile> {
    const repo = this.em(manager).getRepository(SalesRepProfile);
    const existing = await repo.findOne({ where: { userId } });
    if (existing) throw new ConflictException(`User "${userId}" already has a Sales Rep profile.`);

    const salesCode = await this.numbering.getNextNumber('sales_rep', manager);
    await this.authorization.assignRole(userId, SALES_REP_ROLE, manager);
    const profile = await repo.save(repo.create({ userId, salesCode, territory, status: 'active' }));

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'sales.rep.created',
      resource: 'sales_rep_profile',
      resourceId: userId,
      result: 'success',
      correlationId: null,
      after: { salesCode, territory },
    }, manager);

    return profile;
  }

  async getSalesRepProfile(userId: string, manager?: EntityManager): Promise<SalesRepProfile> {
    const profile = await this.em(manager).getRepository(SalesRepProfile).findOne({ where: { userId } });
    if (!profile) throw new NotFoundException(`No Sales Rep profile for user "${userId}".`);
    return profile;
  }

  async isSalesRep(userId: string, manager?: EntityManager): Promise<boolean> {
    return this.authorization.hasRole(userId, SALES_REP_ROLE, manager);
  }
}
