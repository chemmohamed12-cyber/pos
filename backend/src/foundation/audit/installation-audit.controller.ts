import { Controller, Get, Param, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { RequireRole } from '../authorization/require-role.decorator';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { AuditService } from './audit.service';
import { AuditRecord } from './audit-record.entity';

/**
 * Area 14 (2026-09-25, CTO Implementation Gate). The SEPARATE
 * Installation-level administrative audit path — gated by the PLATFORM
 * `admin` role via `RolesGuard`, never `CompanyContextGuard`. Same
 * precedent as `InstallationMembershipController`: a platform admin is
 * trusted to name any Company explicitly (`:companyId` as a real route
 * param), for control-plane administrative purposes — the Company
 * self-service boundary (`CompanyAuditController`) is entirely untouched
 * by this controller's existence.
 */
@Controller('installation/companies/:companyId/audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@RequireRole('admin')
export class InstallationAuditController {
  constructor(
    private readonly connections: CompanyConnectionManagerService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Param('companyId') companyId: string, @Query('action') action?: string, @Query('take') take?: string) {
    if (!req.user) throw new UnauthorizedException();
    const dataSource = await this.connections.getDataSource(companyId);

    const where = action ? { action } : {};
    const records = await dataSource.getRepository(AuditRecord).find({ where, order: { seq: 'DESC' }, take: take ? Number(take) : 100 });

    await this.audit.record(
      {
        actorUserId: req.user.id,
        organizationId: null,
        action: 'company.audit.accessed',
        resource: 'audit_record',
        resourceId: null,
        result: 'success',
        correlationId: null,
        after: { filter: { action: action ?? null }, count: records.length, accessedByInstallationAdmin: true },
      },
      dataSource.manager,
    );

    return { success: true, data: records };
  }
}
