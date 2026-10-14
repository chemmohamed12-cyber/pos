jest.mock('./membership-role-provisioning', () => ({
  provisionUserRoleForMembership: jest.fn(),
  deprovisionUserRoleForMembership: jest.fn(),
}));

// LA-1 Layer 2: the scheduler now runs each Company's work through `runOperationalAdmitted`. This UNIT spec isolates the scheduler from the Platform database, so the admission helper is replaced by an
// always-admitting stand-in that still acquires the Company DataSource through the (mocked) connection manager — the assertions below are unchanged. The admission behaviour itself (READY / not READY, isolation,
// lifecycle) is proven against real Postgres in `la1-layer2-sites-1-5-6-7.real-pg.spec.ts` and `company-lifecycle-admission.real-pg.spec.ts`.
jest.mock('./company-lifecycle-admission', () => ({
  runOperationalAdmitted: async (_platform: unknown, connections: { getDataSource: (id: string) => Promise<unknown> }, companyId: string, work: (ds: unknown) => Promise<unknown>) => ({
    admitted: true,
    value: await work(await connections.getDataSource(companyId)),
  }),
}));

import { MembershipReconciliationScheduler } from './membership-reconciliation.scheduler';
import { MembershipOperationService } from './membership-operation.service';
import { MembershipService } from './membership.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { MembershipOperation } from './membership-operation.entity';
import { provisionUserRoleForMembership, deprovisionUserRoleForMembership } from './membership-role-provisioning';

/**
 * Multi-Company Membership HTTP Management (2026-09-24, D5). Same rigor
 * standard as the other Area 9 schedulers: per-Company connection via
 * `CompanyConnectionManagerService`, per-operation failure isolation, and
 * here specifically — the staleness guard that stops a stale retry from
 * undoing a later, already-committed Membership decision.
 */
