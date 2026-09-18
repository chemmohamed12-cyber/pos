import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigKey } from './config-key.entity';
import { ConfigValue } from './config-value.entity';
import { ConfigRegistrySeeder } from './config-registry.seeder';
import { ConfigurationEngineService } from './configuration-engine.service';
import { ConfigurationController } from './configuration.controller';
import { ACTIVE_EDITION_PROVIDER, EntitlementActiveEditionProvider } from './active-edition.provider';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PermissionModule } from '../permission/permission.module';

/**
 * Runtime Configuration Engine — ERP Foundation P2 (FC §8, finally built).
 * planning/erp-foundation/P2_BLUEPRINT.md. ADR-023 C5 — this is a SEPARATE
 * module from boot `foundation/configuration/` (`AppConfigService`). No
 * Edition/feature/business key ever goes into the Joi boot schema.
 *
 * `@Global()` for the same reason the boot module is: every module reads
 * config. The registry (P1 `MODULE_REGISTRY`) is consumed by the seeder as a
 * plain const — it does not need to be a provider.
 *
 * P3: swap `ACTIVE_EDITION_PROVIDER` from `NullActiveEditionProvider` to one
 * that reads `installation.edition_code`. No other change here.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ConfigKey, ConfigValue]),
    AuditModule,
    EventsModule,
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
  ],
  controllers: [ConfigurationController],
  providers: [
    ConfigRegistrySeeder,
    ConfigurationEngineService,
    { provide: ACTIVE_EDITION_PROVIDER, useClass: EntitlementActiveEditionProvider },
  ],
  exports: [ConfigurationEngineService],
})
export class ConfigurationEngineModule {}
