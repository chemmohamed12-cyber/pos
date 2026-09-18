import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from '../authorization/role.entity';
import { RolePermission } from '../permission/role-permission.entity';
import { ModuleRoleTemplateSeeder } from './module-role-template.seeder';

/**
 * ERP Foundation — P4 F2. Isolated module so seeding the per-module system
 * role templates does not require editing `foundation/authorization/**` or
 * `foundation/permission/**` themselves — it only reads their repositories.
 *
 * ADR-039 (RC-1 fix): the RC-1 boot-ordering defect is fixed IN THE SEEDER
 * (`onApplicationBootstrap` instead of `onModuleInit` — see its doc-comment),
 * not here. An explicit `EntitlementModule` import does NOT help because
 * `EntitlementModule` is `@Global()` (Nest hoists it and its `onModuleInit`
 * ordering is unaffected by an explicit import). `ENTITLEMENT_RESOLVER` is a
 * global token, so no import is needed to inject it either.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Role, RolePermission])],
  providers: [ModuleRoleTemplateSeeder],
  exports: [ModuleRoleTemplateSeeder],
})
export class ModuleRoleTemplatesModule {}
