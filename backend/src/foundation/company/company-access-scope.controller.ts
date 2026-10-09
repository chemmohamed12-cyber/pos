import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Put, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IsArray, IsBoolean, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';
import { AuditService } from '../audit/audit.service';
import { AccessScopeService } from '../scope/access-scope.service';
import { loadAuthorizationContext } from '../authorization/authorization-context.loader';
import { permissionCatalogNodes } from '../permission/permission-catalog';
import { CompanyContextGuard, CompanyScopedRequest } from './company-context.guard';
import { MembershipService } from './membership.service';
import { COMPANY_MEMBERS_MANAGE_NODE } from './company-role-seeding';
import { CompanyUserError } from './company-user-roles';

class ScopeGrantDto {
  @IsUUID()
  orgUnitId!: string;

  @IsOptional()
  @IsBoolean()
  includeDescendants?: boolean;
}

class SetScopesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScopeGrantDto)
  grants!: ScopeGrantDto[];
}

/**
 * Authorization Foundation F6 — access scopes of a Company user + the Effective Access Preview.
 *
 * Takes no company identifier from the client (the Company is the one `CompanyContextGuard` validated). Reads need `core.company.members.manage` read-only, writes
 * editable (the same administration authority as the Company Users screen). A grant broadens what data a person can reach, so it is contained by the actor's OWN
 * scope (anti-elevation, `AccessScopeService.replaceGrants`); the Company administrator (unrestricted) may grant any unit, including the Company root = "All company".
 * The target must be an ACTIVE member of THIS Company (an identity that is not a member never receives scope rows).
 */
@Controller('company/users')
@UseGuards(JwtAuthGuard, CompanyContextGuard, PermissionGuard)
@RequirePermission(COMPANY_MEMBERS_MANAGE_NODE, 'read-only')
export class CompanyAccessScopeController {
  constructor(
    private readonly scopes: AccessScopeService,
    private readonly memberships: MembershipService,
    private readonly audit: AuditService,
  ) {}

  private async assertMember(req: CompanyScopedRequest, userId: string): Promise<void> {
    if (!req.companyContext) throw new UnauthorizedException();
    const member = await this.memberships.findActiveByUserAndCompany(userId, req.companyContext.companyId);
    if (!member) throw new NotFoundException(); // never confirm that an identity exists outside this Company
  }

  @Get(':userId/scopes')
  async get(@Req() req: CompanyScopedRequest, @Param('userId', ParseUUIDPipe) userId: string) {
    await this.assertMember(req, userId);
    const manager = req.companyContext!.dataSource.manager;
    return { success: true, data: { grants: await this.scopes.listGrants(userId, manager), effective: await this.scopes.describe(userId, manager) } };
  }

  @Put(':userId/scopes')
  @RequirePermission(COMPANY_MEMBERS_MANAGE_NODE, 'editable')
  async set(@Req() req: CompanyScopedRequest, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: SetScopesDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.assertMember(req, userId);
    const manager = req.companyContext.dataSource.manager;
    const member = await this.memberships.findActiveByUserAndCompany(userId, req.companyContext.companyId);
    if (member?.kind === 'support') throw new CompanyUserError('SUPPORT_ACCESS_FIXED', 'Support access is fixed (read-only, time-boxed); it cannot be given an access scope.'); // Decision 4-C: support never broadens itself
    const actorScope = await this.scopes.forRequest(req);
    const organizationAdmin = await this.scopes.canAdministerAllUnits(req);
    const { before, after } = await manager.transaction(async (tx) => {
      const result = await this.scopes.replaceGrants(actorScope, userId, dto.grants.map((g) => ({ orgUnitId: g.orgUnitId, includeDescendants: g.includeDescendants !== false })), req.user!.id, tx, { organizationAdmin });
      await this.audit.record(
        { actorUserId: req.user!.id, organizationId: null, action: 'company.user.scopes_changed', resource: 'access_scope', resourceId: userId, result: 'success', correlationId: randomUUID(), before: { grants: result.before }, after: { grants: result.after } },
        tx,
      );
      return result;
    });
    return { success: true, data: { before, after, effective: await this.scopes.describe(userId, manager) } };
  }

  /**
   * Effective Access Preview (Blueprint §9, V14): what THIS user can do in THIS Company, computed with the very functions the guards use (`AuthorizationContext.hasAtLeast`
   * for the permission, `AccessScopeService` for the scope). With `node` (+ `level`, default read-only) and optionally `warehouseId` / `orgUnitId` it answers one
   * concrete question: would the guards let this user do that, and if not, which layer refuses.
   */
  @Get(':userId/effective-access')
  async preview(
    @Req() req: CompanyScopedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('node') node?: string,
    @Query('level') level?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('orgUnitId') orgUnitId?: string,
  ) {
    await this.assertMember(req, userId);
    const manager = req.companyContext!.dataSource.manager;
    const ctx = await loadAuthorizationContext(manager, userId, req.companyContext!.companyId);
    const effective = await this.scopes.describe(userId, manager);
    const data: Record<string, unknown> = {
      userId,
      roles: ctx.roleKeys,
      capabilityCount: Object.keys(ctx.effectiveFor(permissionCatalogNodes())).length,
      scope: effective,
    };
    if (node) {
      const wanted: 'read-only' | 'editable' = level === 'editable' ? 'editable' : 'read-only';
      const permissionAllowed = ctx.hasAtLeast(node, wanted);
      let scopeAllowed = true;
      if (permissionAllowed && (warehouseId || orgUnitId)) {
        const scope = await this.scopes.resolve(userId, manager);
        scopeAllowed = orgUnitId ? this.scopes.allowsUnit(scope, orgUnitId) : this.scopes.allowsUnit(scope, await this.scopes.warehouseUnit(warehouseId!, manager));
      }
      data.decision = { node, level: wanted, warehouseId: warehouseId ?? null, orgUnitId: orgUnitId ?? null, allowed: permissionAllowed && scopeAllowed, refusedBy: !permissionAllowed ? 'permission' : !scopeAllowed ? 'scope' : null };
    }
    return { success: true, data };
  }
}
