import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { AuthenticatedRequest, JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { PLATFORM_NODES, PLATFORM_ROLES } from './platform-nodes';
import { PlatformGuard, RequirePlatform } from './platform.guard';
import { IntegrationCatalogService } from './integration-catalog.service';
import { SupportAccessService } from './support-access.service';
import { WORKFLOW_DIVERGENCE, currentWorkflowMode } from '../authorization/workflow-access';
import { WORKFLOW_RULES } from '../authorization/workflow-rules';

/**
 * Authorization Foundation F4 — the platform plane's own surface: the platform role catalog and support access. Every route is gated by `PlatformGuard`
 * (control-plane authority only) with an explicit `platform.*` node; none of them ever reads Company data.
 */
@Controller('platform')
@UseGuards(JwtAuthGuard, PlatformGuard)
export class PlatformController {
  constructor(
    private readonly support: SupportAccessService,
    private readonly integrations: IntegrationCatalogService,
    private readonly platform: DataSource,
  ) {}

  /** The `platform.*` node catalog (risk + bilingual titles) for the platform role screens. */
  @RequirePlatform('platform.role.view')
  @Get('nodes')
  nodes() {
    return { success: true, data: PLATFORM_NODES };
  }

  /** The platform roles with their grants and current holders (control-plane `user_roles`). */
  @RequirePlatform('platform.role.view')
  @Get('roles')
  async roles() {
    const keys = [...PLATFORM_ROLES.map((r) => r.key), 'admin'];
    const holders: Array<{ key: string; n: number }> = await this.platform.query(
      `SELECT r."key" AS "key", count(ur."userId")::int AS n FROM "roles" r LEFT JOIN "user_roles" ur ON ur."roleId" = r."id" WHERE r."key" = ANY($1::text[]) GROUP BY r."key"`,
      [keys],
    );
    const count = new Map(holders.map((h) => [h.key, h.n]));
    return {
      success: true,
      data: [
        ...PLATFORM_ROLES.map((r) => ({ key: r.key, type: 'system', nameEn: r.nameEn, nameAr: r.nameAr, descriptionEn: r.descriptionEn, descriptionAr: r.descriptionAr, grants: r.grants, holders: count.get(r.key) ?? 0 })),
        { key: 'admin', type: 'legacy', nameEn: 'Legacy Super Admin', nameAr: 'المدير الأعلى (قديم)', descriptionEn: 'The pre-F4 platform super-user: alias of Platform Super Admin, kept until the legacy role checks are retired.', descriptionAr: 'مدير المنصة الأعلى قبل F4: مرادف لمدير المنصة الأعلى حتى يُنهى العمل بفحوص الأدوار القديمة.', grants: 'all platform.* nodes', holders: count.get('admin') ?? 0 },
      ],
    };
  }

  /**
   * F5 — the legacy-role retirement monitor: the active mode and, per workflow rule, how often the legacy role list and the capability disagreed since this process
   * booted (`legacyOnly` = a user would LOSE the power when the legacy leg is retired; `capabilityOnly` = a user GAINS power compared with the role lists).
   * Counters are per process and only fill in `dual` mode. Read-only; reveals no user or Company data.
   */
  @RequirePlatform('platform.audit.view')
  @Get('authz/workflow-divergence')
  workflowDivergence() {
    const rules = WORKFLOW_RULES.map((r) => ({ rule: r.key, node: r.node, ...(WORKFLOW_DIVERGENCE.get(r.key) ?? { total: 0, legacyOnly: 0, capabilityOnly: 0 }) }));
    return { success: true, data: { mode: currentWorkflowMode(), totals: { legacyOnly: rules.reduce((a, r) => a + r.legacyOnly, 0), capabilityOnly: rules.reduce((a, r) => a + r.capabilityOnly, 0) }, rules } };
  }

  @RequirePlatform('platform.support.view')
  @Get('support-access')
  async listSupport(@Query('companyId') companyId?: string) {
    return { success: true, data: await this.support.list(companyId || undefined) };
  }

  @RequirePlatform('platform.support.grant', 'editable')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('support-access')
  async grant(@Req() req: AuthenticatedRequest, @Body() body: { companyId?: string; userId?: string; reason?: unknown; hours?: unknown }) {
    if (!req.user) throw new UnauthorizedException();
    return { success: true, data: await this.support.grant(req.user.id, { companyId: String(body?.companyId ?? ''), userId: body?.userId, reason: body?.reason, hours: body?.hours }) };
  }

  @RequirePlatform('platform.support.revoke', 'editable')
  @Delete('support-access/:companyId/:userId')
  async revoke(@Req() req: AuthenticatedRequest, @Param('companyId', ParseUUIDPipe) companyId: string, @Param('userId', ParseUUIDPipe) userId: string) {
    if (!req.user) throw new UnauthorizedException();
    await this.support.revoke(req.user.id, companyId, userId, 'platform');
    return { success: true, data: { revoked: true } };
  }

  /** AZ-13 (Hybrid): the platform-owned Integration Catalog. Company connections / credentials / mappings / logs are Company-owned and never appear here. */
  @RequirePlatform('platform.integration.view')
  @Get('integrations/providers')
  async providers() {
    return { success: true, data: await this.integrations.list() };
  }

  @RequirePlatform('platform.integration.manage', 'editable')
  @Put('integrations/providers/:code')
  async setProviderStatus(@Req() req: AuthenticatedRequest, @Param('code') code: string, @Body() body: { status?: unknown }) {
    if (!req.user) throw new UnauthorizedException();
    return { success: true, data: await this.integrations.setStatus(req.user.id, code, body?.status) };
  }
}
