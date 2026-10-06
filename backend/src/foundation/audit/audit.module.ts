import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditRecord } from './audit-record.entity';
import { AuditService } from './audit.service';
import { CompanyAuditController } from './company-audit.controller';
import { InstallationAuditController } from './installation-audit.controller';
import { CompanyModule } from '../company/company.module';
import { DatabaseRegistryModule } from '../database-registry/database-registry.module';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PermissionModule } from '../permission/permission.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditRecord]),
    // `forwardRef` — CompanyModule already imports AuditModule plainly (for
    // AuditService); this module needs CompanyContextGuard back for its own
    // controller (Area 14, 2026-09-25), the same shape CompanyModule/
    // AuthenticationModule already established.
    forwardRef(() => CompanyModule),
    DatabaseRegistryModule,
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
  ],
  controllers: [CompanyAuditController, InstallationAuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
