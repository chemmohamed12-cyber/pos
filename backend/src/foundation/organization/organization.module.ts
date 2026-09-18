import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrgUnit } from './org-unit.entity';
import { OrgMembership } from './org-membership.entity';
import { OrganizationService } from './organization.service';
import { OrganizationController } from './organization.controller';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';

@Module({
  imports: [TypeOrmModule.forFeature([OrgUnit, OrgMembership]), AuthenticationModule, AuthorizationModule],
  controllers: [OrganizationController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
