import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScopeAssignment } from './scope-assignment.entity';
import { ScopeService } from './scope.service';
import { ScopeResolver } from './scope-resolver.service';
import { AccessScopeService } from './access-scope.service';
import { WarehouseScopeGuard } from './warehouse-scope.guard';
import { AuthorizationModule } from '../authorization/authorization.module';
import { OrganizationModule } from '../organization/organization.module';

@Module({
  imports: [TypeOrmModule.forFeature([ScopeAssignment]), AuthorizationModule, OrganizationModule],
  providers: [ScopeService, ScopeResolver, AccessScopeService, WarehouseScopeGuard],
  exports: [ScopeService, ScopeResolver, AccessScopeService, WarehouseScopeGuard],
})
export class ScopeModule {}
