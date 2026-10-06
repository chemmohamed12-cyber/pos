import { CompanyRegistryService, InvalidCompanyTransitionError } from './company-registry.service';
import { CompanyService } from './company.service';
import { Company } from './company.entity';

describe('CompanyRegistryService', () => {
  let service: CompanyRegistryService;
  const companies = new Map<string, Company>();
  let idSeq = 0;

  const companyServiceMock = {
    create: jest.fn(async (data: Partial<Company>) => {
      const company = { id: `company-${++idSeq}`, createdAt: new Date(), ...data } as Company;
      companies.set(company.id, company);
      return company;
    }),
    findById: jest.fn(async (id: string) => companies.get(id) ?? null),
    findByInstallationId: jest.fn(async (installationId: string) =>
      [...companies.values()].filter((c) => c.installationId === installationId),
    ),
    update: jest.fn(async (id: string, data: Partial<Company>) => {
      const existing = companies.get(id);
      if (!existing) throw new Error('not found');
      const updated = { ...existing, ...data };
      companies.set(id, updated);
      return updated;
    }),
  };

  beforeEach(() => {
    companies.clear();
    idSeq = 0;
    jest.clearAllMocks();
    service = new CompanyRegistryService(companyServiceMock as unknown as CompanyService);
  });

  describe('provision', () => {
    it('always starts a new Company at PROVISIONING', async () => {
      const company = await service.provision('installation', 'Acme Egypt');
      expect(company.status).toBe('PROVISIONING');
      expect(company.installationId).toBe('installation');
      expect(company.name).toBe('Acme Egypt');
    });
  });

  describe('transitionTo — valid transitions', () => {
    it('PROVISIONING -> READY succeeds', async () => {
      const company = await service.provision('installation', 'Acme Egypt');
      const updated = await service.transitionTo(company.id, 'READY');
      expect(updated.status).toBe('READY');
    });

    it('READY -> SUSPENDED succeeds', async () => {
      const company = await service.provision('installation', 'Acme Egypt');
      await service.transitionTo(company.id, 'READY');
      const updated = await service.transitionTo(company.id, 'SUSPENDED');
      expect(updated.status).toBe('SUSPENDED');
    });

    it('SUSPENDED -> DECOMMISSIONED succeeds', async () => {
      const company = await service.provision('installation', 'Acme Egypt');
      await service.transitionTo(company.id, 'READY');
      await service.transitionTo(company.id, 'SUSPENDED');
      const updated = await service.transitionTo(company.id, 'DECOMMISSIONED');
      expect(updated.status).toBe('DECOMMISSIONED');
    });

    it('SUSPENDED -> READY succeeds (reactivation — Area 2/19 decision, 2026-09-22)', async () => {
      const company = await service.provision('installation', 'Acme Egypt');
      await service.transitionTo(company.id, 'READY');
      await service.transitionTo(company.id, 'SUSPENDED');
      const updated = await service.transitionTo(company.id, 'READY');
      expect(updated.status).toBe('READY');
    });
  });

  describe('transitionTo — invalid transitions rejected', () => {
    it('rejects PROVISIONING -> DECOMMISSIONED (skips the chain)', async () => {
      const company = await service.provision('installation', 'Acme Egypt');
      await expect(service.transitionTo(company.id, 'DECOMMISSIONED')).rejects.toThrow(InvalidCompanyTransitionError);
    });

    it('rejects READY -> DECOMMISSIONED directly (must pass through an intermediate state first)', async () => {
      const company = await service.provision('installation', 'Acme Egypt');
      await service.transitionTo(company.id, 'READY');
      await expect(service.transitionTo(company.id, 'DECOMMISSIONED')).rejects.toThrow(InvalidCompanyTransitionError);
    });

    it('rejects a transition on an unknown Company id', async () => {
      await expect(service.transitionTo('does-not-exist', 'READY')).rejects.toThrow('Company not found');
    });
  });

  describe('listVisible — visibility gating', () => {
    it('does not show a company still in PROVISIONING', async () => {
      await service.provision('installation', 'Not Ready Yet');
      const visible = await service.listVisible('installation');
      expect(visible).toHaveLength(0);
    });

    it('shows a company once it reaches READY', async () => {
      const company = await service.provision('installation', 'Acme Egypt');
      await service.transitionTo(company.id, 'READY');
      const visible = await service.listVisible('installation');
      expect(visible).toHaveLength(1);
      expect(visible[0].name).toBe('Acme Egypt');
    });

    it('does not leak visible Companies across Installations', async () => {
      const a = await service.provision('installation-a', 'A Co');
      await service.transitionTo(a.id, 'READY');
      const b = await service.provision('installation-b', 'B Co');
      await service.transitionTo(b.id, 'READY');

      const visibleForA = await service.listVisible('installation-a');
      expect(visibleForA).toHaveLength(1);
      expect(visibleForA[0].name).toBe('A Co');
    });
  });
});
