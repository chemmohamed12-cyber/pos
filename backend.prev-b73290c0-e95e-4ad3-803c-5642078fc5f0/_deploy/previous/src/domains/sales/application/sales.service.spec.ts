import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { SalesService } from './sales.service';
import { SalesRepProfile } from '../infrastructure/sales-rep-profile.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';

describe('SalesService', () => {
  let service: SalesService;
  const profiles = new Map<string, SalesRepProfile>();

  const repoMock = {
    findOne: jest.fn(async ({ where }: { where: { userId: string } }) => profiles.get(where.userId) ?? null),
    create: jest.fn((data: Partial<SalesRepProfile>) => data as SalesRepProfile),
    save: jest.fn(async (p: SalesRepProfile) => {
      profiles.set(p.userId, p);
      return p;
    }),
  };

  const numberingMock = { getNextNumber: jest.fn(async () => 'REP-000001') };
  const authorizationMock = { assignRole: jest.fn(async () => undefined), hasRole: jest.fn(async () => true) };
  const auditMock = { record: jest.fn(async () => undefined) };

  beforeEach(async () => {
    profiles.clear();
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesService,
        { provide: DataSource, useValue: { getRepository: () => repoMock } },
        { provide: NumberingService, useValue: numberingMock },
        { provide: AuthorizationService, useValue: authorizationMock },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();
    service = moduleRef.get(SalesService);
  });

  it('creates a sales rep profile, assigns the role, and issues a sales code', async () => {
    const profile = await service.createSalesRepProfile('user-1', 'Cairo', 'admin-1');
    expect(profile.salesCode).toBe('REP-000001');
    expect(authorizationMock.assignRole).toHaveBeenCalledWith('user-1', 'sales_rep');
  });

  it('rejects creating a second profile for the same user', async () => {
    await service.createSalesRepProfile('user-1', 'Cairo', 'admin-1');
    await expect(service.createSalesRepProfile('user-1', 'Giza', 'admin-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('throws for a user with no sales rep profile', async () => {
    await expect(service.getSalesRepProfile('no-such-user')).rejects.toBeInstanceOf(NotFoundException);
  });
});
