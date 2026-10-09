import { Global, Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Installation } from './installation.entity';
import { ENABLED_MODULES } from '../module-registry/enabled-modules.token';
import { readEnabledModules } from '../../database/enabled-modules';
import { AppConfigService } from '../configuration/app-config.service';
import { Edition, EditionFeature, EditionLimit, EditionModule } from './edition.entity';
import { EntitlementService } from './entitlement.service';
import { InstallationBootstrapService } from './installation-bootstrap.service';
import { EntitlementController } from './entitlement.controller';
import { ENTITLEMENT_RESOLVER } from '../module-registry/entitlement-resolver.token';
import { RequireModuleGuard } from '../module-registry/require-module.decorator';
import { RequireFeatureGuard } from '../module-registry/require-feature.decorator';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PermissionModule } from '../permission/permission.module';

/**
 * Entitlement Engine — ERP Foundation P3 (ADR-023). Resolves the FIRST,
 * INDEPENDENT axis: what the installation OWNS (Edition ≠ Permission).
 *
 * `@Global()` so the P1 guards (`RequireModuleGuard` / `RequireFeatureGuard`)
 * and the P2 Configuration Engine can `@Optional() @Inject(ENTITLEMENT_RESOLVER)`
 * without an import cycle. When this module is not loaded, those consumers
 * behave exactly as they did before P3 (guards allow, config EDITION layer
 * inert).
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Installation, Edition, EditionModule, EditionFeature, EditionLimit]),
    AuditModule,
    EventsModule,
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
  ],
  controllers: [EntitlementController],
  providers: [
    InstallationBootstrapService,
    EntitlementService,
    { provide: ENTITLEMENT_RESOLVER, useExisting: EntitlementService },
    RequireModuleGuard,
    RequireFeatureGuard,
    {
      // ADR-025 §4.1 — boot snapshot of the schema's enabled tag set.
      provide: ENABLED_MODULES,
      inject: [DataSource, AppConfigService],
      useFactory: async (dataSource: DataSource, config: AppConfigService): Promise<readonly string[]> => {
        const ent = config.entitlement;
        const tags = await readEnabledModules({
          appRoot: config.releaseExecution?.appRoot ?? process.cwd(),
          dataSource,
          publicKeys: ent?.publicKeys ?? [],
          mode: ent?.mode ?? 'unlicensed-full',
          clockToleranceMinutes: ent?.clockToleranceMinutes,
          logger: (m) => new Logger('EnabledModules').warn(m),
        });
        new Logger('EnabledModules').log(`schema tag set: ${tags.join(', ')}`);
        return tags;
      },
    },
  ],
  exports: [EntitlementService, ENTITLEMENT_RESOLVER, RequireModuleGuard, RequireFeatureGuard, ENABLED_MODULES],
})
export class EntitlementModule {}
