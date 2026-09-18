import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScopeAssignment } from './scope-assignment.entity';
import { ScopeService } from './scope.service';
import { AuthorizationModule } from '../authorization/authorization.module';

@Module({
  imports: [TypeOrmModule.forFeature([ScopeAssignment]), AuthorizationModule],
  providers: [ScopeService],
  exports: [ScopeService],
})
export class ScopeModule {}
