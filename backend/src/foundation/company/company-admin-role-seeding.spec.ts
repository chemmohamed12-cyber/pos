/**
 * Multi-Company Area 20 / Membership Management (2026-09-24, §3.1 verified
 * decision). Proves `seedCompanyAdminRole` writes only literal, real
 * grants (never a wildcard — §3.1 confirmed the engine has none), computed
 * from the caller's own moduleCodes, and is idempotent.
 */
interface FakeRole {
  id: string;
  key: string;
  createdAt: Date;
}
interface FakeGrant {
  id: string;
  roleId: string;
  nodeKey: string;
  access: string;
  createdAt: Date;
}

const rolesStoreMock = new Map<string, FakeRole>();
const grantsStoreMock = new Map<string, FakeGrant>();
let idSeqMock = 0;

const roleRepoMock = {
  findOne: jest.fn(async ({ where }: { where: { key: string } }) => [...rolesStoreMock.values()].find((r) => r.key === where.key) ?? null),
  create: jest.fn((data: Partial<FakeRole>) => ({ id: `role-${++idSeqMock}`, createdAt: new Date(), ...data }) as FakeRole),
  save: jest.fn(async (row: FakeRole) => {
    rolesStoreMock.set(row.id, row);
    return row;
  }),
};
const grantRepoMock = {
  findOne: jest.fn(async ({ where }: { where: { roleId: string; nodeKey: string } }) =>
    [...grantsStoreMock.values()].find((g) => g.roleId === where.roleId && g.nodeKey === where.nodeKey) ?? null,
  ),
  create: jest.fn((data: Partial<FakeGrant>) => ({ id: `grant-${++idSeqMock}`, createdAt: new Date(), ...data }) as FakeGrant),
  save: jest.fn(async (row: FakeGrant) => {
    grantsStoreMock.set(row.id, row);
    return row;
  }),
};

const dsInitializeMock = jest.fn(async () => undefined);
const dsDestroyMock = jest.fn(async () => undefined);
let dsIsInitializedMock = false;

jest.mock('typeorm', () => ({
  ...jest.requireActual('typeorm'),
  DataSource: jest.fn().mockImplementation(() => ({
    initialize: async () => {
      dsIsInitializedMock = true;
      await dsInitializeMock();
    },
    destroy: async () => {
      dsIsInitializedMock = false;
      await dsDestroyMock();
    },
    get isInitialized() {
      return dsIsInitializedMock;
    },
    getRepository: jest.fn((entity: unknown) => {
      // Role.entity.ts's class name vs RolePermission.entity.ts's class name — distinguished by
      // constructor identity is unavailable here (both mocked away), so route by call order isn't
      // reliable either; instead this fake models the ONE distinguishing fact seedCompanyAdminRole
      // actually depends on: two logically separate tables. Real entity identity is exercised for
      // real by `company-registry.service.spec.ts`-style specs elsewhere; this file's job is the
      // grant-computation and idempotency logic, which only needs two consistently-separate repos.
      return (entity as { name?: string })?.name === 'RolePermission' ? grantRepoMock : roleRepoMock;
    }),
  })),
}));

import { seedCompanyAdminRole, COMPANY_MEMBERS_MANAGE_NODE, COMPANY_BACKUP_MANAGE_NODE, COMPANY_AUDIT_VIEW_NODE } from './company-role-seeding';

/**
 * Fixed/"always-present" node count, independent of moduleCodes. 1 → 2 by
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 10, D-Backup-05,
 * `COMPANY_BACKUP_MANAGE_NODE`). 2 → 3 by Area 14 (2026-09-25, CTO
 * Implementation Gate, `COMPANY_AUDIT_VIEW_NODE`) — a Company's own
 * `admin` role can now use `CompanyAuditController`'s self-service query
 * surface, same literal-grant discipline (§3.1 unchanged, never a
 * wildcard).
 */
import { WORKFLOW_NODES } from '../authorization/workflow-rules';
const FIXED_CORE_NODE_COUNT = 4 + WORKFLOW_NODES.length; // the four core.company.* nodes + (F5) every workflow capability the legacy administrator passed implicitly

describe('seedCompanyAdminRole — §3.1 verified decision (2026-09-24)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rolesStoreMock.clear();
    grantsStoreMock.clear();
    dsIsInitializedMock = false;
  });

  it('creates the admin Role and grants one node per module plus the always-present core nodes', async () => {
    const result = await seedCompanyAdminRole({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, ['sales', 'inventory']);

    expect(result.created).toBe(true);
    expect(result.grants).toBe(2 + FIXED_CORE_NODE_COUNT); // sales, inventory + the four core.company.* administration nodes (members, roles [F3], backup, audit)
    const grants = [...grantsStoreMock.values()].map((g) => g.nodeKey);
    expect(grants).toEqual(expect.arrayContaining(['sales', 'inventory', COMPANY_MEMBERS_MANAGE_NODE, COMPANY_BACKUP_MANAGE_NODE, COMPANY_AUDIT_VIEW_NODE]));
    expect(grants.every((n) => n !== '*')).toBe(true); // never a wildcard — §3.1
    expect([...grantsStoreMock.values()].every((g) => g.access === 'editable')).toBe(true);
  });

  it('is idempotent — a repeat call for the same moduleCodes creates no duplicate Role or grants', async () => {
    await seedCompanyAdminRole({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, ['sales']);
    const second = await seedCompanyAdminRole({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, ['sales']);

    expect(second.created).toBe(false);
    expect(second.grants).toBe(0);
    expect(rolesStoreMock.size).toBe(1);
    expect(grantsStoreMock.size).toBe(1 + FIXED_CORE_NODE_COUNT); // sales + the two core nodes, still just those
  });

  it('adding a newly-entitled module on a later call grants only the new node, not a duplicate of the existing ones', async () => {
    await seedCompanyAdminRole({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, ['sales']);
    const second = await seedCompanyAdminRole({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, ['sales', 'inventory']);

    expect(second.grants).toBe(1); // only 'inventory' is new
    expect(grantsStoreMock.size).toBe(2 + FIXED_CORE_NODE_COUNT);
  });

  it('closes its Company-scoped DataSource connection whether it succeeds or was a no-op repeat', async () => {
    await seedCompanyAdminRole({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, []);
    expect(dsDestroyMock).toHaveBeenCalledTimes(1);
  });
});
