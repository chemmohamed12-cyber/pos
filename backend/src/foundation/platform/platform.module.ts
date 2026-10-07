import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { CompanyModule } from '../company/company.module';
import { DatabaseRegistryModule } from '../database-registry/database-registry.module';
import { IdentityModule } from '../identity/identity.module';
import { PlatformController } from './platform.controller';
import { IntegrationCatalogService } from './integration-catalog.service';
import { PlatformRoleSeeder } from './platform-role.seeder';
import { SupportAccessScheduler } from './support-access.scheduler';
import { SupportAccessService } from './support-access.service';

/** Authorization Foundation F4 — the platform plane: `platform.*` roles (seeded into the control plane) and time-boxed support access. */
@Module({
  imports: [AuthorizationModule, AuthenticationModule, CompanyModule, DatabaseRegistryModule, IdentityModule, AuditModule],
  controllers: [PlatformController],
  providers: [PlatformRoleSeeder, SupportAccessService, SupportAccessScheduler, IntegrationCatalogService],
  exports: [SupportAccessService, IntegrationCatalogService],
})
export class PlatformModule {}
