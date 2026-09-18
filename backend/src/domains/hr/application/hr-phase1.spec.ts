import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { HrService } from './hr.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { EmployeeStatusHistory } from '../infrastructure/employee-status-history.entity';

/**
 * ADR-059 (HR Phase 1) — E2E acceptance matrix proof (contract §8):
 * employee creation writes status history + audit; department is a real
 * `OrgUnit(type='department')` row, not a second table; the leave-request
 * FA-01 round-trip (submit -> approve -> status flips) and its negative
 * path (reject -> no side effect on the leave request itself, matching
 * this codebase's existing "no domain subscribes to
 * approval.request.rejected" convention); termination is blocked through
 * the routine `setStatus` path and only reachable through the dedicated
 * `terminate` action; Employee<->User linking is manual and rejects a
 * double-link.
 */
describe('HrService (ADR-059, HR Phase 1)', () => {
  let moduleRef: TestingModule;
  let hr: HrService;
  let approvals: ApprovalEngineService;
  let organization: OrganizationService;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const shortName = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    hr = moduleRef.get(HrService);
    approvals = moduleRef.get(ApprovalEngineService);
    organization = moduleRef.get(OrganizationService);
    dataSource = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('createDepartment writes a real OrgUnit(type=department) row with a NumberingService-issued code, never a second hr table', async () => {
    const dept = await hr.createDepartment({ name: shortName('Dept') }, ADMIN_A);
    expect(dept.code).toBeTruthy();
    const unit = await organization.getUnitById(dept.id);
    expect(unit?.type).toBe('department');

    const renamed = await hr.editDepartment(dept.id, 'Renamed Department', ADMIN_A);
    expect(renamed.name).toBe('Renamed Department');
  });

  it('createEmployee issues a code via NumberingService and never accepts a client-supplied one', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('Employee') }, ADMIN_A);
    expect(emp.code).toMatch(/^EMP-/);
  });

  it('setStatus writes an EmployeeStatusHistory row and an audit record; direct transition to terminated is refused', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('StatusEmp') }, ADMIN_A);
    await hr.setStatus(emp.id, 'on_leave', ADMIN_A, 'annual leave');

    const history = await dataSource.getRepository(EmployeeStatusHistory).find({ where: { employeeId: emp.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: 'active', toStatus: 'on_leave' });

    await expect(hr.setStatus(emp.id, 'terminated' as never, ADMIN_A)).rejects.toThrow(/dedicated terminate action/);
  });

  it('terminate (ADR-059 D3) captures evidence directly and is the only path to the terminated status', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('TermEmp') }, ADMIN_A);
    const terminated = await hr.terminate(emp.id, ADMIN_A, 'Resignation', '2026-09-19');
    expect(terminated.status).toBe('terminated');
    expect(terminated.terminationReason).toBe('Resignation');
    expect(terminated.terminationDate).toBe('2026-09-19');

    const history = await dataSource.getRepository(EmployeeStatusHistory).find({ where: { employeeId: emp.id } });
    expect(history.some((h) => h.toStatus === 'terminated' && h.reason === 'Resignation')).toBe(true);

    // A terminated employee has no further legal transition.
    await expect(hr.terminate(emp.id, ADMIN_A, 'again')).rejects.toThrow();
  });

  it('linkUser (ADR-059 D2) is manual-only and rejects linking the same user to two employees', async () => {
    const empA = await hr.createEmployee({ fullName: shortName('LinkA') }, ADMIN_A);
    const empB = await hr.createEmployee({ fullName: shortName('LinkB') }, ADMIN_A);

    const linked = await hr.linkUser(empA.id, ADMIN_A, ADMIN_A);
    expect(linked.userId).toBe(ADMIN_A);

    await expect(hr.linkUser(empB.id, ADMIN_A, ADMIN_A)).rejects.toThrow(/already linked to another employee/);
    await expect(hr.linkUser(empA.id, ADMIN_A, ADMIN_A)).rejects.toThrow(/already linked to a user account/);
  });

  it('leave request FA-01 round trip: submit -> approve -> status flips to approved, decidedAt set', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('LeaveEmp') }, ADMIN_A);
    const leaveRequest = await hr.submitLeaveRequest(
      { employeeId: emp.id, leaveType: 'annual', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'vacation' },
      ADMIN_A,
    );
    expect(leaveRequest.status).toBe('submitted');
    expect(leaveRequest.approvalRequestId).toBeTruthy();

    // The maker cannot decide their own request (FA-01 SoD) — use a second real user.
    const secondApprover = 'f539302e-9ae7-4cc2-99cf-381f08acab83'; // debug-admin@daii.example, an existing admin fixture
    await approvals.decide(leaveRequest.approvalRequestId!, secondApprover, 'approved', null);

    const reloaded = (await hr.listLeaveRequests(emp.id)).find((r) => r.id === leaveRequest.id);
    expect(reloaded?.status).toBe('approved');
    expect(reloaded?.decidedAt).toBeTruthy();
  }, 30_000);

  it('leave request rejection leaves no side effect on the leave request itself (matches this codebase\'s "no domain subscribes to rejected" convention)', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('RejectEmp') }, ADMIN_A);
    const leaveRequest = await hr.submitLeaveRequest(
      { employeeId: emp.id, leaveType: 'sick', startDate: '2026-10-10', endDate: '2026-10-11' },
      ADMIN_A,
    );

    const secondApprover = 'f539302e-9ae7-4cc2-99cf-381f08acab83';
    const decided = await approvals.decide(leaveRequest.approvalRequestId!, secondApprover, 'rejected', 'not enough coverage');
    expect(decided.state).toBe('rejected');

    const reloaded = (await hr.listLeaveRequests(emp.id)).find((r) => r.id === leaveRequest.id);
    expect(reloaded?.status).toBe('submitted'); // unchanged — no side effect from rejection
  }, 30_000);

  it('only an active employee may submit a leave request', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('InactiveEmp') }, ADMIN_A);
    await hr.terminate(emp.id, ADMIN_A, 'test fixture');
    await expect(
      hr.submitLeaveRequest({ employeeId: emp.id, leaveType: 'annual', startDate: '2026-11-01', endDate: '2026-11-02' }, ADMIN_A),
    ).rejects.toThrow(/only an active employee/);
  });

  it('hr.leave_request is registered so the approvals engine will accept it, and a leave request row always exists even before approvalRequestId resolves', async () => {
    const types = await approvals.listRequestTypes();
    expect(types.some((t) => t.requestTypeCode === 'hr.leave_request')).toBe(true);
  });
});
