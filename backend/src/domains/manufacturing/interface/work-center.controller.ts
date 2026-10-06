import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { WorkCenterService } from '../application/work-center.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateWorkCenterDto {
  @IsString()
  @MaxLength(32)
  code!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

class UpdateWorkCenterDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

/** ADR-061 Addendum 1 (A1) — Work Center master data (assignment only; no capacity/labor/cost). Company-scoped (Area 21 stack). */
@Controller('manufacturing/work-centers')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('manufacturing')
export class WorkCenterController {
  constructor(private readonly workCenters: WorkCenterService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.work_center.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.workCenters.list(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.work_center.view', 'read-only')
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.workCenters.getOrThrow(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.work_center.create', 'editable')
  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateWorkCenterDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workCenters.create(dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.work_center.edit', 'editable')
  @Post(':id')
  async update(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWorkCenterDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workCenters.update(id, dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.work_center.delete', 'editable')
  @Delete(':id')
  async remove(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.workCenters.remove(id, req.user.id, req.companyContext.dataSource.manager);
    return { removed: true };
  }
}
