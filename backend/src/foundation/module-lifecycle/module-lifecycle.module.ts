import { Module } from '@nestjs/common';
import { ModuleLifecycleService } from './module-lifecycle.service';
import { ModuleRoleTemplatesModule } from '../module-role-templates/module-role-templates.module';
import { AuditModule } from '../audit/audit.module';

/**
 * ERP Foundation P6 (T2). Wraps `ModuleLifecycleService` — the "enable
 * Module M" deploy-step helper. Imported by `ReleaseModule` only.
 *
 * `EntitlementService`, `ConfigurationEngineService` and `LimitService` come
 * from their own `@Global()` modules and need no import here;
 * `ModuleRoleTemplateSeeder` is not global, so its module is imported.
 */
@Module({
  imports: [ModuleRoleTemplatesModule, AuditModule],
  providers: [ModuleLifecycleService],
  exports: [ModuleLifecycleService],
})
export class ModuleLifecycleModule {}
