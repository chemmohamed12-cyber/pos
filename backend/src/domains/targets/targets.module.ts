import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Target } from './infrastructure/target.entity';
import { TargetService } from './application/target.service';
import { TargetController } from './interface/target.controller';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { EventsModule } from '../../foundation/events/events.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { ApprovalEngineModule } from '../../foundation/approval-engine/approval-engine.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { HrModule } from '../hr/hr.module';

/** ADR-071 — `targets`'s composition root, Phase 1. `HrModule` is this module's one real cross-domain import (Employee identity, read-only). */
@Module({
  imports: [TypeOrmModule.forFeature([Target]), AuthenticationModule, EventsModule, PermissionModule, AuditModule, ApprovalEngineModule, ProcessEngineModule, HrModule],
  controllers: [TargetController],
  providers: [TargetService],
  exports: [TargetService],
})
export class TargetsModule {}
