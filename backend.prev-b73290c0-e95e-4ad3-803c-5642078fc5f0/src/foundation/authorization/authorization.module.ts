import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from './role.entity';
import { UserRole } from './user-role.entity';
import { AuthorizationService } from './authorization.service';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Role, UserRole])],
  providers: [AuthorizationService, RolesGuard],
  exports: [AuthorizationService, RolesGuard],
})
export class AuthorizationModule {}
