import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrgUnit } from './org-unit.entity';
import { OrgMembership } from './org-membership.entity';
import { OrganizationService } from './organization.service';
import { OrganizationController } from './organization.controller';
import { OrgLegacyService } from './org-legacy.service';
import { OrgLegacyController } from './org-legacy.controller';
import { AuthenticationModule } from '../authentication/authentication.module';
import { CompanyModule } from '../company/company.module';
import { DatabaseRegistryModule } from '../database-registry/database-registry.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PermissionModule } from '../permission/permission.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([OrgUnit, OrgMembership]), AuthenticationModule, AuthorizationModule, PermissionModule, CompanyModule, DatabaseRegistryModule, AuditModule],
  controllers: [OrganizationController, OrgLegacyController],
  providers: [OrganizationService, OrgLegacyService],
  exports: [OrganizationService, OrgLegacyService],
})
export class OrganizationModule {}
