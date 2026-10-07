import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { COMPANY_ROLES_MANAGE_NODE } from '../permission/company-nodes';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';
import { CompanyContextGuard, CompanyScopedRequest } from './company-context.guard';
import { CompanyRoleManagementService, RoleInput } from './company-role-management.service';
import { CompanyActor } from './company-user-management.service';

/**
 * Authorization Foundation F3 — the Company role-management surface. Takes NO company identifier: the Company is the one `CompanyContextGuard` validated for
 * the token. Reads need `core.company.roles.manage` read-only, every write editable (locked by a wiring spec). Static routes are declared before `:roleId`.
 */
@Controller('company/roles')
@UseGuards(JwtAuthGuard, CompanyContextGuard, PermissionGuard)
@RequirePermission(COMPANY_ROLES_MANAGE_NODE, 'read-only')
export class CompanyRolesController {
  constructor(
    private readonly roles: CompanyRoleManagementService,
    private readonly contexts: AuthorizationContextService,
  ) {}

  private async ctx(req: CompanyScopedRequest): Promise<{ actor: CompanyActor; companyId: string; ds: DataSource }> {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const authz = await this.contexts.forRequest(req, req.companyContext.dataSource.manager);
    return { actor: { userId: req.user.id, authz }, companyId: req.companyContext.companyId, ds: req.companyContext.dataSource };
  }

  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    const { companyId, ds } = await this.ctx(req);
    return { success: true, data: await this.roles.list(ds, companyId) };
  }

  /** Permission catalog for the editor: nodes of ENTITLED modules only, with risk and bilingual titles. */
  @Get('catalog')
  async catalog(@Req() req: CompanyScopedRequest) {
    const { companyId } = await this.ctx(req);
    return { success: true, data: await this.roles.catalogFor(companyId) };
  }

  @Get('templates')
  async templates(@Req() req: CompanyScopedRequest) {
    const { companyId, ds } = await this.ctx(req);
    return { success: true, data: await this.roles.templates(ds, companyId) };
  }

  @RequirePermission(COMPANY_ROLES_MANAGE_NODE, 'editable')
  @Post('from-template')
  async fromTemplate(@Req() req: CompanyScopedRequest, @Body() body: { templateKey?: unknown }) {
    const { actor, companyId, ds } = await this.ctx(req);
    return { success: true, data: await this.roles.createFromTemplate(actor, companyId, ds, body?.templateKey) };
  }

  @RequirePermission(COMPANY_ROLES_MANAGE_NODE, 'editable')
  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() body: RoleInput) {
    const { actor, companyId, ds } = await this.ctx(req);
    return { success: true, data: await this.roles.createCustom(actor, companyId, ds, body ?? {}) };
  }

  @Get(':roleId')
  async detail(@Req() req: CompanyScopedRequest, @Param('roleId', ParseUUIDPipe) roleId: string) {
    const { companyId, ds } = await this.ctx(req);
    return { success: true, data: await this.roles.detail(ds, companyId, roleId) };
  }

  @RequirePermission(COMPANY_ROLES_MANAGE_NODE, 'editable')
  @Post(':roleId/clone')
  async clone(@Req() req: CompanyScopedRequest, @Param('roleId', ParseUUIDPipe) roleId: string, @Body() body: { nameEn?: unknown; nameAr?: unknown }) {
    const { actor, companyId, ds } = await this.ctx(req);
    return { success: true, data: await this.roles.clone(actor, companyId, ds, roleId, body ?? {}) };
  }

  @RequirePermission(COMPANY_ROLES_MANAGE_NODE, 'editable')
  @Put(':roleId')
  async update(@Req() req: CompanyScopedRequest, @Param('roleId', ParseUUIDPipe) roleId: string, @Body() body: RoleInput) {
    const { actor, companyId, ds } = await this.ctx(req);
    return { success: true, data: await this.roles.update(actor, companyId, ds, roleId, body ?? {}) };
  }

  @RequirePermission(COMPANY_ROLES_MANAGE_NODE, 'editable')
  @Delete(':roleId')
  async remove(@Req() req: CompanyScopedRequest, @Param('roleId', ParseUUIDPipe) roleId: string) {
    const { actor, companyId, ds } = await this.ctx(req);
    await this.roles.remove(actor, companyId, ds, roleId);
    return { success: true, data: { deleted: true } };
  }

  @Get(':roleId/template-update')
  async templateUpdate(@Req() req: CompanyScopedRequest, @Param('roleId', ParseUUIDPipe) roleId: string) {
    const { ds } = await this.ctx(req);
    return { success: true, data: await this.roles.templateUpdate(ds, roleId) };
  }

  @RequirePermission(COMPANY_ROLES_MANAGE_NODE, 'editable')
  @Post(':roleId/template-update/apply')
  async applyTemplateUpdate(@Req() req: CompanyScopedRequest, @Param('roleId', ParseUUIDPipe) roleId: string, @Body() body: { apply?: unknown }) {
    const { actor, companyId, ds } = await this.ctx(req);
    return { success: true, data: await this.roles.applyTemplateUpdate(actor, companyId, ds, roleId, body?.apply) };
  }

  @RequirePermission(COMPANY_ROLES_MANAGE_NODE, 'editable')
  @Post(':roleId/template-update/ignore')
  async ignoreTemplateUpdate(@Req() req: CompanyScopedRequest, @Param('roleId', ParseUUIDPipe) roleId: string) {
    const { actor, companyId, ds } = await this.ctx(req);
    return { success: true, data: await this.roles.ignoreTemplateUpdate(actor, companyId, ds, roleId) };
  }
}
