import { Module } from '@nestjs/common';
import { NavigationService } from './navigation.service';
import { NavigationController } from './navigation.controller';
import { EntitlementModule } from '../entitlement/entitlement.module';
import { PermissionModule } from '../permission/permission.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { AuthenticationModule } from '../authentication/authentication.module';

/** ERP Foundation — P7 (Server-Driven Frontend Navigation). Not `@Global()` — only `NavigationController` needs `NavigationService`, unlike Configuration/Limit which every domain command may call. */
@Module({
  imports: [EntitlementModule, PermissionModule, AuthorizationModule, AuthenticationModule],
  controllers: [NavigationController],
  providers: [NavigationService],
  exports: [NavigationService],
})
export class NavigationModule {}
