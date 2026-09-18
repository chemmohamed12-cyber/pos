import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Employee } from './infrastructure/employee.entity';
import { EmployeeStatusHistory } from './infrastructure/employee-status-history.entity';
import { LeaveRequest } from './infrastructure/leave-request.entity';
import { HrService } from './application/hr.service';
import { HrController } from './interface/hr.controller';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { EventsModule } from '../../foundation/events/events.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { OrganizationModule } from '../../foundation/organization/organization.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { ApprovalEngineModule } from '../../foundation/approval-engine/approval-engine.module';
import { IdentityModule } from '../../foundation/identity/identity.module';

/**
 * ERP Foundation — P9 (ADR-029), expanded under ADR-059 (HR Phase 1).
 * `hr`'s composition root. ADR-059 D1 ratified the one cross-domain
 * import P9 was originally built to prove unnecessary: `OrganizationModule`
 * (departments are now `OrgUnit` rows, `hr_departments` is retired).
 * `NumberingModule`/`ApprovalEngineModule`/`IdentityModule` are new
 * Platform-Core imports for D4 (codes), the leave-request workflow (FA-01,
 * zero new mechanism), and D2 (manual Employee<->User linking) respectively
 * — every one of them a Platform-Core foundation module, never another
 * `src/domains/*` sibling, so `hr` still imports nothing from a business
 * domain.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Employee, EmployeeStatusHistory, LeaveRequest]),
    AuthenticationModule,
    EventsModule,
    PermissionModule,
    AuditModule,
    OrganizationModule,
    NumberingModule,
    ApprovalEngineModule,
    IdentityModule,
  ],
  controllers: [HrController],
  providers: [HrService],
  exports: [HrService],
})
export class HrModule {}
