import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Department } from './infrastructure/department.entity';
import { Employee } from './infrastructure/employee.entity';
import { HrService } from './application/hr.service';
import { HrController } from './interface/hr.controller';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { EventsModule } from '../../foundation/events/events.module';
import { PermissionModule } from '../../foundation/permission/permission.module';

/**
 * ERP Foundation — P9 (ADR-029). `hr`'s composition root. Imports only
 * cross-cutting Platform-Core foundation modules (Authentication, Events,
 * Permission) — the same set every domain module imports — plus
 * `EntitlementModule`/`LimitEngineModule`, which are `@Global()` and need no
 * explicit import. **No import from `src/domains/*`** (`hr.depends_on: []`).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Department, Employee]), AuthenticationModule, EventsModule, PermissionModule],
  controllers: [HrController],
  providers: [HrService],
  exports: [HrService],
})
export class HrModule {}
