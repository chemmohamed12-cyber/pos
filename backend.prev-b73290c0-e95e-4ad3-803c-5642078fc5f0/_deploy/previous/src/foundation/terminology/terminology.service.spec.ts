import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TerminologyService } from './terminology.service';
import { TerminologyEntry } from './terminology-entry.entity';

/** Main paths + the never-blank fallback invariant, per CTO Execution Policy §5. */
describe('TerminologyService', () => {
  let service: TerminologyService;
  const entries: TerminologyEntry[] = [
    { id: '1', code: 'PENDING_REVIEW', category: 'workflow_status', ar: 'بانتظار المراجعة', en: 'Pending Review', version: 1, createdAt: new Date(), updatedAt: new Date() },
    { id: '2', code: 'AR_MISSING_CASE', category: 'workflow_status', ar: '', en: 'English Only', version: 1, createdAt: new Date(), updatedAt: new Date() },
  ];

  const repoMock = {
    findOne: jest.fn(async ({ where }: { where: { code: string } }) => entries.find((e) => e.code === where.code) ?? null),
    find: jest.fn(async ({ where }: { where: { code: { value: string[] } } }) =>
      entries.filter((e) => where.code.value.includes(e.code)),
    ),
    create: jest.fn((data: Partial<TerminologyEntry>) => ({ id: '3', version: 1, ...data }) as TerminologyEntry),
    save: jest.fn(async (e: TerminologyEntry) => e),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [TerminologyService, { provide: getRepositoryToken(TerminologyEntry), useValue: repoMock }],
    }).compile();
    service = moduleRef.get(TerminologyService);
  });

  it('resolves the Arabic label for a known code', async () => {
    expect(await service.resolve('PENDING_REVIEW', 'ar')).toBe('بانتظار المراجعة');
  });

  it('resolves the English label for a known code', async () => {
    expect(await service.resolve('PENDING_REVIEW', 'en')).toBe('Pending Review');
  });

  it('falls back to English when Arabic is missing, never blank', async () => {
    expect(await service.resolve('AR_MISSING_CASE', 'ar')).toBe('English Only');
  });

  it('falls back to the raw code for an unregistered code, never throws', async () => {
    expect(await service.resolve('TOTALLY_UNKNOWN_CODE', 'ar')).toBe('TOTALLY_UNKNOWN_CODE');
  });

  it('resolveMany returns labels for every requested code, including unregistered ones', async () => {
    const result = await service.resolveMany(['PENDING_REVIEW', 'UNKNOWN'], 'en');
    expect(result).toEqual({ PENDING_REVIEW: 'Pending Review', UNKNOWN: 'UNKNOWN' });
  });

  it('upsert revises wording and bumps version without changing the code', async () => {
    const updated = await service.upsert('PENDING_REVIEW', 'workflow_status', 'قيد المراجعة', 'Under Review');
    expect(updated.code).toBe('PENDING_REVIEW');
    expect(updated.version).toBe(2);
  });
});
