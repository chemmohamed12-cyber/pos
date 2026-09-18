import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { HrService } from '../application/hr.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { EmployeeStatus } from '../domain/employee-status';

class CreateDepartmentDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;
}

class CreateEmployeeDto {
  @IsString()
  @MinLength(1)
  code!: string;

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
  @IsString()
  hireDate?: string;
}

class SetEmployeeStatusDto {
  @IsIn(['active', 'on_leave', 'terminated'])
  status!: EmployeeStatus;
}

/**
 * ERP Foundation — P9 (ADR-029). `hr`'s only controller — every route
 * requires the module to be entitled (`@RequireModule('hr')`, the exact
 * same guard every other domain controller uses); writes additionally
 * require the matching `hr.*` permission node, same pattern as
 * `CustomersController`.
 */
@Controller('hr')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('hr')
export class HrController {
  constructor(private readonly hr: HrService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.department.create', 'editable')
  @Post('departments')
  async createDepartment(@Body() dto: CreateDepartmentDto) {
    return this.hr.createDepartment(dto);
  }

  /**
   * Commercial Release Gate finding SEC-07 (found by the red-team harness,
   * RT05-1): reads were originally module-gated only, following the
   * prevailing house pattern for "broadly-available reads." That default is
   * wrong for HR specifically — employee records are personal data (name,
   * position, department, hire date), so a zero-role authenticated user must
   * not be able to enumerate them. Read routes now require the `.view` nodes
   * that `hr.manifest.ts` already declared but nothing was wired to.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.department.view', 'read-only')
  @Get('departments')
  async listDepartments() {
    return this.hr.listDepartments();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.create', 'editable')
  @Post('employees')
  async createEmployee(@Body() dto: CreateEmployeeDto) {
    return this.hr.createEmployee(dto);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.view', 'read-only')
  @Get('employees')
  async listEmployees() {
    return this.hr.listEmployees();
  }

  /** `ParseUUIDPipe` — SEC-06: a malformed id must be a clean 400, never a 500 from the DB driver. */
  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.view', 'read-only')
  @Get('employees/:id')
  async getEmployee(@Param('id', ParseUUIDPipe) id: string) {
    return this.hr.getEmployee(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('hr.employee.edit', 'editable')
  @Post('employees/:id/status')
  async setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetEmployeeStatusDto) {
    return this.hr.setStatus(id, dto.status);
  }
}
