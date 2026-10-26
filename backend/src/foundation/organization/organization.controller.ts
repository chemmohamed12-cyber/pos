import { BadRequestException, Body, Controller, Delete, Get, Optional, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { OrganizationService } from './organization.service';
import { OrgUnitType } from './org-unit.entity';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';
import { COMPANY_ORGANIZATION_MANAGE_NODE } from '../permission/company-nodes';
import { CompanyContextGuard, CompanyScopedRequest } from '../company/company-context.guard';
import { CompanyUserError } from '../company/company-user-roles';

class CreateUnitDto {
  @IsIn(['company', 'branch', 'department', 'team', 'warehouse'])
  type!: OrgUnitType;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

class UpdateUnitDto {
  @IsOptional()
  @IsString()
  name?: string;

  /** `null` moves the unit to the top level; omitted = unchanged. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  parentId?: string | null;
}

class ArchiveUnitDto {
  /** The impact summary was shown and the user confirmed. */
  @IsBoolean()
  confirm!: boolean;
}

class ReconcileRootDto {
  @IsString()
  canonicalId!: string;

  @IsOptional()
  @IsString()
  rename?: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

class AssignMemberDto {
  @IsString()
  userId!: string;
}

/**
 * Organization — Stage 2 build-order item 10. This HTTP interface layer
 * did not exist until the operational UI needed it (Organization had
 * only ever been consumed internally, never over the wire) — no service
 * logic changes, just the standard thin controller wrapper every other
 * domain already has.
 */
@Controller('organization')
/**
 * Authorization Program F1.5 (finding F-1 / AZ-03) — the org tree is COMPANY-owned data. Before this change the controller had `JwtAuthGuard` only and
 * every route read/wrote the AMBIENT (platform) org tables: any authenticated user, whatever Company they had selected, could read the platform tree
 * and its member ids. Now: JWT -> `CompanyContextGuard` (membership + Company status validated) -> the Company's OWN DataSource; the ambient tables are
 * never reached over HTTP. Authorization semantics are otherwise unchanged (reads: any Company member, as before; writes: role `admin` — now resolved
 * from the Company's roles via the guard chain). Redesigning the Organization module is out of scope for F1.
 * CTO ruling B1 (2026-10-08): writes require the Company ADMINISTRATION node `core.company.organization.manage` (formerly the workflow rule
 * `core.organization.manage`). An org-unit membership is a SCOPE SOURCE (`AccessScopeService`), so nobody may add THEMSELVES to a unit (no self-elevation,
 * same rule as `SELF_SCOPE_CHANGE` on explicit grants); removing oneself is narrowing and stays allowed.
 */
@UseGuards(JwtAuthGuard, CompanyContextGuard)
export class OrganizationController {
  constructor(
    private readonly organization: OrganizationService,
    /** Optional so the controller can still be built by hand in isolation specs; always provided by the module. */
    @Optional() private readonly audit?: AuditService,
  ) {}

  private async record(req: CompanyScopedRequest, action: string, unitId: string, before: unknown, after: unknown): Promise<void> {
    await this.audit?.record({ actorUserId: req.user?.id ?? null, organizationId: null, action, resource: 'org_unit', resourceId: unitId, result: 'success', correlationId: null, before: before as never, after: after as never }, this.manager(req));
  }

  private manager(req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return req.companyContext.dataSource.manager;
  }

  @Get('units')
  async listUnits(@Req() req: CompanyScopedRequest) {
    return this.organization.listUnits(this.manager(req));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')
  @Post('units')
  async createUnit(@Req() req: CompanyScopedRequest, @Body() dto: CreateUnitDto) {
    const unit = await this.organization.createUnit(dto.type, dto.name, dto.parentId ?? null, null, this.manager(req));
    await this.record(req, 'organization.unit.created', unit.id, null, { type: unit.type, name: unit.name, parentId: unit.parentId });
    return unit;
  }

  @UseGuards(PermissionGuard)
  @RequirePermission(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')
  @Patch('units/:id')
  async updateUnit(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: UpdateUnitDto) {
    const before = await this.organization.getUnitById(id, this.manager(req));
    const unit = await this.organization.updateUnit(id, { name: dto.name, parentId: dto.parentId }, this.manager(req));
    await this.record(req, 'organization.unit.updated', id, before && { name: before.name, parentId: before.parentId }, { name: unit.name, parentId: unit.parentId });
    return unit;
  }

  /** What archiving would affect — read by the confirmation dialog before the user commits. */
  @UseGuards(PermissionGuard)
  @RequirePermission(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')
  @Get('units/:id/impact')
  async impact(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return this.organization.getImpact(id, this.manager(req));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')
  @Post('units/:id/archive')
  async archive(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: ArchiveUnitDto) {
    if (!dto.confirm) throw new BadRequestException('Confirmation is required to archive a unit. / يلزم التأكيد لأرشفة الوحدة.');
    const unit = await this.organization.archiveUnit(id, this.manager(req));
    await this.record(req, 'organization.unit.archived', id, { status: 'active' }, { status: 'archived' });
    return unit;
  }

  @UseGuards(PermissionGuard)
  @RequirePermission(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')
  @Post('units/:id/activate')
  async activate(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    const unit = await this.organization.activateUnit(id, this.manager(req));
    await this.record(req, 'organization.unit.activated', id, { status: 'archived' }, { status: 'active' });
    return unit;
  }

  /** Merge duplicate Company roots into one canonical root (nothing deleted, ids preserved). `dryRun` reports only. */
  @UseGuards(PermissionGuard)
  @RequirePermission(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')
  @Post('reconcile-root')
  async reconcileRoot(@Req() req: CompanyScopedRequest, @Body() dto: ReconcileRootDto) {
    const report = await this.organization.reconcileRoots(dto.canonicalId, { rename: dto.rename, dryRun: dto.dryRun }, this.manager(req));
    if (!report.dryRun) await this.record(req, 'organization.root.reconciled', dto.canonicalId, null, report);
    return report;
  }

  @Get('units/:id/members')
  async listMembers(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return this.organization.getMemberIds(id, this.manager(req));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')
  @Post('units/:id/members')
  async assignMember(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: AssignMemberDto) {
    if (!req.user) throw new UnauthorizedException();
    if (dto.userId === req.user.id) throw new CompanyUserError('SELF_SCOPE_CHANGE', 'You cannot add yourself to an organization unit (it widens your own access scope); ask another administrator.');
    await this.organization.assignMember(dto.userId, id, this.manager(req));
    return { assigned: true };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')
  @Delete('units/:id/members')
  async removeMember(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Query('userId') userId: string) {
    await this.organization.removeMember(userId, id, this.manager(req));
    return { removed: true };
  }
}
