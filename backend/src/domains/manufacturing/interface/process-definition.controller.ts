import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { ProcessDefinitionService } from '../application/process-definition.service';
import type { OperationKind } from '../infrastructure/process-definition.entity';

class OperationTypeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nameAr!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nameEn!: string;

  @IsIn(['transform', 'assembly', 'packing', 'quality', 'disassembly', 'rework', 'other'])
  kind!: OperationKind;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** The body is validated structurally by the service (it owns the graph rules); the DTO only fixes the top-level shape. */
class ProcessBodyDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @IsArray()
  operations!: Array<Record<string, unknown>>;

  @IsArray()
  edges!: Array<Record<string, unknown>>;

  @IsArray()
  inputs!: Array<Record<string, unknown>>;

  @IsArray()
  outputs!: Array<Record<string, unknown>>;
}

/**
 * Manufacturing Engine S3 (D-ME-3) — versioned process definitions (operation graph, inputs with alternates, outputs) and the configurable operation-type catalogue.
 * A process definition generalises the routing, so it reuses the `manufacturing.routing.*` permission nodes. Company-scoped (Area 21 stack).
 */
@Controller('manufacturing/processes')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('manufacturing')
export class ProcessDefinitionController {
  constructor(private readonly processes: ProcessDefinitionService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.view', 'read-only')
  @Get('operation-types')
  async types(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.processes.listOperationTypes(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.edit', 'editable')
  @Post('operation-types')
  async upsertType(@Req() req: CompanyScopedRequest, @Body() dto: OperationTypeDto) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.processes.upsertOperationType(dto.code, dto.nameAr, dto.nameEn, dto.kind, dto.active ?? true, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest, @Query('productId') productId?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.processes.list(productId || null, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.view', 'read-only')
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.processes.get(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.create', 'editable')
  @Post('products/:productId/versions')
  async createDraft(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: ProcessBodyDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.processes.createDraft(productId, dto as never, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.edit', 'editable')
  @Post(':id/save')
  async save(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProcessBodyDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.processes.saveDraft(id, dto as never, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.create', 'editable')
  @Post(':id/clone')
  async clone(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.processes.clone(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.edit', 'editable')
  @Post(':id/activate')
  async activate(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.processes.activate(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.delete', 'editable')
  @Delete(':id')
  async remove(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    await this.processes.deleteDraft(id, req.companyContext.dataSource.manager);
    return { ok: true };
  }
}
