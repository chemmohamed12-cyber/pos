import { CompanyActivationService } from './company-activation.service';
import { CompanyRegistryService } from './company-registry.service';
import { Company } from './company.entity';

describe('CompanyActivationService (Area 19)', () => {
  let service: CompanyActivationService;
  const companyRegistryMock = {
    transitionTo: jest.fn(async (id: string, status: string) => ({ id, status }) as unknown as Company),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CompanyActivationService(companyRegistryMock as unknown as CompanyRegistryService);
  });

  it('suspend() transitions the Company to SUSPENDED', async () => {
    const result = await service.suspend('company-1');
    expect(companyRegistryMock.transitionTo).toHaveBeenCalledWith('company-1', 'SUSPENDED');
    expect(result.status).toBe('SUSPENDED');
  });

  it('decommission() transitions the Company to DECOMMISSIONED', async () => {
    const result = await service.decommission('company-1');
    expect(companyRegistryMock.transitionTo).toHaveBeenCalledWith('company-1', 'DECOMMISSIONED');
    expect(result.status).toBe('DECOMMISSIONED');
  });

  it('reactivate() transitions the Company to READY (Area 2/19 decision, 2026-09-22)', async () => {
    const result = await service.reactivate('company-1');
    expect(companyRegistryMock.transitionTo).toHaveBeenCalledWith('company-1', 'READY');
    expect(result.status).toBe('READY');
  });

  it('reactivate() surfaces an invalid-source rejection unchanged (e.g. PROVISIONING -> READY is not reactivation)', async () => {
    companyRegistryMock.transitionTo.mockRejectedValueOnce(new Error('Invalid Company status transition: PROVISIONING -> READY'));
    await expect(service.reactivate('company-1')).rejects.toThrow('Invalid Company status transition');
  });

  it('any invalid transition Area 2 already rejects is surfaced unchanged (e.g. suspend on a non-READY Company)', async () => {
    companyRegistryMock.transitionTo.mockRejectedValueOnce(new Error('Invalid Company status transition: PROVISIONING -> SUSPENDED'));
    await expect(service.suspend('company-1')).rejects.toThrow('Invalid Company status transition');
  });
});
