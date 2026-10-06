import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApprovalRequestType } from './approval-request-type.entity';
import { ApprovalMatrixRule } from './approval-matrix-rule.entity';
import { ApprovalRequest } from './approval-request.entity';
import { ApprovalDecision } from './approval-decision.entity';
import { ApprovalEngineService } from './approval-engine.service';
import { ApprovalExpiryScheduler } from './approval-expiry.scheduler';
import { ApprovalController } from './approval.controller';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ProcessEngineModule } from '../process-engine/process-engine.module';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { PermissionModule } from '../permission/permission.module';
import { DatabaseRegistryModule } from '../database-registry/database-registry.module';
import { CompanyModule } from '../company/company.module';

/**
 * FA-01 — Generic Approval / Maker-Checker Foundation
 * (`APPROVAL_ENGINE_CONTRACT.md`, ADR-033). Platform-Core tier — always
 * active, NOT `@RequireModule`-gated (same tier as `process-engine` /
 * `numbering` / `audit`).
 *
 * Imports only other Platform-Core foundation modules
 * (`ProcessEngine`, `Audit`, `Events`, `Permission`, `DatabaseRegistry`
 * (Area 9 company-connection routing); `ConfigurationEngine` is
 * `@Global()`). **Zero import from `src/domains/*`** — enforced by
 * `approval-engine.genericity.spec.ts` (contract §10).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ApprovalRequestType, ApprovalMatrixRule, ApprovalRequest, ApprovalDecision]),
    AuthenticationModule,
    AuthorizationModule, // RolesGuard on ApprovalController needs AuthorizationService (same as LimitEngine/Release/Admin modules)
    ProcessEngineModule,
    AuditModule,
    EventsModule,
    PermissionModule,
    DatabaseRegistryModule,
    CompanyModule, // CompanyContextGuard on ApprovalController (Area 21)
  ],
  controllers: [ApprovalController],
  providers: [ApprovalEngineService, ApprovalExpiryScheduler],
  exports: [ApprovalEngineService],
})
export class ApprovalEngineModule {}
