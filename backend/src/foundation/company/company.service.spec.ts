import { Repository } from 'typeorm';
import { CompanyService } from './company.service';
import { Company } from './company.entity';

describe('CompanyService', () => {
  let service: CompanyService;
  const companies = new Map<string, Company>();
  let idSeq = 0;

  const companyRepoMock = {
    create: jest.fn(
      (data: Partial<Company>) =>
        ({ id: `company-${++idSeq}`, createdAt: new Date(), ...data }) as Company,
    ),
    save: jest.fn(async (company: Company) => {
      companies.set(company.id, company);
      return company;
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: string } }) => {
      if (where.id) return companies.get(where.id) ?? null;
      return null;
    }),
    find: jest.fn(async ({ where }: { where?: { installationId?: string } } = {}) =>
      [...companies.values()].filter((c) => !where?.installationId || c.installationId === where.installationId),
    ),
  };

  beforeEach(() => {
    companies.clear();
    idSeq = 0;
    jest.clearAllMocks();
    service = new CompanyService(companyRepoMock as unknown as Repository<Company>);
  });

  it('creates a Company scoped to an Installation', async () => {
    const company = await service.create({ installationId: 'installation', name: 'Acme Egypt', status: 'PROVISIONING' });
    expect(company.id).toBeDefined();
    expect(company.installationId).toBe('installation');
    expect(company.name).toBe('Acme Egypt');
    expect(company.status).toBe('PROVISIONING');
  });

  it('finds a Company by id', async () => {
    const created = await service.create({ installationId: 'installation', name: 'Acme Egypt', status: 'PROVISIONING' });
    const found = await service.findById(created.id);
    expect(found).toEqual(created);
  });

  it('returns null for an unknown id', async () => {
    const found = await service.findById('does-not-exist');
    expect(found).toBeNull();
  });

  it('finds all Companies under one Installation', async () => {
    await service.create({ installationId: 'installation', name: 'Acme Egypt', status: 'PROVISIONING' });
    await service.create({ installationId: 'installation', name: 'Acme UAE', status: 'PROVISIONING' });
    await service.create({ installationId: 'other-installation', name: 'Unrelated', status: 'PROVISIONING' });

    const found = await service.findByInstallationId('installation');
    expect(found).toHaveLength(2);
    expect(found.map((c) => c.name).sort()).toEqual(['Acme Egypt', 'Acme UAE']);
  });

  it('does not leak Companies across Installations', async () => {
    await service.create({ installationId: 'installation-a', name: 'A Co', status: 'PROVISIONING' });
    await service.create({ installationId: 'installation-b', name: 'B Co', status: 'PROVISIONING' });

    const forA = await service.findByInstallationId('installation-a');
    expect(forA).toHaveLength(1);
    expect(forA[0].name).toBe('A Co');
  });
});
