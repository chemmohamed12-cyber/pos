import { ConflictException, Injectable, InternalServerErrorException, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource, EntityManager, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
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
import { MembershipService } from '../../../foundation/company/membership.service';

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
 *
 * Area 21 (2026-10-05, CTO-authorized): Company-scoped. EVERY public method takes an
 * optional trailing `manager`. With none, behaviour is the previous ambient/Platform one
 * (unchanged). With a Company `manager` (`req.companyContext.dataSource.manager`, or a
 * transaction manager derived from it) employees, departments (OrgUnit), status history and
 * leave requests are read and written in THAT Company's own database, codes are issued from
 * that Company's own numbering sequences, and the leave-request approval — a request in that
 * Company's own Approval Engine — applies back to that Company's row through a `'company'`
 * scope subscriber (ADR-075), never against another Company. `UsersService` stays ambient on
 * purpose: a User is Platform identity, not Company data.
 */
@Injectable()
export class HrService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly limits: LimitService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly organization: OrganizationService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalEngineService,
    private readonly users: UsersService,
    /** B-1 — the Platform `Membership` source of truth. Optional only so pre-existing manual constructions keep compiling; a Company-scoped link without it fails closed (see `assertActiveCompanyMember`). */
    @Optional() private readonly memberships?: MembershipService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  /** The two HR document types are registered at boot in the ambient DB; a Company's own database gets them on first use (idempotent). */
  private async ensureNumbering(manager?: EntityManager): Promise<void> {
    if (!manager) return;
    await this.numbering.registerDocumentType('hr_employee', 'EMP', true, manager);
    await this.numbering.registerDocumentType('hr_department', 'DEPT', false, manager);
  }

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

    // Company scope (ADR-075): runs for the Company outbox it was published in (ctx.manager), and — unchanged — for the ambient outbox.
    this.events.subscribe(
      'approval.request.approved',
      async (payload, ctx) => {
        await this.onApprovalApproved(payload as Record<string, unknown>, ctx.manager ?? undefined);
      },
      { scope: 'company' },
    );
  }

  // ---------------------------------------------------------------------------
  // Departments — ADR-059 D1: a thin, permission-gated view over
  // OrganizationService. No HR-owned department table exists any more.
  // ---------------------------------------------------------------------------

  async createDepartment(input: CreateDepartmentInput, actorUserId: string, manager?: EntityManager): Promise<OrgUnit> {
    await this.ensureNumbering(manager);
    const code = await this.numbering.getNextNumber('hr_department', manager);
    const unit = await this.organization.createUnit('department', input.name, input.parentId ?? null, code, manager);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'hr.department.created',
        resource: 'org_unit',
        resourceId: unit.id,
        result: 'success',
        correlationId: null,
        after: { name: unit.name, code: unit.code },
      },
      manager,
    );
    return unit;
  }

  async listDepartments(manager?: EntityManager): Promise<OrgUnit[]> {
    return this.organization.listUnitsByType('department', manager);
  }

  async editDepartment(id: string, name: string, actorUserId: string, manager?: EntityManager): Promise<OrgUnit> {
    const existing = await this.getDepartmentOrThrow(id, manager);
    const updated = await this.organization.renameUnit(id, name, manager);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'hr.department.edited',
        resource: 'org_unit',
        resourceId: id,
        result: 'success',
        correlationId: null,
        before: { name: existing.name },
        after: { name },
      },
      manager,
    );
    return updated;
  }

  private async getDepartmentOrThrow(id: string, manager?: EntityManager): Promise<OrgUnit> {
    const unit = await this.organization.getUnitById(id, manager);
    if (!unit || unit.type !== 'department') throw new NotFoundException(`Department "${id}" not found.`);
    return unit;
  }

  // ---------------------------------------------------------------------------
  // Employees
  // ---------------------------------------------------------------------------

  async createEmployee(input: CreateEmployeeInput, actorUserId: string, manager?: EntityManager): Promise<Employee> {
    if (input.departmentId) {
      await this.getDepartmentOrThrow(input.departmentId, manager);
    }
    const gate = await this.limits.check('hr.max_employees', 1, manager);
    if (!gate.allowed) {
      throw new ConflictException(`Employee limit reached (${gate.max}) — cannot create another employee.`);
    }
    await this.ensureNumbering(manager);

    return this.em(manager).transaction(async (tx) => {
      const code = await this.numbering.getNextNumber('hr_employee', tx);
      const repo = tx.getRepository(Employee);
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

      const consumed = await this.limits.consume('hr.max_employees', 1, tx);
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
        tx,
      );
      await this.events.publish(tx, 'employee.created', { employeeId: saved.id, code: saved.code });
      return saved;
    });
  }

  /** General field edit (Stage 2/E2E-03) — distinct from `setStatus`/`terminate`/`linkUser`, each of which owns its own narrower audit action and (for terminate/linkUser) its own permission node. */
  async editEmployee(id: string, input: EditEmployeeInput, actorUserId: string, manager?: EntityManager): Promise<Employee> {
    const employee = await this.getEmployee(id, manager);
    if (input.departmentId) {
      await this.getDepartmentOrThrow(input.departmentId, manager);
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
    const saved = await this.em(manager).getRepository(Employee).save(employee);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'hr.employee.edited',
        resource: 'hr_employee',
        resourceId: id,
        result: 'success',
        correlationId: null,
        before,
        after: { fullName: saved.fullName, departmentId: saved.departmentId, position: saved.position, hireDate: saved.hireDate, employmentType: saved.employmentType },
      },
      manager,
    );
    return saved;
  }

  /** Stage 2/E2E-05 — the reporting line. `managerId` is a plain self-referential column (same convention as `OrgUnit.parentId`); `null` un-assigns. */
  async assignManager(employeeId: string, managerId: string | null, actorUserId: string, manager?: EntityManager): Promise<Employee> {
    const employee = await this.getEmployee(employeeId, manager);
    if (managerId) {
      if (managerId === employeeId) {
        throw new ConflictException('An employee cannot be their own manager.');
      }
      await this.getEmployee(managerId, manager); // throws NotFoundException if the manager id does not resolve to a real employee
    }
    const before = employee.managerId;
    employee.managerId = managerId;
    const saved = await this.em(manager).getRepository(Employee).save(employee);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'hr.employee.manager_assigned',
        resource: 'hr_employee',
        resourceId: employeeId,
        result: 'success',
        correlationId: null,
        before: { managerId: before },
        after: { managerId },
      },
      manager,
    );
    return saved;
  }

  async listEmployees(manager?: EntityManager): Promise<Employee[]> {
    return this.em(manager).getRepository(Employee).find({ order: { fullName: 'ASC' } });
  }

  async getEmployee(id: string, manager?: EntityManager): Promise<Employee> {
    const employee = await this.em(manager).getRepository(Employee).findOne({ where: { id } });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  /** ADR-071 §9 — the one additive, read-only method Commission's own Sales Rep resolution requires: `CustomerAssignment.salesRepUserId` (a `User`) reverse-resolved to the authoritative `Employee`. Returns `null` (never throws) when no `Employee.userId` link exists yet — the caller decides how to treat an unresolvable Sales Rep, this method never guesses. */
  async getEmployeeByUserId(userId: string, manager?: EntityManager): Promise<Employee | null> {
    return this.em(manager).getRepository(Employee).findOne({ where: { userId } });
  }

  /** Routine transitions only — `terminated` must go through `terminate()` (ADR-059 D3: its own dedicated, evidenced action). */
  async setStatus(id: string, status: EmployeeStatus, actorUserId: string, reason?: string | null, manager?: EntityManager): Promise<Employee> {
    if (status === 'terminated') {
      throw new ConflictException('Use the dedicated terminate action ("hr.employee.terminate") to terminate an employee.');
    }
    const employee = await this.getEmployee(id, manager);
    if (!canTransitionEmployeeStatus(employee.status, status)) {
      throw new ConflictException(`Cannot transition employee status from "${employee.status}" to "${status}".`);
    }
    const fromStatus = employee.status;
    return this.em(manager).transaction(async (tx) => {
      employee.status = status;
      const saved = await tx.getRepository(Employee).save(employee);
      await this.recordStatusChange(tx, fromStatus, status, id, actorUserId, reason ?? null);
      return saved;
    });
  }

  /** ADR-059 D3 — direct, permission-gated (`hr.employee.terminate`), no FA-01. Evidence (date + reason) is captured directly since no approval-request payload carries it. */
  async terminate(id: string, actorUserId: string, reason: string, terminationDate?: string | null, manager?: EntityManager): Promise<Employee> {
    const employee = await this.getEmployee(id, manager);
    if (!canTransitionEmployeeStatus(employee.status, 'terminated')) {
      throw new ConflictException(`Cannot terminate an employee whose status is already "${employee.status}".`);
    }
    const fromStatus = employee.status;
    const effectiveDate = terminationDate ?? new Date().toISOString().slice(0, 10);
    return this.em(manager).transaction(async (tx) => {
      employee.status = 'terminated';
      employee.terminationDate = effectiveDate;
      employee.terminationReason = reason;
      const saved = await tx.getRepository(Employee).save(employee);
      await this.recordStatusChange(tx, fromStatus, 'terminated', id, actorUserId, reason);
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
        tx,
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

  async listStatusHistory(employeeId: string, manager?: EntityManager): Promise<EmployeeStatusHistory[]> {
    return this.em(manager).getRepository(EmployeeStatusHistory).find({ where: { employeeId }, order: { changedAt: 'DESC' } });
  }

  /**
   * B-1 — same-Company membership, enforced on the server. A User is Platform identity, so "exists" is not enough: only a User with an ACTIVE
   * `Membership` in THIS Company (not invited / suspended / removed / expired) may be linked to one of its Employees.
   * Company mode (a Company `manager` was passed) REQUIRES `companyId` and fails closed without it or without the membership source;
   * the ambient/Platform mode (no `manager`) has no Company, hence no membership to check (unchanged behaviour).
   * Returns the membership id for the audit record (null in ambient mode).
   */
  private async assertActiveCompanyMember(userId: string, manager?: EntityManager, companyId?: string): Promise<string | null> {
    if (!manager) return null;
    if (!companyId || !this.memberships) {
      throw new InternalServerErrorException('Company membership cannot be verified for this operation (no Company context) — the link was refused.');
    }
    const membership = await this.memberships.findActiveByUserAndCompany(userId, companyId);
    if (!membership) {
      throw new ConflictException(`User "${userId}" is not an active member of this Company and cannot be linked to an employee.`);
    }
    return membership.id;
  }

  /** G-09 — who a Company's HR officer can link: ACTIVE members of THIS Company (Platform membership) not yet linked to an employee here. Never the platform's whole user list. */
  async listLinkCandidates(companyId: string, manager: EntityManager): Promise<Array<{ id: string; email: string; fullName: string }>> {
    if (!this.memberships) throw new InternalServerErrorException('Company membership cannot be read for this operation.');
    const active = (await this.memberships.findByCompany(companyId)).filter((m) => m.status === 'active');
    if (active.length === 0) return [];
    const linked = new Set((await manager.getRepository(Employee).find({ select: { userId: true } })).map((e) => e.userId).filter((u): u is string => !!u));
    const users = await this.users.findByIds(active.map((m) => m.userId).filter((id) => !linked.has(id)));
    return users.map((u) => ({ id: u.id, email: u.email, fullName: u.fullName })).sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  /** ADR-059 D2 — manual only. Never called by any automatic path (no auto-provisioning anywhere in this service). */
  async linkUser(employeeId: string, userId: string, actorUserId: string, manager?: EntityManager, companyId?: string): Promise<Employee> {
    const employee = await this.getEmployee(employeeId, manager);
    if (employee.userId) {
      throw new ConflictException(`Employee "${employeeId}" is already linked to a user account.`);
    }
    await this.users.findById(userId); // throws NotFoundException if the target user does not exist (a User is Platform identity — ambient on purpose)
    const membershipId = await this.assertActiveCompanyMember(userId, manager, companyId);
    const repo = this.em(manager).getRepository(Employee);
    const alreadyLinked = await repo.findOne({ where: { userId } });
    if (alreadyLinked) {
      throw new ConflictException(`User "${userId}" is already linked to another employee.`);
    }
    employee.userId = userId;
    const saved = await repo.save(employee);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'hr.employee.user_linked',
        resource: 'hr_employee',
        resourceId: employeeId,
        result: 'success',
        correlationId: null,
        after: membershipId ? { userId, membershipId } : { userId },
      },
      manager,
    );
    return saved;
  }

  // ---------------------------------------------------------------------------
  // Leave requests — HR's first FA-01 consumer. No new approval mechanism.
  // ---------------------------------------------------------------------------

  async submitLeaveRequest(input: SubmitLeaveRequestInput, actorUserId: string, manager?: EntityManager): Promise<LeaveRequest> {
    const employee = await this.getEmployee(input.employeeId, manager);
    if (employee.status !== 'active') {
      throw new ConflictException(`Employee "${input.employeeId}" is "${employee.status}" — only an active employee can submit a leave request.`);
    }
    if (input.startDate > input.endDate) {
      throw new ConflictException('startDate must be on or before endDate.');
    }

    const leaveRepo = this.em(manager).getRepository(LeaveRequest);
    const saved = await leaveRepo.save(
      leaveRepo.create({
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
    const approvalRequest = await this.approvals.submit(
      {
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
      },
      manager,
    );
    saved.approvalRequestId = approvalRequest.id;
    await leaveRepo.save(saved);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'hr.leave_request.submitted',
        resource: 'hr_leave_request',
        resourceId: saved.id,
        result: 'success',
        correlationId: approvalRequest.id,
        after: { employeeId: input.employeeId, leaveType: input.leaveType, startDate: input.startDate, endDate: input.endDate },
      },
      manager,
    );
    return saved;
  }

  async listLeaveRequests(employeeId?: string, manager?: EntityManager): Promise<LeaveRequest[]> {
    return this.em(manager).getRepository(LeaveRequest).find({ where: employeeId ? { employeeId } : {}, order: { createdAt: 'DESC' } });
  }

  /**
   * ADR-065 (Attendance Phase 1) — the one additive, read-only method
   * this ratified `ADR-063 §3: B` decision needs. Does not change any
   * existing HR Phase 1 behavior, endpoint, or ratified D1-D4 decision;
   * `LeaveRequest.status` only ever holds `'approved'` once the FA-01
   * subscriber (`onApprovalApproved`, above) has actually applied it, so
   * this is a plain, already-consistent field check — no new state.
   */
  async isApprovedLeaveDate(employeeId: string, calendarDate: string, manager?: EntityManager): Promise<boolean> {
    const count = await this.em(manager).getRepository(LeaveRequest).count({
      where: {
        employeeId,
        status: 'approved',
        startDate: LessThanOrEqual(calendarDate),
        endDate: MoreThanOrEqual(calendarDate),
      },
    });
    return count > 0;
  }

  /**
   * Frontend-facing list: enriches each row with its linked `ApprovalRequest`'s own `state`
   * (`pending|approved|rejected|withdrawn|expired`) so "rejected"/"cancelled" — neither of which
   * this table's own `status` column ever holds (see the entity's own doc comment) — are still
   * visible, without duplicating the Approval Engine's state machine here.
   */
  async listLeaveRequestsWithApprovalState(employeeId?: string, manager?: EntityManager): Promise<Array<LeaveRequest & { approvalState: string | null }>> {
    const requests = await this.listLeaveRequests(employeeId, manager);
    return Promise.all(
      requests.map(async (r) => {
        if (!r.approvalRequestId) return { ...r, approvalState: null };
        try {
          const approval = await this.approvals.getRequest(r.approvalRequestId, manager);
          return { ...r, approvalState: approval.state };
        } catch {
          return { ...r, approvalState: null };
        }
      }),
    );
  }

  /** Pure pass-through to the generic engine — same shape as every other FA-01 consumer's own `decide` (e.g. `ArAdjustmentService.decide`). */
  async decide(requestId: string, approverUserId: string, decision: 'approved' | 'rejected', note?: string | null, manager?: EntityManager): Promise<unknown> {
    return this.approvals.decide(requestId, approverUserId, decision, note ?? null, manager);
  }

  /** Stage 3 ("cancel where permitted") — reuses `ApprovalEngineService.withdraw`, which already enforces maker-only (`ForbiddenException` otherwise); no new authorization mechanism. Only a still-`submitted` request has anything to withdraw. */
  async cancelLeaveRequest(id: string, actorUserId: string, manager?: EntityManager): Promise<LeaveRequest> {
    const leaveRequest = await this.em(manager).getRepository(LeaveRequest).findOne({ where: { id } });
    if (!leaveRequest) throw new NotFoundException(`Leave request "${id}" not found.`);
    if (leaveRequest.status !== 'submitted' || !leaveRequest.approvalRequestId) {
      throw new ConflictException(`Leave request "${id}" is "${leaveRequest.status}" — only a submitted, pending request can be cancelled.`);
    }
    await this.approvals.withdraw(leaveRequest.approvalRequestId, actorUserId, manager);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'hr.leave_request.cancelled',
        resource: 'hr_leave_request',
        resourceId: id,
        result: 'success',
        correlationId: leaveRequest.approvalRequestId,
      },
      manager,
    );
    return leaveRequest;
  }

  /** ADR-046 D7 subscriber pattern — check current state first (idempotent against duplicate delivery), ignore any requestTypeCode that is not ours. */
  private async onApprovalApproved(payload: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    const requestTypeCode = String(payload.requestTypeCode ?? '');
    if (requestTypeCode !== LEAVE_REQUEST_TYPE) return;

    const approvalRequestId = String(payload.approvalRequestId ?? '');
    const resourceId = String(payload.resourceId ?? '');
    const repo = this.em(manager).getRepository(LeaveRequest);
    const leaveRequest = await repo.findOne({ where: { id: resourceId } });
    if (!leaveRequest || leaveRequest.status === 'approved') return; // not found, or already applied — benign no-op

    leaveRequest.status = 'approved';
    leaveRequest.decidedAt = new Date();
    await repo.save(leaveRequest);

    await this.audit.record(
      {
        actorUserId: SYSTEM_ACTOR_ID,
        organizationId: null,
        action: 'hr.leave_request.approved',
        resource: 'hr_leave_request',
        resourceId: leaveRequest.id,
        result: 'success',
        correlationId: approvalRequestId,
      },
      manager,
    );
  }
}
