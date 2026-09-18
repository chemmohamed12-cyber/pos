import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SalesRepProfile } from './infrastructure/sales-rep-profile.entity';
import { SalesService } from './application/sales.service';
import { SalesController } from './interface/sales.controller';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { PermissionModule } from '../../foundation/permission/permission.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SalesRepProfile]),
    NumberingModule,
    AuthorizationModule,
    AuditModule,
    AuthenticationModule,
    PermissionModule,
  ],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
