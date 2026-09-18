import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { HrService } from '../application/hr.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
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
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('hr')
export class HrController {
  constructor(private readonly hr: HrService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.department.create', 'editable')
  @Post('departments')
  async createDepartment(@Body() dto: CreateDepartmentDto, @Req() req: AuthenticatedRequest) {
    return this.hr.createDepartment(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.department.view', 'read-only')
  @Get('departments')
  async listDepartments() {
    return this.hr.listDepartments();
  }

  /** ADR-059 (HR Phase 1) — the previously-declared-but-unwired `hr.department.edit` node, now wired. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.department.edit', 'editable')
  @Post('departments/:id')
  async editDepartment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EditDepartmentDto, @Req() req: AuthenticatedRequest) {
    return this.hr.editDepartment(id, dto.name, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.create', 'editable')
  @Post('employees')
  async createEmployee(@Body() dto: CreateEmployeeDto, @Req() req: AuthenticatedRequest) {
    return this.hr.createEmployee(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.view', 'read-only')
  @Get('employees')
  async listEmployees() {
    return this.hr.listEmployees();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.view', 'read-only')
  @Get('employees/:id')
  async getEmployee(@Param('id', ParseUUIDPipe) id: string) {
    return this.hr.getEmployee(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.view', 'read-only')
  @Get('employees/:id/status-history')
  async listStatusHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.hr.listStatusHistory(id);
  }

  /** Routine transitions only — `terminated` is refused here (service-enforced); use `.../terminate`. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.edit', 'editable')
  @Post('employees/:id/status')
  async setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetEmployeeStatusDto, @Req() req: AuthenticatedRequest) {
    return this.hr.setStatus(id, dto.status, req.user.id, dto.reason);
  }

  /** ADR-059 D3 — its own dedicated node, direct action, no FA-01. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.terminate', 'editable')
  @Post('employees/:id/terminate')
  async terminate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TerminateEmployeeDto, @Req() req: AuthenticatedRequest) {
    return this.hr.terminate(id, req.user.id, dto.reason, dto.terminationDate);
  }

  /** ADR-059 D2 — manual Admin action, its own dedicated node. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.link_user', 'editable')
  @Post('employees/:id/link-user')
  async linkUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkUserDto, @Req() req: AuthenticatedRequest) {
    return this.hr.linkUser(id, dto.userId, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.leave_request.create', 'editable')
  @Post('leave-requests')
  async submitLeaveRequest(@Body() dto: SubmitLeaveRequestDto, @Req() req: AuthenticatedRequest) {
    return this.hr.submitLeaveRequest(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.leave_request.view', 'read-only')
  @Get('leave-requests')
  async listLeaveRequests(@Query('employeeId') employeeId?: string) {
    return this.hr.listLeaveRequests(employeeId);
  }

  /** Same shape as every other FA-01 consumer's own decide wrapper (e.g. `ArController.decide`) — gated by the domain-specific checker node, not the generic one. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.leave_request.approve', 'editable')
  @Post('leave-requests/:id/decide')
  async decideLeaveRequest(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideLeaveRequestDto, @Req() req: AuthenticatedRequest) {
    return this.hr.decide(id, req.user.id, dto.decision, dto.note);
  }
}
