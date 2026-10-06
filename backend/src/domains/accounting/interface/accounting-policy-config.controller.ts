import { Body, Controller, Delete, Get, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsDefined } from 'class-validator';
import { AccountingPolicyConfigService } from '../application/accounting-policy-config.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class SetPolicyValueDto {
  /** account kind: the account code (string). reason_map kind: { reasonCode: accountCode }. */
  @IsDefined()
  value!: string | Record<string, string>;
}

/**
 * NAV-02 (2026-10-06) — Accounting Policy configuration surface over the existing Configuration Engine. Company-scoped: every call validates
 * against the REQUESTING Company's chart of accounts (`req.companyContext.dataSource.manager`). Only the managed policy keys are reachable.
 * Same authority as editing the chart of accounts (`accounting.account.edit`); reading needs `accounting.account.view`.
 */
@Controller('accounting/policy-config')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('accounting')
export class AccountingPolicyConfigController {
  constructor(private readonly policy: AccountingPolicyConfigService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.policy.list(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.edit', 'editable')
  @Post(':key') // POST, not PUT: the shared frontend api helper has no PUT/PATCH (same convention as the other update routes)
  async set(@Param('key') key: string, @Body() dto: SetPolicyValueDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.policy.set(key, dto.value, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.edit', 'editable')
  @Delete(':key')
  async clear(@Param('key') key: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.policy.clear(key, req.user.id, req.companyContext.dataSource.manager);
  }
}