describe('MembershipReconciliationScheduler — Multi-Company D5 (2026-09-24)', () => {
  let scheduler: MembershipReconciliationScheduler;
  const operationsMock = { findRetryable: jest.fn(), markRetrying: jest.fn(), markCompleted: jest.fn(), markFailed: jest.fn() };
  const membershipsMock = { findByUserAndCompany: jest.fn() };
  const connectionsMock = { getDataSource: jest.fn() };
  const auditMock = { record: jest.fn() };
  const fakeManager = { tag: 'company-manager' };
  const fakeDataSource = { tag: 'company-datasource', manager: fakeManager, transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb(fakeManager)) };

  beforeEach(() => {
    jest.clearAllMocks();
    connectionsMock.getDataSource.mockResolvedValue(fakeDataSource);
    scheduler = new MembershipReconciliationScheduler(
      operationsMock as unknown as MembershipOperationService,
      membershipsMock as unknown as MembershipService,
      connectionsMock as unknown as CompanyConnectionManagerService,
      auditMock as never,
      {} as never, // platform DataSource: unused, the admission helper is replaced above
    );
  });

  it('retries a FAILED grant whose target role still matches the current Membership, and marks it COMPLETED', async () => {
    const op = { id: 'op-1', userId: 'user-1', companyId: 'company-1', operationType: 'grant', previousRoleKey: null, targetRoleKey: 'accountant' } as MembershipOperation;
    operationsMock.findRetryable.mockResolvedValue([op]);
    membershipsMock.findByUserAndCompany.mockResolvedValue({ roleKey: 'accountant' });

    await scheduler.runOnce();

    expect(connectionsMock.getDataSource).toHaveBeenCalledWith('company-1');
    expect(provisionUserRoleForMembership).toHaveBeenCalledWith(fakeDataSource, 'user-1', 'accountant');
    expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-1');
  });

  it('a superseded grant (Membership revoked since) is marked COMPLETED WITHOUT touching the Company DB', async () => {
    const op = { id: 'op-1', userId: 'user-1', companyId: 'company-1', operationType: 'grant', previousRoleKey: null, targetRoleKey: 'accountant' } as MembershipOperation;
    operationsMock.findRetryable.mockResolvedValue([op]);
    membershipsMock.findByUserAndCompany.mockResolvedValue(null); // revoked since

    await scheduler.runOnce();

    expect(provisionUserRoleForMembership).not.toHaveBeenCalled();
    expect(connectionsMock.getDataSource).not.toHaveBeenCalled();
    expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-1');
  });

  it('a superseded grant (role changed since to something else) is also marked COMPLETED WITHOUT touching the Company DB', async () => {
    const op = { id: 'op-1', userId: 'user-1', companyId: 'company-1', operationType: 'grant', previousRoleKey: null, targetRoleKey: 'accountant' } as MembershipOperation;
    operationsMock.findRetryable.mockResolvedValue([op]);
    membershipsMock.findByUserAndCompany.mockResolvedValue({ roleKey: 'hr.manager' }); // changed since by a later role_change

    await scheduler.runOnce();

    expect(provisionUserRoleForMembership).not.toHaveBeenCalled();
    expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-1');
  });

  it('a revoke operation retries unconditionally — never checks current Membership (it is already gone by design)', async () => {
    const op = { id: 'op-1', userId: 'user-1', companyId: 'company-1', operationType: 'revoke', previousRoleKey: 'accountant', targetRoleKey: null } as MembershipOperation;
    operationsMock.findRetryable.mockResolvedValue([op]);

    await scheduler.runOnce();

    expect(membershipsMock.findByUserAndCompany).not.toHaveBeenCalled();
    expect(deprovisionUserRoleForMembership).toHaveBeenCalledWith(fakeDataSource, 'user-1', 'accountant');
    expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-1');
  });

  it('a role_change operation applies deprovision+provision inside one Company-DB transaction, never two independent writes', async () => {
    const op = { id: 'op-1', userId: 'user-1', companyId: 'company-1', operationType: 'role_change', previousRoleKey: 'accountant', targetRoleKey: 'hr.manager' } as MembershipOperation;
    operationsMock.findRetryable.mockResolvedValue([op]);
    membershipsMock.findByUserAndCompany.mockResolvedValue({ roleKey: 'hr.manager' });

    await scheduler.runOnce();

    expect(fakeDataSource.transaction).toHaveBeenCalledTimes(1);
    expect(deprovisionUserRoleForMembership).toHaveBeenCalledWith(fakeManager, 'user-1', 'accountant');
    expect(provisionUserRoleForMembership).toHaveBeenCalledWith(fakeManager, 'user-1', 'hr.manager');
    expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-1');
  });

  it('one operation failing again does not stop the sweep for the rest', async () => {
    const opA = { id: 'op-1', userId: 'user-1', companyId: 'company-1', operationType: 'revoke', previousRoleKey: 'accountant', targetRoleKey: null } as MembershipOperation;
    const opB = { id: 'op-2', userId: 'user-2', companyId: 'company-2', operationType: 'revoke', previousRoleKey: 'accountant', targetRoleKey: null } as MembershipOperation;
    operationsMock.findRetryable.mockResolvedValue([opA, opB]);
    (deprovisionUserRoleForMembership as jest.Mock).mockRejectedValueOnce(new Error('still unreachable')).mockResolvedValueOnce(undefined);

    await expect(scheduler.runOnce()).resolves.toBeUndefined();

    expect(operationsMock.markFailed).toHaveBeenCalledWith('op-1', 'still unreachable');
    expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-2');
  });

  it('a Company whose database is not ACTIVE (getDataSource throws) marks the operation FAILED again, not fatal to the sweep', async () => {
    const op = { id: 'op-1', userId: 'user-1', companyId: 'company-1', operationType: 'revoke', previousRoleKey: 'accountant', targetRoleKey: null } as MembershipOperation;
    operationsMock.findRetryable.mockResolvedValue([op]);
    connectionsMock.getDataSource.mockRejectedValueOnce(new Error('not ACTIVE'));

    await scheduler.runOnce();

    expect(operationsMock.markFailed).toHaveBeenCalledWith('op-1', 'not ACTIVE');
  });
});
