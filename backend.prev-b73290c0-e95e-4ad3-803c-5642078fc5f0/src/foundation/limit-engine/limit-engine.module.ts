import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LimitProfile } from './limit-profile.entity';
import { LimitUsageCounter } from './limit-usage-counter.entity';
import { LimitRegistrySeeder } from './limit-registry.seeder';
import { LimitService } from './limit.service';
import { LimitController } from './limit.controller';
import { AuditModule } from '../audit/audit.module';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PermissionModule } from '../permission/permission.module';

/**
 * Limit Engine — ERP Foundation P5. `ERP_FOUNDATION_PHASE_PLAN.md`'s P5
 * section, `LIMIT_INTEGRATION_CONTRACT.md`.
 *
 * `@Global()` for the same reason Configuration is: any domain command
 * may need to check a quota (`LimitService.check`/`consume`/`release`),
 * same DI-availability rationale as `ConfigurationEngineModule`.
 * `MODULE_REGISTRY` (P1) is consumed as a plain const by the seeder and
 * `LimitService`'s admin methods — not a provider.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([LimitProfile, LimitUsageCounter]),
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
  ],
  controllers: [LimitController],
  providers: [LimitRegistrySeeder, LimitService],
  exports: [LimitService],
})
export class LimitEngineModule {}
