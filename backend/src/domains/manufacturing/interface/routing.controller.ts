import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { RoutingService } from '../application/routing.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class RoutingOperationDto {
  @IsInt()
  @Min(1)
  sequence!: number;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsUUID()
  workCenterId!: string;
}

class DefineRoutingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RoutingOperationDto)
  operations!: RoutingOperationDto[];
}

class SetRoutingStatusDto {
  @IsIn(['active', 'inactive'])
  status!: 'active' | 'inactive';
}

/**
 * ADR-061 Addendum 1 (A1) — Routing / Operations master data (sequencing only; no labor/machine
 * hours, rates, overhead or cost — ADR-060 D2/D3). Company-scoped (Area 21 stack).
 */
@Controller('manufacturing/routings')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('manufacturing')
export class RoutingController {
  constructor(private readonly routings: RoutingService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.routings.list(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.view', 'read-only')
  @Get(':productId')
  async get(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const routing = await this.routings.get(productId, req.companyContext.dataSource.manager);
    if (!routing) throw new NotFoundException(`No routing defined for product "${productId}".`);
    return routing;
  }

  /** Create a NEW routing (409 if one already exists — replacing needs `manufacturing.routing.edit`). */
  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.create', 'editable')
  @Post(':productId')
  async create(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: DefineRoutingDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    if (await this.routings.get(productId, manager)) throw new ConflictException(`Product "${productId}" already has a routing — edit it instead.`);
    return this.routings.define(productId, dto.operations, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.edit', 'editable')
  @Post(':productId/replace')
  async replace(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: DefineRoutingDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    if (!(await this.routings.get(productId, manager))) throw new NotFoundException(`No routing defined for product "${productId}".`);
    return this.routings.define(productId, dto.operations, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.edit', 'editable')
  @Post(':productId/status')
  async setStatus(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: SetRoutingStatusDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.routings.setStatus(productId, dto.status, req.user.id, req.companyContext.dataSource.manager);
    return { ok: true, status: dto.status };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.routing.delete', 'editable')
  @Delete(':productId')
  async remove(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.routings.remove(productId, req.user.id, req.companyContext.dataSource.manager);
    return { removed: true };
  }
}
