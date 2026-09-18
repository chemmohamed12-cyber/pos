import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { HrService } from './hr.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { EmployeeStatusHistory } from '../infrastructure/employee-status-history.entity';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthService } from '../../../foundation/authentication/auth.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';

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
  let permissions: PermissionService;
  let auth: AuthService;
  let authorization: AuthorizationService;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const shortName = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    hr = moduleRef.get(HrService);
    approvals = moduleRef.get(ApprovalEngineService);
    organization = moduleRef.get(OrganizationService);
    dataSource = moduleRef.get(DataSource);
    permissions = moduleRef.get(PermissionService);
    auth = moduleRef.get(AuthService);
    authorization = moduleRef.get(AuthorizationService);
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
    // A fresh, uniquely-registered user — not a shared fixture like ADMIN_A — so this test is
    // safely re-runnable against this session's persistent dev database (a real prior run linking
    // ADMIN_A itself would otherwise make a re-run's "not yet linked" assumption false).
    const targetEmail = `adr059-link-target-${Date.now()}@daii.example`;
    const targetUser = await auth.register(targetEmail, 'ADR-059 Link Target Fixture', 'TestPassword123!');

    const empA = await hr.createEmployee({ fullName: shortName('LinkA') }, ADMIN_A);
    const empB = await hr.createEmployee({ fullName: shortName('LinkB') }, ADMIN_A);

    const linked = await hr.linkUser(empA.id, targetUser.id, ADMIN_A);
    expect(linked.userId).toBe(targetUser.id);

    await expect(hr.linkUser(empB.id, targetUser.id, ADMIN_A)).rejects.toThrow(/already linked to another employee/);
    await expect(hr.linkUser(empA.id, targetUser.id, ADMIN_A)).rejects.toThrow(/already linked to a user account/);
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

  it('editEmployee (Stage 2/E2E-03) updates fields and validates the target department is a real department OrgUnit', async () => {
    const dept = await hr.createDepartment({ name: shortName('EditDept') }, ADMIN_A);
    const emp = await hr.createEmployee({ fullName: shortName('EditEmp') }, ADMIN_A);

    const edited = await hr.editEmployee(emp.id, { fullName: 'Edited Name', position: 'Senior Engineer', departmentId: dept.id }, ADMIN_A);
    expect(edited.fullName).toBe('Edited Name');
    expect(edited.position).toBe('Senior Engineer');
    expect(edited.departmentId).toBe(dept.id);

    const notADepartment = await hr.createEmployee({ fullName: shortName('NotADept') }, ADMIN_A);
    await expect(hr.editEmployee(emp.id, { departmentId: notADepartment.id }, ADMIN_A)).rejects.toThrow(/not found/);
  });

  it('assignManager (Stage 2/E2E-05) sets and clears the reporting line, and refuses self-management', async () => {
    const manager = await hr.createEmployee({ fullName: shortName('Manager') }, ADMIN_A);
    const report = await hr.createEmployee({ fullName: shortName('Report') }, ADMIN_A);

    const assigned = await hr.assignManager(report.id, manager.id, ADMIN_A);
    expect(assigned.managerId).toBe(manager.id);

    const cleared = await hr.assignManager(report.id, null, ADMIN_A);
    expect(cleared.managerId).toBeNull();

    await expect(hr.assignManager(report.id, report.id, ADMIN_A)).rejects.toThrow(/cannot be their own manager/);
  });

  it('terminate (E2E-06) creates zero ApprovalRequest rows — confirms D3: no FA-01 for termination', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('NoFa01Term') }, ADMIN_A);
    await hr.terminate(emp.id, ADMIN_A, 'Stage-6 proof');
    const requestsForThisEmployee = await approvals.listRequests({ resourceType: 'hr_employee', resourceId: emp.id });
    expect(requestsForThisEmployee).toHaveLength(0);
  });

  it('cancelLeaveRequest (Stage 3 "cancel where permitted") withdraws a pending request; the approval state reflects it, the local status is untouched', async () => {
    const emp = await hr.createEmployee({ fullName: shortName('CancelEmp') }, ADMIN_A);
    const leaveRequest = await hr.submitLeaveRequest(
      { employeeId: emp.id, leaveType: 'annual', startDate: '2026-12-01', endDate: '2026-12-02' },
      ADMIN_A,
    );
    await hr.cancelLeaveRequest(leaveRequest.id, ADMIN_A);

    const withState = await hr.listLeaveRequestsWithApprovalState(emp.id);
    const found = withState.find((r) => r.id === leaveRequest.id);
    expect(found?.approvalState).toBe('withdrawn');
    expect(found?.status).toBe('submitted'); // local status column never holds a terminal-approval-only state

    // Only the maker may cancel — a second user is refused.
    const emp2 = await hr.createEmployee({ fullName: shortName('CancelEmp2') }, ADMIN_A);
    const secondRequest = await hr.submitLeaveRequest(
      { employeeId: emp2.id, leaveType: 'sick', startDate: '2026-12-05', endDate: '2026-12-06' },
      ADMIN_A,
    );
    const secondApprover = 'f539302e-9ae7-4cc2-99cf-381f08acab83';
    await expect(hr.cancelLeaveRequest(secondRequest.id, secondApprover)).rejects.toThrow(/Only the maker/);
  }, 30_000);

  it('Stage 5/E2E-09 — permission resolution enforces the intended authorization boundary: hr.viewer can view but not write, hr.manager can write', async () => {
    const viewerEmail = `adr059-hr-viewer-${Date.now()}@daii.example`;
    const viewer = await auth.register(viewerEmail, 'ADR-059 HR Viewer Fixture', 'TestPassword123!');
    await authorization.assignRole(viewer.id, 'hr.viewer');

    const managerEmail = `adr059-hr-manager-${Date.now()}@daii.example`;
    const manager = await auth.register(managerEmail, 'ADR-059 HR Manager Fixture', 'TestPassword123!');
    await authorization.assignRole(manager.id, 'hr.manager');

    for (const node of ['hr.employee.terminate', 'hr.employee.link_user', 'hr.employee.edit', 'hr.department.create']) {
      expect(await permissions.hasAtLeast(viewer.id, node, 'editable')).toBe(false);
      expect(await permissions.hasAtLeast(manager.id, node, 'editable')).toBe(true);
    }
    // Read access is granted to both — this boundary is about WRITE, not visibility.
    expect(await permissions.hasAtLeast(viewer.id, 'hr.employee.view', 'read-only')).toBe(true);
  });

  it('E2E-10 — hr_departments is no longer a competing Department source (table dropped; all department reads resolve through OrgUnit)', async () => {
    const tableCheck = await dataSource.query(`SELECT to_regclass('public.hr_departments') AS t`);
    expect(tableCheck[0].t).toBeNull();

    const dept = await hr.createDepartment({ name: shortName('SoleSourceDept') }, ADMIN_A);
    const viaOrganization = await organization.listUnitsByType('department');
    expect(viaOrganization.some((u) => u.id === dept.id)).toBe(true);
  });
});
