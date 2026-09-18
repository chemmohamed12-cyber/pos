import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Employee } from '../infrastructure/employee.entity';
import { EmployeeStatusHistory } from '../infrastructure/employee-status-history.entity';
import { LeaveRequest } from '../infrastructure/leave-request.entity';
import { EmployeeStatus, canTransitionEmployeeStatus } from '../domain/employee-status';
import { EmploymentType } from '../domain/employment-type';
import { LimitService } from '../../../foundation/limit-engine/limit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { OrgUnit } from '../../../foundation/organization/org-unit.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { UsersService } from '../../../foundation/identity/users.service';

export interface CreateDepartmentInput {
  name: string;
  parentId?: string | null;
}

export interface CreateEmployeeInput {
  fullName: string;
  departmentId?: string | null;
  position?: string | null;
  hireDate?: string | null;
  employmentType?: EmploymentType | null;
}

export interface EditEmployeeInput {
  fullName?: string;
  departmentId?: string | null;
  position?: string | null;
  hireDate?: string | null;
  employmentType?: EmploymentType | null;
}

export interface SubmitLeaveRequestInput {
  employeeId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  reason?: string | null;
}

const LEAVE_REQUEST_TYPE = 'hr.leave_request';
const LEAVE_REQUEST_APPROVER_NODE = 'hr.leave_request.approve';
// ADR-046 D7's own convention (matches FiscalPeriodService) — actions applied by an internal
// subscriber reacting to an approved FA-01 request, not by a live user.
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * ADR-059 (HR Phase 1). `hr`'s application service — extended from P9
 * (ADR-029). `hr.depends_on: []` is deliberately given up here (ratified
 * D1): this is the first and only cross-domain import HR makes, into the
 * Platform-Core `OrganizationService` (`OrgUnit` is now the single source
 * of truth for departments — `hr_departments` is retired). Employee/User
 * linking (D2) is manual-only — nothing here ever creates a `User`.
 * Termination (D3) is a direct, permission-gated action, never routed
 * through FA-01. Employee and department codes (D4) are always
 * `NumberingService`-issued, never client-supplied.
 */
@Injectable()
export class HrService implements OnModuleInit {
  constructor(
    @InjectRepository(Employee) private readonly employees: Repository<Employee>,
    @InjectRepository(EmployeeStatusHistory) private readonly statusHistory: Repository<EmployeeStatusHistory>,
    @InjectRepository(LeaveRequest) private readonly leaveRequests: Repository<LeaveRequest>,
    private readonly dataSource: DataSource,
    private readonly limits: LimitService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly organization: OrganizationService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalEngineService,
    private readonly users: UsersService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.numbering.registerDocumentType('hr_employee', 'EMP', true);
    await this.numbering.registerDocumentType('hr_department', 'DEPT', false);

    await this.approvals.registerRequestType(LEAVE_REQUEST_TYPE, 'action.hr_submit_leave_request');
    await this.approvals
      .upsertMatrixRule(
        {
          requestTypeCode: LEAVE_REQUEST_TYPE,
          minApprovers: 1,
          requiredPermissionNode: LEAVE_REQUEST_APPROVER_NODE,
          valueThreshold: null,
          orgUnitId: null,
        },
        SYSTEM_ACTOR_ID,
      )
      .catch(() => undefined);

    this.events.subscribe('approval.request.approved', async (payload) => {
      await this.onApprovalApproved(payload as Record<string, unknown>);
    });
  }

  // ---------------------------------------------------------------------------
  // Departments — ADR-059 D1: a thin, permission-gated view over
  // OrganizationService. No HR-owned department table exists any more.
  // ---------------------------------------------------------------------------

