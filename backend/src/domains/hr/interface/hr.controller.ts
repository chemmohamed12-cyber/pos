import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { HrService } from '../application/hr.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { EmployeeStatus } from '../domain/employee-status';
import { EmploymentType } from '../domain/employment-type';

class CreateDepartmentDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

class EditDepartmentDto {
  @IsString()
  @MinLength(1)
  name!: string;
}

class CreateEmployeeDto {
  @IsString()
  @MinLength(1)
  fullName!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsString()
  position?: string;

  @IsOptional()
  @IsISO8601()
  hireDate?: string;

  @IsOptional()
  @IsIn(['full_time', 'part_time', 'contractor'])
  employmentType?: EmploymentType;
}

class EditEmployeeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  fullName?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string | null;

  @IsOptional()
  @IsString()
  position?: string | null;

  @IsOptional()
  @IsISO8601()
  hireDate?: string | null;

  @IsOptional()
  @IsIn(['full_time', 'part_time', 'contractor'])
  employmentType?: EmploymentType | null;
}

class AssignManagerDto {
  @IsOptional()
  @IsUUID()
  managerId?: string | null;
}

class SetEmployeeStatusDto {
  @IsIn(['active', 'on_leave'])
  status!: Exclude<EmployeeStatus, 'terminated'>;

  @IsOptional()
  @IsString()
  reason?: string;
}

class TerminateEmployeeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;

  @IsOptional()
  @IsISO8601()
  terminationDate?: string;
}

class LinkUserDto {
  @IsUUID()
  userId!: string;
}

class SubmitLeaveRequestDto {
  @IsUUID()
  employeeId!: string;

  @IsString()
  @MinLength(1)
  leaveType!: string;

  @IsISO8601()
  startDate!: string;

  @IsISO8601()
  endDate!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

class DecideLeaveRequestDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

/**
 * ERP Foundation — P9 (ADR-029), expanded under ADR-059 (HR Phase 1).
 * Every route requires the module to be entitled (`@RequireModule('hr')`);
 * writes additionally require the matching `hr.*` permission node.
 */
@Controller('hr')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('hr')
export class HrController {
  constructor(private readonly hr: HrService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.department.create', 'editable')
  @Post('departments')
  async createDepartment(@Body() dto: CreateDepartmentDto, @Req() req: CompanyScopedRequest) {
    return this.hr.createDepartment(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.department.view', 'read-only')
  @Get('departments')
  async listDepartments(@Req() req: CompanyScopedRequest) {
    return this.hr.listDepartments(req.companyContext!.dataSource.manager);
  }

  /** ADR-059 (HR Phase 1) — the previously-declared-but-unwired `hr.department.edit` node, now wired. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.department.edit', 'editable')
  @Post('departments/:id')
  async editDepartment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EditDepartmentDto, @Req() req: CompanyScopedRequest) {
    return this.hr.editDepartment(id, dto.name, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.create', 'editable')
  @Post('employees')
  async createEmployee(@Body() dto: CreateEmployeeDto, @Req() req: CompanyScopedRequest) {
    return this.hr.createEmployee(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.view', 'read-only')
  @Get('employees')
  async listEmployees(@Req() req: CompanyScopedRequest) {
    return this.hr.listEmployees(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.view', 'read-only')
  @Get('employees/:id')
  async getEmployee(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.hr.getEmployee(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.view', 'read-only')
  @Get('employees/:id/status-history')
  async listStatusHistory(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.hr.listStatusHistory(id, req.companyContext!.dataSource.manager);
  }

  /** General field edit (Stage 2/E2E-03) — distinct from status/terminate/link-user, each with its own narrower audit action. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.edit', 'editable')
  @Post('employees/:id')
  async editEmployee(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EditEmployeeDto, @Req() req: CompanyScopedRequest) {
    return this.hr.editEmployee(id, dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  /** Stage 2/E2E-05 — the reporting line. Same permission node as any other routine employee edit. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.edit', 'editable')
  @Post('employees/:id/manager')
  async assignManager(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignManagerDto, @Req() req: CompanyScopedRequest) {
    return this.hr.assignManager(id, dto.managerId ?? null, req.user.id, req.companyContext!.dataSource.manager);
  }

  /** Routine transitions only — `terminated` is refused here (service-enforced); use `.../terminate`. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.edit', 'editable')
  @Post('employees/:id/status')
  async setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetEmployeeStatusDto, @Req() req: CompanyScopedRequest) {
    return this.hr.setStatus(id, dto.status, req.user.id, dto.reason, req.companyContext!.dataSource.manager);
  }

  /** ADR-059 D3 — its own dedicated node, direct action, no FA-01. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.terminate', 'editable')
  @Post('employees/:id/terminate')
  async terminate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TerminateEmployeeDto, @Req() req: CompanyScopedRequest) {
    return this.hr.terminate(id, req.user.id, dto.reason, dto.terminationDate, req.companyContext!.dataSource.manager);
  }

  /** ADR-059 D2 — manual Admin action, its own dedicated node. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.link_user', 'editable')
  @Post('employees/:id/link-user')
  async linkUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkUserDto, @Req() req: CompanyScopedRequest) {
    return this.hr.linkUser(id, dto.userId, req.user.id, req.companyContext!.dataSource.manager, req.companyContext!.companyId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.leave_request.create', 'editable')
  @Post('leave-requests')
  async submitLeaveRequest(@Body() dto: SubmitLeaveRequestDto, @Req() req: CompanyScopedRequest) {
    return this.hr.submitLeaveRequest(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  /** Enriched with the linked `ApprovalRequest`'s own `state` so "rejected"/"cancelled" are visible — see `HrService.listLeaveRequestsWithApprovalState`'s own doc comment. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.leave_request.view', 'read-only')
  @Get('leave-requests')
  async listLeaveRequests(@Req() req: CompanyScopedRequest, @Query('employeeId') employeeId?: string) {
    return this.hr.listLeaveRequestsWithApprovalState(employeeId, req.companyContext!.dataSource.manager);
  }

  /** Same shape as every other FA-01 consumer's own decide wrapper (e.g. `ArController.decide`) — gated by the domain-specific checker node, not the generic one. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.leave_request.approve', 'editable')
  @Post('leave-requests/:id/decide')
  async decideLeaveRequest(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideLeaveRequestDto, @Req() req: CompanyScopedRequest) {
    return this.hr.decide(id, req.user.id, dto.decision, dto.note, req.companyContext!.dataSource.manager);
  }

  /** Stage 3 ("cancel where permitted") — gated by the same submit-side permission; `ApprovalEngineService.withdraw` itself enforces maker-only. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.leave_request.create', 'editable')
  @Post('leave-requests/:id/cancel')
  async cancelLeaveRequest(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.hr.cancelLeaveRequest(id, req.user.id, req.companyContext!.dataSource.manager);
  }
}
