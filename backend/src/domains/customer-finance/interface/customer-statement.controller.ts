import { Controller, Get, Param, ParseUUIDPipe, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CustomerStatementService } from '../application/customer-statement.service';
import { CustomerStatementExportService, StatementFormat } from '../application/customer-statement-export.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { CompanyService } from '../../../foundation/company/company.service';
import { RequireModule, RequireModuleGuard } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class StatementQuery {
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() entryType?: string;
  @IsOptional() @IsIn(['posted', 'reversed']) status?: string;
  @IsOptional() @IsIn(['pdf', 'xlsx', 'csv']) format?: string;
  @IsOptional() @IsIn(['ar', 'en']) lang?: string;
}

class SummaryQuery {
  @IsOptional() @IsString() asOf?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

/**
 * Customer account statement, dashboard indicators and the movement-details panel — READ ONLY (no posting, no balance change). Every route is gated on the SERVER by
 * `accounting.ar.view` (read-only) on top of the module gate, and every read re-checks the customer's scope (404 outside the caller's reach). The export routes apply
 * the same permission, scope and filters as the screen and always cover the whole period (never just a page).
 */
@Controller('customer-finance')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
@RequireModule('finance')
export class CustomerStatementController {
  constructor(
    private readonly statements: CustomerStatementService,
    private readonly exporter: CustomerStatementExportService,
    private readonly companies: CompanyService,
  ) {}

  @RequirePermission('accounting.ar.view', 'read-only')
  @Get('statement/:customerId')
  async statement(@Req() req: CompanyScopedRequest, @Param('customerId', ParseUUIDPipe) customerId: string, @Query() q: StatementQuery) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.statements.getStatement(customerId, req.user.id, q, req.companyContext.dataSource.manager);
  }

  @RequirePermission('accounting.ar.view', 'read-only')
  @Get('statement/:customerId/export')
  async export(@Req() req: CompanyScopedRequest, @Param('customerId', ParseUUIDPipe) customerId: string, @Query() q: StatementQuery, @Res() res: Response) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const statement = await this.statements.getStatement(customerId, req.user.id, q, req.companyContext.dataSource.manager);
    const company = await this.companies.findById(req.companyContext.companyId);
    const out = await this.exporter.render(statement, (q.format as StatementFormat) ?? 'pdf', q.lang === 'en' ? 'en' : 'ar', company?.name ?? '—');
    res.set({ 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store' });
    res.send(out.buffer);
  }

  @RequirePermission('accounting.ar.view', 'read-only')
  @Get('account-summary/:customerId')
  async summary(@Req() req: CompanyScopedRequest, @Param('customerId', ParseUUIDPipe) customerId: string, @Query() q: SummaryQuery) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.statements.getAccountSummary(customerId, req.user.id, q, req.companyContext.dataSource.manager);
  }

  @RequirePermission('accounting.ar.view', 'read-only')
  @Get('entries/:entryId/details')
  async details(@Req() req: CompanyScopedRequest, @Param('entryId', ParseUUIDPipe) entryId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.statements.getEntryDetails(entryId, req.user.id, req.companyContext.dataSource.manager);
  }
}
