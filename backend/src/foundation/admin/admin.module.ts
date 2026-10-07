import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { SalesRepsDirectoryController } from './sales-reps-directory.controller';
import { CompanyModule } from '../company/company.module';
import { DatabaseRegistryModule } from '../database-registry/database-registry.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { AuthenticationModule } from '../authentication/authentication.module';
import { IdentityModule } from '../identity/identity.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuthorizationModule, AuthenticationModule, IdentityModule, AuditModule, CompanyModule, DatabaseRegistryModule],
  controllers: [AdminController, SalesRepsDirectoryController],
})
export class AdminModule {}
