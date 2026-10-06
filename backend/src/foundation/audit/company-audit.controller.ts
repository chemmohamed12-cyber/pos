import { Controller, Get, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { CompanyContextGuard, CompanyScopedRequest } from '../company/company-context.guard';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';
import { COMPANY_AUDIT_VIEW_NODE } from '../company/company-role-seeding';
import { AuditService } from './audit.service';
import { AuditRecord } from './audit-record.entity';

/**
 * Area 14 (2026-09-25, CTO Implementation Gate). The Company-scoped,
 * self-service half of the dual access path (§S5 of the Specification) —
 * mirrors `CompanyBackupController`'s exact shape. The Company is ALWAYS
 * `req.companyContext.companyId`, never a client-suppliable route param
 * — same confused-deputy defense as every other Company-scoped
 * self-service controller in this codebase.
 */
@Controller('company-audit')
@UseGuards(JwtAuthGuard, CompanyContextGuard, PermissionGuard)
@RequirePermission(COMPANY_AUDIT_VIEW_NODE, 'read-only')
export class CompanyAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(@Req() req: CompanyScopedRequest, @Query('action') action?: string, @Query('take') take?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const { dataSource } = req.companyContext;

    const where = action ? { action } : {};
    const records = await dataSource.getRepository(AuditRecord).find({ where, order: { seq: 'DESC' }, take: take ? Number(take) : 100 });

    // §S6 — the read itself is a security-sensitive administrative action; recorded once, not
    // recursively (this write is never itself the subject of another access-event write).
    await this.audit.record(
      {
        actorUserId: req.user.id,
        organizationId: null,
        action: 'company.audit.accessed',
        resource: 'audit_record',
        resourceId: null,
        result: 'success',
        correlationId: null,
        after: { filter: { action: action ?? null }, count: records.length },
      },
      dataSource.manager,
    );

    return { success: true, data: records };
  }
}
