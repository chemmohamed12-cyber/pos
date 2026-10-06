import { forwardRef, Module } from '@nestjs/common';
import { CompanyModule } from '../company/company.module';
import { DatabaseRegistryModule } from '../database-registry/database-registry.module';
import { IdentityModule } from '../identity/identity.module';
import { DatabaseProvisioningService } from './database-provisioning.service';

/**
 * Multi-Company Phase 3 V7, Area 4 (Database Provisioning) + Area 20
 * (2026-09-24, Initial Admin Provisioning). `IdentityModule` — for
 * `UsersService`, so the initial-admin step can verify (D1) the caller-
 * supplied `initialAdminUserId` is a real, existing User before granting
 * anything.
 *
 * `forwardRef` — P0 (2026-09-27): `CompanyModule` now also imports THIS
 * module back, for `CompanyRegistryController`'s `POST /installation/companies`
 * (needs `DatabaseProvisioningService`). Same circular shape this codebase
 * already resolves elsewhere (e.g. `AuditModule`/`CompanyModule`).
 */
@Module({
  imports: [forwardRef(() => CompanyModule), DatabaseRegistryModule, IdentityModule],
  providers: [DatabaseProvisioningService],
  exports: [DatabaseProvisioningService],
})
export class DatabaseProvisioningModule {}
