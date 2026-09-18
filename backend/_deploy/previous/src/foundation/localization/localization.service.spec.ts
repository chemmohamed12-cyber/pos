import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LocalizationService } from './localization.service';
import { UserLocalePreference } from './user-locale-preference.entity';

/** The invariant that matters: default is Arabic, never derived from anything but an explicit set. */
describe('LocalizationService', () => {
  let service: LocalizationService;
  const store = new Map<string, UserLocalePreference>();

  const repoMock = {
    findOne: jest.fn(async ({ where }: { where: { userId: string } }) => store.get(where.userId) ?? null),
    create: jest.fn((data: Partial<UserLocalePreference>) => data as UserLocalePreference),
    save: jest.fn(async (p: UserLocalePreference) => {
      store.set(p.userId, p);
      return p;
    }),
  };

  beforeEach(async () => {
    store.clear();
    const moduleRef = await Test.createTestingModule({
      providers: [LocalizationService, { provide: getRepositoryToken(UserLocalePreference), useValue: repoMock }],
    }).compile();
    service = moduleRef.get(LocalizationService);
  });

  it('defaults to Arabic for a user with no explicit preference', async () => {
    expect(await service.getPreferredLanguage('user-1')).toBe('ar');
  });

  it('remembers an explicit preference once set', async () => {
    await service.setPreferredLanguage('user-1', 'en');
    expect(await service.getPreferredLanguage('user-1')).toBe('en');
  });

  it('updates an existing preference rather than duplicating it', async () => {
    await service.setPreferredLanguage('user-1', 'en');
    await service.setPreferredLanguage('user-1', 'ar');
    expect(await service.getPreferredLanguage('user-1')).toBe('ar');
    expect(store.size).toBe(1);
  });
});
