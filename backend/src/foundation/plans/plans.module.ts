import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { COMPANY_ENTITLEMENT_RESOLVER } from '../module-registry/entitlement-resolver.token';
import { Company } from '../company/company.entity';
import { CompanyModule } from '../company/company.module';
import { DatabaseRegistryModule } from '../database-registry/database-registry.module';
import { AuditModule } from '../audit/audit.module';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { CompanyPlanAssignment, Plan, PlanModule } from './plan.entity';
import { PlanService } from './plan.service';
import { CompanyPackageService } from './company-package.service';
import { CompanyEntitlementService } from './company-entitlement.service';
import { CompanyViewContextService } from './company-view-context.service';
import { PlansController } from './plans.controller';

/**
 * Company Plans / Packages. `@Global()` for the same reason `EntitlementModule`
 * is: the P1 guards (`RequireModuleGuard` / `RequireFeatureGuard`) are
 * instantiated inside every domain module and pick the per-Company resolver up
 * through `@Optional() @Inject(COMPANY_ENTITLEMENT_RESOLVER)` without any
 * module importing this one. Without it the guards behave exactly as before.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Plan, PlanModule, CompanyPlanAssignment, Company]),
    CompanyModule,
    DatabaseRegistryModule,
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
  ],
  controllers: [PlansController],
  providers: [
    PlanService,
    CompanyPackageService,
    CompanyEntitlementService,
    CompanyViewContextService,
    { provide: COMPANY_ENTITLEMENT_RESOLVER, useExisting: CompanyEntitlementService },
  ],
  exports: [PlanService, CompanyPackageService, CompanyEntitlementService, CompanyViewContextService, COMPANY_ENTITLEMENT_RESOLVER],
})
export class PlansModule {}
