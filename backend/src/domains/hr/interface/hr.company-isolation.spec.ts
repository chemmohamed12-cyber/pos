import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { HrService } from '../application/hr.service';
import { Employee } from '../infrastructure/employee.entity';
import { LeaveRequest } from '../infrastructure/leave-request.entity';
import { LimitService } from '../../../foundation/limit-engine/limit.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

/**
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres proof that `hr.controller.ts`'s reads/writes are
 * genuinely Company-scoped: two real Company databases (HR tables included), real Approval Engine /
 * Numbering / Organization / Limit engines, the real `'company'`-scope approval subscriber. Never mocked.
 */
describe('HrService Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let hr: HrService;
  let events: EventBusService;
  let approverA: string;
  let makerA: string;
  const NODE = 'hr.leave_request.approve';

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'hr_isolation', extraCompanyTags: ['hr'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    events = new EventBusService(inert, h.connections);
    const numbering = new NumberingService(ambient);
    const limits = new LimitService(ambient, { sync: async () => undefined } as never, audit);
    const permissions = new PermissionService(inert, new AuthorizationService(inert, inert));
    const approvals = new ApprovalEngineService(ambient, new ProcessEngineService(ambient), audit, events, permissions, { get: () => 24 } as never);
    hr = new HrService(ambient, limits, events, audit, new OrganizationService(ambient), numbering, approvals, h.users);
    await hr.onModuleInit(); // registers numbering types + approval type/rule declaration + the company-scope subscriber

    makerA = (await h.createUserWithAdminRoleIn('HR Maker A', h.companyAId)).id;
    approverA = (await h.createUserWithAdminRoleIn('HR Approver A', h.companyAId)).id;
    const ds = await h.connections.getDataSource(h.companyAId);
    const role = (await ds.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    await ds.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable') ON CONFLICT DO NOTHING`, [role.id, NODE]);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown();
  });

  const mgr = async (id: string) => (await h.connections.getDataSource(id)).manager;

  it('createDepartment / createEmployee write only into the calling Company, with that Company\'s own numbering', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const deptA = await hr.createDepartment({ name: 'Sales' }, makerA, mA);
    const deptB = await hr.createDepartment({ name: 'Sales' }, makerA, mB); // identical name in B
    expect(deptA.code).toBe(deptB.code); // independent sequences: both are the first department of their Company
    const empA = await hr.createEmployee({ fullName: 'Alice A', departmentId: deptA.id }, makerA, mA);
    const empB = await hr.createEmployee({ fullName: 'Bob B', departmentId: deptB.id }, makerA, mB);
    expect(empA.code).toBe(empB.code); // EMP-<year>-000001 in each Company
    expect((await hr.listEmployees(mA)).map((e) => e.fullName)).toEqual(['Alice A']);
    expect((await hr.listEmployees(mB)).map((e) => e.fullName)).toEqual(['Bob B']);
    expect((await hr.listDepartments(mA)).length).toBe(1);
  });

  it('another Company cannot read, edit or reference an employee / department it does not own', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const [empA] = await hr.listEmployees(mA);
    await expect(hr.getEmployee(empA.id, mB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(hr.editEmployee(empA.id, { position: 'x' }, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
    const [deptA] = await hr.listDepartments(mA);
    await expect(hr.createEmployee({ fullName: 'Cross', departmentId: deptA.id }, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('status, termination, manager and user-link all stay inside the Company (and one User can be an Employee in two Companies independently)', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const [empA] = await hr.listEmployees(mA);
    const [empB] = await hr.listEmployees(mB);
    expect((await hr.setStatus(empA.id, 'on_leave', makerA, 'r', mA)).status).toBe('on_leave');
    expect((await hr.getEmployee(empB.id, mB)).status).toBe('active'); // B untouched
    await hr.setStatus(empA.id, 'active', makerA, null, mA);
    const shared = await h.users.create({ fullName: 'Shared Person', email: `shared-${randomUUID()}@test.local` });
    await hr.linkUser(empA.id, shared.id, makerA, mA);
    await hr.linkUser(empB.id, shared.id, makerA, mB); // same User, different Company → allowed
    await expect(hr.linkUser(empA.id, shared.id, makerA, mA)).rejects.toBeInstanceOf(ConflictException);
    expect((await hr.getEmployeeByUserId(shared.id, mA))?.id).toBe(empA.id);
    expect((await hr.getEmployeeByUserId(shared.id, mB))?.id).toBe(empB.id);
    const boss = await hr.createEmployee({ fullName: 'Boss A' }, makerA, mA);
    expect((await hr.assignManager(empA.id, boss.id, makerA, mA)).managerId).toBe(boss.id);
    await expect(hr.assignManager(empB.id, boss.id, makerA, mB)).rejects.toBeInstanceOf(NotFoundException); // A's employee is not a manager candidate in B
    const t = await hr.terminate(boss.id, makerA, 'left', null, mA);
    expect(t.status).toBe('terminated');
    expect((await hr.listStatusHistory(boss.id, mA)).length).toBe(1);
  });

  it("leave-request approval round-trip happens entirely in the Company: request, decision, event and the status flip", async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const [empA] = await hr.listEmployees(mA);
    const leave = await hr.submitLeaveRequest({ employeeId: empA.id, leaveType: 'annual', startDate: '2026-11-01', endDate: '2026-11-03' }, makerA, mA);
    expect(leave.approvalRequestId).toBeTruthy();
    // visible with its approval state in A, absent in B
    expect((await hr.listLeaveRequestsWithApprovalState(undefined, mA))[0].approvalState).toBe('pending');
    expect(await hr.listLeaveRequests(undefined, mB)).toEqual([]);
    // the ambient database never received the request
    expect((await ambient.query(`SELECT count(*)::int n FROM approval_requests`))[0].n).toBe(0);
    // B cannot decide A's request
    await expect(hr.decide(leave.approvalRequestId!, approverA, 'approved', null, mB)).rejects.toBeInstanceOf(NotFoundException);
    // A's approver decides; the company-scope subscriber applies it to A's row
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await hr.decide(leave.approvalRequestId!, approverA, 'approved', null, mA);
    });
    const after = await mA.getRepository(LeaveRequest).findOneOrFail({ where: { id: leave.id } });
    expect(after.status).toBe('approved');
    expect(await hr.isApprovedLeaveDate(empA.id, '2026-11-02', mA)).toBe(true);
    expect(await hr.isApprovedLeaveDate(empA.id, '2026-12-02', mA)).toBe(false);
  });

  it('cancelLeaveRequest is maker-only and withdraws in the Company', async () => {
    const mA = await mgr(h.companyAId);
    const [empA] = await hr.listEmployees(mA);
    const leave = await hr.submitLeaveRequest({ employeeId: empA.id, leaveType: 'sick', startDate: '2026-12-10', endDate: '2026-12-11' }, makerA, mA);
    await expect(hr.cancelLeaveRequest(leave.id, approverA, mA)).rejects.toThrow();
    await hr.cancelLeaveRequest(leave.id, makerA, mA);
    const req = await hr.listLeaveRequestsWithApprovalState(undefined, mA);
    expect(req.find((r) => r.id === leave.id)?.approvalState).toBe('withdrawn');
  });

  it('Test F — nothing leaked into the other Company\'s tables', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsB.getRepository(Employee).find()).map((e) => e.fullName)).toEqual(['Bob B']);
    expect(await dsB.getRepository(LeaveRequest).count()).toBe(0);
  });
});
