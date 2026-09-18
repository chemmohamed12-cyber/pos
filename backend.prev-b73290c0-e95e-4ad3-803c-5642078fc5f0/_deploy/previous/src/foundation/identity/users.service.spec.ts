import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { User } from './user.entity';

/**
 * Main success/failure paths only, per CTO Execution Policy §5 —
 * repository mocked, no live DB needed for this unit-level coverage.
 */
describe('UsersService', () => {
  let service: UsersService;
  const store = new Map<string, User>();

  const repoMock = {
    findOne: jest.fn(async ({ where }: { where: Partial<User> }) => {
      for (const u of store.values()) {
        if (where.id && u.id === where.id) return u;
        if (where.email && u.email === where.email) return u;
      }
      return null;
    }),
    create: jest.fn((data: Partial<User>) => ({ id: `id-${store.size + 1}`, ...data }) as User),
    save: jest.fn(async (user: User) => {
      store.set(user.id, user);
      return user;
    }),
  };

  beforeEach(async () => {
    store.clear();
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, { provide: getRepositoryToken(User), useValue: repoMock }],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it('creates a user with pending status', async () => {
    const user = await service.create({ fullName: 'Test User', email: 'test@daii.example' });
    expect(user.status).toBe('pending');
    expect(user.email).toBe('test@daii.example');
  });

  it('rejects a duplicate email', async () => {
    await service.create({ fullName: 'A', email: 'dupe@daii.example' });
    await expect(service.create({ fullName: 'B', email: 'dupe@daii.example' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('finds a user by id', async () => {
    const created = await service.create({ fullName: 'Findable', email: 'find@daii.example' });
    const found = await service.findById(created.id);
    expect(found.email).toBe('find@daii.example');
  });

  it('throws NotFoundException for an unknown id', async () => {
    await expect(service.findById('does-not-exist')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('updateProfile (Admin screen name/email edit)', () => {
    it('updates fullName and email', async () => {
      const user = await service.create({ fullName: 'Old Name', email: 'old@daii.example' });
      const updated = await service.updateProfile(user.id, { fullName: 'New Name', email: 'new@daii.example' });
      expect(updated.fullName).toBe('New Name');
      expect(updated.email).toBe('new@daii.example');
    });

    it('allows saving with the email unchanged (does not false-positive against itself)', async () => {
      const user = await service.create({ fullName: 'Same Email', email: 'same@daii.example' });
      await expect(service.updateProfile(user.id, { fullName: 'Renamed', email: 'same@daii.example' })).resolves.toMatchObject({
        fullName: 'Renamed',
        email: 'same@daii.example',
      });
    });

    it('rejects changing the email to one already used by a DIFFERENT user', async () => {
      await service.create({ fullName: 'Taken', email: 'taken@daii.example' });
      const other = await service.create({ fullName: 'Other', email: 'other@daii.example' });
      await expect(service.updateProfile(other.id, { fullName: 'Other', email: 'taken@daii.example' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('throws NotFoundException for an unknown id', async () => {
      await expect(service.updateProfile('does-not-exist', { fullName: 'X', email: 'x@daii.example' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
