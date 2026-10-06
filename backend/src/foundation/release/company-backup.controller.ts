import { Controller, Get, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../company/company-context.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';
import { COMPANY_BACKUP_MANAGE_NODE } from '../company/company-role-seeding';
import { BackupManagerService } from './backup-manager.service';
import { RestoreManagerService } from './restore-manager.service';
import { BackupRun } from './backup-run.entity';

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 10, D-Backup-05/06).
 * The Company-scoped, self-service half of the dual authorization path —
 * mirrors `CompanyMembershipController`'s exact shape (Membership HTTP
 * Management, D2). The Company being acted on is ALWAYS
 * `req.companyContext.companyId`, the one `CompanyContextGuard` already
 * validated fresh against `Membership` for THIS request's token — there
 * is deliberately no `:companyId` route param here, for the identical
 * confused-deputy reason `CompanyMembershipController` documents: a
 * client-suppliable identifier must never be able to override an
 * already-validated Company context.
 */
@Controller('backups')
@UseGuards(JwtAuthGuard, CompanyContextGuard, PermissionGuard)
@RequirePermission(COMPANY_BACKUP_MANAGE_NODE, 'editable')
export class CompanyBackupController {
  constructor(
    private readonly backupManager: BackupManagerService,
    private readonly restoreManager: RestoreManagerService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    const runs = await this.dataSource
      .getRepository(BackupRun)
      .find({ where: { companyId: req.companyContext.companyId }, order: { startedAt: 'DESC' }, take: 100 });
    return { success: true, data: runs };
  }

  @Post()
  async create(@Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const run = await this.backupManager.createBackup('manual', req.user.id, req.companyContext.companyId);
    return { success: true, data: run };
  }

  @Post(':backupRunId/restore/preflight')
  async preflightRestore(@Req() req: CompanyScopedRequest, @Param('backupRunId') backupRunId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const operation = await this.restoreManager.preflight(backupRunId, req.user.id, req.companyContext.companyId);
    return { success: true, data: operation };
  }

  @Post('restores/:id/confirm')
  async confirmRestore(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    // confirmAndRestore re-validates the RestoreOperation's own stored companyId internally —
    // this Company context only proves the CALLER is authorized to confirm; it is not itself
    // trusted as which Company gets restored (that was already fixed, and checked, at preflight).
    const operation = await this.restoreManager.confirmAndRestore(id, req.user.id);
    return { success: true, data: operation };
  }
}
