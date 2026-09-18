import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AuthorizationModule } from '../authorization/authorization.module';
import { AuthenticationModule } from '../authentication/authentication.module';
import { IdentityModule } from '../identity/identity.module';

@Module({
  imports: [AuthorizationModule, AuthenticationModule, IdentityModule],
  controllers: [AdminController],
})
export class AdminModule {}
