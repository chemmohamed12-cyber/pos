import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from './infrastructure/customer.entity';
import { CustomerAssignment } from './infrastructure/customer-assignment.entity';
import { CustomersService } from './application/customers.service';
import { CustomersController } from './interface/customers.controller';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { ScopeModule } from '../../foundation/scope/scope.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { EventsModule } from '../../foundation/events/events.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { ExcelModule } from '../../foundation/excel/excel.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Customer, CustomerAssignment]),
    NumberingModule,
    ScopeModule,
    AuditModule,
    EventsModule,
    AuthenticationModule,
    AuthorizationModule,
    ExcelModule,
  ],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CrmModule {}