  async createDepartment(input: CreateDepartmentInput, actorUserId: string): Promise<OrgUnit> {
    const code = await this.numbering.getNextNumber('hr_department');
    const unit = await this.organization.createUnit('department', input.name, input.parentId ?? null, code);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'hr.department.created',
      resource: 'org_unit',
      resourceId: unit.id,
      result: 'success',
      correlationId: null,
      after: { name: unit.name, code: unit.code },
    });
    return unit;
  }

  async listDepartments(): Promise<OrgUnit[]> {
    return this.organization.listUnitsByType('department');
  }

  async editDepartment(id: string, name: string, actorUserId: string): Promise<OrgUnit> {
    const existing = await this.getDepartmentOrThrow(id);
    const updated = await this.organization.renameUnit(id, name);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'hr.department.edited',
      resource: 'org_unit',
      resourceId: id,
      result: 'success',
      correlationId: null,
      before: { name: existing.name },
      after: { name },
    });
    return updated;
  }

  private async getDepartmentOrThrow(id: string): Promise<OrgUnit> {
    const unit = await this.organization.getUnitById(id);
    if (!unit || unit.type !== 'department') throw new NotFoundException(`Department "${id}" not found.`);
    return unit;
  }

  // ---------------------------------------------------------------------------
  // Employees
  // ---------------------------------------------------------------------------

  async createEmployee(input: CreateEmployeeInput, actorUserId: string): Promise<Employee> {
    if (input.departmentId) {
      await this.getDepartmentOrThrow(input.departmentId);
    }
    const gate = await this.limits.check('hr.max_employees');
    if (!gate.allowed) {
      throw new ConflictException(`Employee limit reached (${gate.max}) — cannot create another employee.`);
    }

    return this.dataSource.transaction(async (manager) => {
      const code = await this.numbering.getNextNumber('hr_employee', manager);
      const repo = manager.getRepository(Employee);
      const saved = await repo.save(
        repo.create({
          code,
          fullName: input.fullName,
          departmentId: input.departmentId ?? null,
          position: input.position ?? null,
          hireDate: input.hireDate ?? null,
          employmentType: input.employmentType ?? null,
          status: 'active',
        }),
      );

      const consumed = await this.limits.consume('hr.max_employees', 1, manager);
      if (!consumed.allowed) {
        throw new ConflictException(`Employee limit reached (${consumed.max}) — cannot create another employee.`);
      }

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'hr.employee.created',
          resource: 'hr_employee',
          resourceId: saved.id,
          result: 'success',
          correlationId: null,
          after: { code: saved.code, fullName: saved.fullName, departmentId: saved.departmentId },
        },
        manager,
      );
      await this.events.publish(manager, 'employee.created', { employeeId: saved.id, code: saved.code });
      return saved;
    });
  }

  /** General field edit (Stage 2/E2E-03) — distinct from `setStatus`/`terminate`/`linkUser`, each of which owns its own narrower audit action and (for terminate/linkUser) its own permission node. */
  async editEmployee(id: string, input: EditEmployeeInput, actorUserId: string): Promise<Employee> {
    const employee = await this.getEmployee(id);
    if (input.departmentId) {
      await this.getDepartmentOrThrow(input.departmentId);
    }
    const before = {
      fullName: employee.fullName,
      departmentId: employee.departmentId,
      position: employee.position,
      hireDate: employee.hireDate,
      employmentType: employee.employmentType,
    };
    if (input.fullName !== undefined) employee.fullName = input.fullName;
    if (input.departmentId !== undefined) employee.departmentId = input.departmentId;
    if (input.position !== undefined) employee.position = input.position;
    if (input.hireDate !== undefined) employee.hireDate = input.hireDate;
    if (input.employmentType !== undefined) employee.employmentType = input.employmentType;
    const saved = await this.employees.save(employee);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'hr.employee.edited',
      resource: 'hr_employee',
      resourceId: id,
      result: 'success',
      correlationId: null,
      before,
      after: { fullName: saved.fullName, departmentId: saved.departmentId, position: saved.position, hireDate: saved.hireDate, employmentType: saved.employmentType },
    });
    return saved;
  }

  /** Stage 2/E2E-05 — the reporting line. `managerId` is a plain self-referential column (same convention as `OrgUnit.parentId`); `null` un-assigns. */
  async assignManager(employeeId: string, managerId: string | null, actorUserId: string): Promise<Employee> {
    const employee = await this.getEmployee(employeeId);
    if (managerId) {
      if (managerId === employeeId) {
        throw new ConflictException('An employee cannot be their own manager.');
      }
      await this.getEmployee(managerId); // throws NotFoundException if the manager id does not resolve to a real employee
    }
    const before = employee.managerId;
    employee.managerId = managerId;
    const saved = await this.employees.save(employee);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'hr.employee.manager_assigned',
      resource: 'hr_employee',
      resourceId: employeeId,
      result: 'success',
      correlationId: null,
      before: { managerId: before },
      after: { managerId },
    });
    return saved;
  }

  async listEmployees(): Promise<Employee[]> {
    return this.employees.find({ order: { fullName: 'ASC' } });
  }

  async getEmployee(id: string): Promise<Employee> {
    const employee = await this.employees.findOne({ where: { id } });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  /** Routine transitions only — `terminated` must go through `terminate()` (ADR-059 D3: its own dedicated, evidenced action). */
  async setStatus(id: string, status: EmployeeStatus, actorUserId: string, reason?: string | null): Promise<Employee> {
    if (status === 'terminated') {
      throw new ConflictException('Use the dedicated terminate action ("hr.employee.terminate") to terminate an employee.');
    }
    const employee = await this.getEmployee(id);
    if (!canTransitionEmployeeStatus(employee.status, status)) {
      throw new ConflictException(`Cannot transition employee status from "${employee.status}" to "${status}".`);
    }
    const fromStatus = employee.status;
    return this.dataSource.transaction(async (manager) => {
      employee.status = status;
      const saved = await manager.getRepository(Employee).save(employee);
      await this.recordStatusChange(manager, fromStatus, status, id, actorUserId, reason ?? null);
      return saved;
    });
  }

  /** ADR-059 D3 — direct, permission-gated (`hr.employee.terminate`), no FA-01. Evidence (date + reason) is captured directly since no approval-request payload carries it. */
  async terminate(id: string, actorUserId: string, reason: string, terminationDate?: string | null): Promise<Employee> {
    const employee = await this.getEmployee(id);
    if (!canTransitionEmployeeStatus(employee.status, 'terminated')) {
      throw new ConflictException(`Cannot terminate an employee whose status is already "${employee.status}".`);
    }
    const fromStatus = employee.status;
    const effectiveDate = terminationDate ?? new Date().toISOString().slice(0, 10);
    return this.dataSource.transaction(async (manager) => {
      employee.status = 'terminated';
      employee.terminationDate = effectiveDate;
      employee.terminationReason = reason;
      const saved = await manager.getRepository(Employee).save(employee);
      await this.recordStatusChange(manager, fromStatus, 'terminated', id, actorUserId, reason);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'hr.employee.terminated',
          resource: 'hr_employee',
          resourceId: id,
          result: 'success',
          correlationId: null,
          after: { terminationDate: effectiveDate, reason },
        },
        manager,
      );
      return saved;
    });
  }

  private async recordStatusChange(
    manager: EntityManager,
    fromStatus: EmployeeStatus,
    toStatus: EmployeeStatus,
    employeeId: string,
    actorUserId: string,
    reason: string | null,
  ): Promise<void> {
    const historyRepo = manager.getRepository(EmployeeStatusHistory);
    await historyRepo.save(historyRepo.create({ employeeId, fromStatus, toStatus, reason, changedByUserId: actorUserId }));
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'hr.employee.status_changed',
        resource: 'hr_employee',
        resourceId: employeeId,
        result: 'success',
        correlationId: null,
        before: { status: fromStatus },
        after: { status: toStatus },
      },
      manager,
    );
  }

  async listStatusHistory(employeeId: string): Promise<EmployeeStatusHistory[]> {
    return this.statusHistory.find({ where: { employeeId }, order: { changedAt: 'DESC' } });
  }

  /** ADR-059 D2 — manual only. Never called by any automatic path (no auto-provisioning anywhere in this service). */
  async linkUser(employeeId: string, userId: string, actorUserId: string): Promise<Employee> {
    const employee = await this.getEmployee(employeeId);
    if (employee.userId) {
      throw new ConflictException(`Employee "${employeeId}" is already linked to a user account.`);
    }
    await this.users.findById(userId); // throws NotFoundException if the target user does not exist
    const alreadyLinked = await this.employees.findOne({ where: { userId } });
    if (alreadyLinked) {
      throw new ConflictException(`User "${userId}" is already linked to another employee.`);
    }
    employee.userId = userId;
    const saved = await this.employees.save(employee);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'hr.employee.user_linked',
      resource: 'hr_employee',
      resourceId: employeeId,
      result: 'success',
      correlationId: null,
      after: { userId },
    });
    return saved;
  }

  // ---------------------------------------------------------------------------
  // Leave requests — HR's first FA-01 consumer. No new approval mechanism.
  // ---------------------------------------------------------------------------

  async submitLeaveRequest(input: SubmitLeaveRequestInput, actorUserId: string): Promise<LeaveRequest> {
    const employee = await this.getEmployee(input.employeeId);
    if (employee.status !== 'active') {
      throw new ConflictException(`Employee "${input.employeeId}" is "${employee.status}" — only an active employee can submit a leave request.`);
    }
    if (input.startDate > input.endDate) {
      throw new ConflictException('startDate must be on or before endDate.');
    }

    const saved = await this.leaveRequests.save(
      this.leaveRequests.create({
        employeeId: input.employeeId,
        leaveType: input.leaveType,
        startDate: input.startDate,
        endDate: input.endDate,
        reason: input.reason ?? null,
        status: 'submitted',
      }),
    );

    // Sequential, not nested in the row's own transaction — same shape as
    // `FiscalPeriodService.submitPeriodClose` (ApprovalEngineService.submit
    // opens its own transaction). A failure here leaves the leave request
    // visible with `approvalRequestId: null`, an inspectable partial state,
    // not a silently lost one.
    const approvalRequest = await this.approvals.submit({
      requestTypeCode: LEAVE_REQUEST_TYPE,
      resourceType: 'leave_request',
      resourceId: saved.id,
      requestedAction: 'approve',
      payload: {
        employeeId: input.employeeId,
        leaveType: input.leaveType,
        startDate: input.startDate,
        endDate: input.endDate,
        reason: input.reason ?? null,
      },
      makerUserId: actorUserId,
    });
    saved.approvalRequestId = approvalRequest.id;
    await this.leaveRequests.save(saved);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'hr.leave_request.submitted',
      resource: 'hr_leave_request',
      resourceId: saved.id,
      result: 'success',
      correlationId: approvalRequest.id,
      after: { employeeId: input.employeeId, leaveType: input.leaveType, startDate: input.startDate, endDate: input.endDate },
    });
    return saved;
  }

  async listLeaveRequests(employeeId?: string): Promise<LeaveRequest[]> {
    return this.leaveRequests.find({ where: employeeId ? { employeeId } : {}, order: { createdAt: 'DESC' } });
  }

  /**
   * Frontend-facing list: enriches each row with its linked `ApprovalRequest`'s own `state`
   * (`pending|approved|rejected|withdrawn|expired`) so "rejected"/"cancelled" — neither of which
   * this table's own `status` column ever holds (see the entity's own doc comment) — are still
   * visible, without duplicating the Approval Engine's state machine here.
   */
  async listLeaveRequestsWithApprovalState(employeeId?: string): Promise<Array<LeaveRequest & { approvalState: string | null }>> {
    const requests = await this.listLeaveRequests(employeeId);
    return Promise.all(
      requests.map(async (r) => {
        if (!r.approvalRequestId) return { ...r, approvalState: null };
        try {
          const approval = await this.approvals.getRequest(r.approvalRequestId);
          return { ...r, approvalState: approval.state };
        } catch {
          return { ...r, approvalState: null };
        }
      }),
    );
  }

  /** Pure pass-through to the generic engine — same shape as every other FA-01 consumer's own `decide` (e.g. `ArAdjustmentService.decide`). */
  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string | null): Promise<unknown> {
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null);
  }

  /** Stage 3 ("cancel where permitted") — reuses `ApprovalEngineService.withdraw`, which already enforces maker-only (`ForbiddenException` otherwise); no new authorization mechanism. Only a still-`submitted` request has anything to withdraw. */
  async cancelLeaveRequest(id: string, actorUserId: string): Promise<LeaveRequest> {
    const leaveRequest = await this.leaveRequests.findOne({ where: { id } });
    if (!leaveRequest) throw new NotFoundException(`Leave request "${id}" not found.`);
    if (leaveRequest.status !== 'submitted' || !leaveRequest.approvalRequestId) {
      throw new ConflictException(`Leave request "${id}" is "${leaveRequest.status}" — only a submitted, pending request can be cancelled.`);
    }
    await this.approvals.withdraw(leaveRequest.approvalRequestId, actorUserId);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'hr.leave_request.cancelled',
      resource: 'hr_leave_request',
      resourceId: id,
      result: 'success',
      correlationId: leaveRequest.approvalRequestId,
    });
    return leaveRequest;
  }

  /** ADR-046 D7 subscriber pattern — check current state first (idempotent against duplicate delivery), ignore any requestTypeCode that is not ours. */
  private async onApprovalApproved(payload: Record<string, unknown>): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== LEAVE_REQUEST_TYPE) return;

    const approvalRequestId = String(payload.approvalRequestId ?? '');
    const resourceId = String(payload.resourceId ?? '');
    const leaveRequest = await this.leaveRequests.findOne({ where: { id: resourceId } });
    if (!leaveRequest || leaveRequest.status === 'approved') return; // not found, or already applied — benign no-op

    leaveRequest.status = 'approved';
    leaveRequest.decidedAt = new Date();
    await this.leaveRequests.save(leaveRequest);

    await this.audit.record({
      actorUserId: SYSTEM_ACTOR_ID,
      organizationId: null,
      action: 'hr.leave_request.approved',
      resource: 'hr_leave_request',
      resourceId: leaveRequest.id,
      result: 'success',
      correlationId: approvalRequestId,
    });
  }
}
