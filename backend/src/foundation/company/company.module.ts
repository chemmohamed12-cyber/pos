import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from './company.entity';
import { CompanyService } from './company.service';
import { CompanyRegistryService } from './company-registry.service';
import { Membership } from './membership.entity';
import { MembershipService } from './membership.service';
import { CompanyActivationService } from './company-activation.service';
import { CompanyMembershipProvisioningService } from './company-membership-provisioning.service';
import { CompanyContextGuard } from './company-context.guard';
import { MembershipOperation } from './membership-operation.entity';
import { MembershipOperationService } from './membership-operation.service';
import { MembershipReconciliationScheduler } from './membership-reconciliation.scheduler';
import { CompanyUsersController } from './company-users.controller';
import { CompanyInvitationsPublicController } from './company-invitations-public.controller';
import { CompanyInvitation } from './company-invitation.entity';
import { CompanyInvitationService } from './company-invitation.service';
import { CompanyUserManagementService } from './company-user-management.service';
import { InstallationMembershipController } from './installation-membership.controller';
import { MembershipsMineController } from './memberships-mine.controller';
import { CompanyRegistryController } from './company-registry.controller';
import { DatabaseRegistryModule } from '../database-registry/database-registry.module';
import { AuditModule } from '../audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PermissionModule } from '../permission/permission.module';
import { DatabaseProvisioningModule } from '../database-provisioning/database-provisioning.module';

/**
 * Multi-Company Phase 3 V7, Areas 1-2-6-19 (Installation ↔ Company Model;
 * Company Registry; Authorization Boundary's Membership model; Company
 * Activation/Deactivation) + Area 5/6 (2026-09-23, Model B decision —
 * `CompanyMembershipProvisioningService`/`CompanyContextGuard`). Exports
 * `TypeOrmModule` so later Areas can inject `Repository<Company>` /
 * `Repository<Membership>` directly without a second `forFeature`
 * registration elsewhere.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Company, Membership, MembershipOperation, CompanyInvitation]),
    DatabaseRegistryModule,
    // `forwardRef` — Area 14 (2026-09-25) made AuditModule need
    // CompanyContextGuard back (for its own CompanyAuditController), the
    // same shape AuthenticationModule already required below.
    forwardRef(() => AuditModule),
    IdentityModule,
    AuthorizationModule,
    PermissionModule,
    // `forwardRef` — AuthenticationModule imports CompanyModule (for
    // MembershipService, Area 5); this module needs JwtAuthGuard back for
    // its own controllers (Membership HTTP Management, 2026-09-24).
    forwardRef(() => AuthenticationModule),
    // `forwardRef` — P0 (2026-09-27): DatabaseProvisioningModule already
    // imports CompanyModule (for CompanyRegistryService/MembershipService);
    // this module needs DatabaseProvisioningService back for
    // CompanyRegistryController's `POST /installation/companies`. Same
    // circular shape as AuthenticationModule above, same fix.
    forwardRef(() => DatabaseProvisioningModule),
  ],
  controllers: [CompanyUsersController, CompanyInvitationsPublicController, InstallationMembershipController, MembershipsMineController, CompanyRegistryController],
  providers: [
    CompanyService,
    CompanyRegistryService,
    MembershipService,
    CompanyActivationService,
    CompanyMembershipProvisioningService,
    CompanyContextGuard,
    MembershipOperationService,
    MembershipReconciliationScheduler,
    CompanyUserManagementService,
    CompanyInvitationService,
  ],
  exports: [
    TypeOrmModule,
    CompanyService,
    CompanyRegistryService,
    MembershipService,
    CompanyActivationService,
    CompanyMembershipProvisioningService,
    CompanyContextGuard,
    MembershipOperationService,
  ],
})
export class CompanyModule {}
