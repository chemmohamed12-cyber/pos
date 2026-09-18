import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TreasuryAccount } from './infrastructure/treasury-account.entity';
import { TreasuryAccountType } from './infrastructure/treasury-account-type.entity';
import { TreasuryTransaction } from './infrastructure/treasury-transaction.entity';
import { TreasuryService } from './application/treasury.service';
import { TreasuryController } from './interface/treasury.controller';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TreasuryAccount, TreasuryAccountType, TreasuryTransaction]),
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
    NumberingModule,
  ],
  controllers: [TreasuryController],
  providers: [TreasuryService],
  exports: [TreasuryService],
})
export class TreasuryModule {}
