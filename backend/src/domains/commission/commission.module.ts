import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommissionPolicy } from './infrastructure/commission-policy.entity';
import { CommissionTier } from './infrastructure/commission-tier.entity';
import { CommissionApprovalBatch } from './infrastructure/commission-approval-batch.entity';
import { CommissionResult } from './infrastructure/commission-result.entity';
import { CommissionAdjustment } from './infrastructure/commission-adjustment.entity';
import { CommissionService } from './application/commission.service';
import { CommissionController } from './interface/commission.controller';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { EventsModule } from '../../foundation/events/events.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { ApprovalEngineModule } from '../../foundation/approval-engine/approval-engine.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { HrModule } from '../hr/hr.module';
import { TargetsModule } from '../targets/targets.module';

import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';
/**
 * ADR-071 — `commission`'s composition root, Phase 1. `HrModule` (Sales-Rep
 * identity, read-only) and `TargetsModule` (`getApprovedTargetForDate`,
 * read-only) are this module's real cross-domain imports — declared in the
 * manifest's `depends_on` too. CRM/Sales/Customer-Finance are deliberately
 * NOT imported — Commission reaches them only via direct SQL reads of their
 * own tables (the same precedent Payroll established for
 * `accounting_financial_events`) and via the Transactional Outbox
 * (`finance.invoice.posted`, `collection.remitted`), never a code import.
 */
@Module({
  imports: [CompanyModule, DatabaseRegistryModule, 
    TypeOrmModule.forFeature([CommissionPolicy, CommissionTier, CommissionApprovalBatch, CommissionResult, CommissionAdjustment]),
    AuthenticationModule,
    EventsModule,
    PermissionModule,
    AuditModule,
    ApprovalEngineModule,
    ProcessEngineModule,
    HrModule,
    TargetsModule,
  ],
  controllers: [CommissionController],
  providers: [CommissionService],
  exports: [CommissionService],
})
export class CommissionModule {}
