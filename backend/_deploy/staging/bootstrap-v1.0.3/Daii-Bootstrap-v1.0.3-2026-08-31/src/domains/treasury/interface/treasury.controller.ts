import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { TreasuryService } from '../application/treasury.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RolesGuard } from '../../../foundation/authorization/roles.guard';
import { RequireRole } from '../../../foundation/authorization/require-role.decorator';

class CreateAccountTypeDto {
  @IsString()
  code!: string;

  @IsString()
  name!: string;
}

class CreateAccountDto {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsUUID()
  accountTypeId!: string;
}

class SetAccountStatusDto {
  @IsIn(['active', 'inactive'])
  status!: 'active' | 'inactive';
}

export class CashMoveDto {
  @IsUUID()
  accountId!: string;

  @IsNumberString()
  amount!: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  salesOrderId?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

class TransferDto {
  @IsUUID()
  sourceAccountId!: string;

  @IsUUID()
  destinationAccountId!: string;

  @IsNumberString()
  amount!: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

class ReverseDto {
  @IsString()
  reason!: string;
}

/**
 * Financial/Treasury Core — finance/admin only across the board. A
 * sales rep's only touchpoint with money is submitting a Deposit claim
 * (Deposit Control domain); everything that actually moves the ledger
 * lives here, behind a distinct `finance` role from `admin`.
 */
@Controller('treasury')
@UseGuards(JwtAuthGuard, RolesGuard)
@RequireRole('admin', 'finance')
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  @Post('account-types')
  async createAccountType(@Req() req: AuthenticatedRequest, @Body() dto: CreateAccountTypeDto) {
    return this.treasury.createAccountType(dto.code, dto.name, req.user.id);
  }

  @Get('account-types')
  async listAccountTypes() {
    return this.treasury.listAccountTypes();
  }

  @Post('accounts')
  async createAccount(@Req() req: AuthenticatedRequest, @Body() dto: CreateAccountDto) {
    return this.treasury.createAccount(dto.code, dto.name, dto.accountTypeId, req.user.id);
  }

  @Get('accounts')
  async listAccounts() {
    return this.treasury.listAccountsWithBalances();
  }

  @Post('accounts/:id/status')
  async setAccountStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetAccountStatusDto) {
    return this.treasury.setAccountStatus(id, dto.status, req.user.id);
  }

  @Post('cash-in')
  async cashIn(@Req() req: AuthenticatedRequest, @Body() dto: CashMoveDto) {
    return this.treasury.cashIn(
      dto.accountId,
      dto.amount,
      dto.customerId ?? null,
      dto.salesOrderId ?? null,
      dto.reference ?? null,
      dto.reason ?? null,
      req.user.id,
    );
  }

  @Post('cash-out')
  async cashOut(@Req() req: AuthenticatedRequest, @Body() dto: CashMoveDto) {
    return this.treasury.cashOut(
      dto.accountId,
      dto.amount,
      dto.customerId ?? null,
      dto.salesOrderId ?? null,
      dto.reference ?? null,
      dto.reason ?? null,
      req.user.id,
    );
  }

  @Post('transfer')
  async transfer(@Req() req: AuthenticatedRequest, @Body() dto: TransferDto) {
    return this.treasury.transfer(dto.sourceAccountId, dto.destinationAccountId, dto.amount, dto.reference ?? null, dto.reason ?? null, req.user.id);
  }

  @Get('ledger')
  async ledger(
    @Query('accountId') accountId?: string,
    @Query('customerId') customerId?: string,
    @Query('salesOrderId') salesOrderId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (page === undefined && pageSize === undefined) {
      return this.treasury.listLedger({ accountId, customerId, salesOrderId });
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.treasury.listLedgerPage({ accountId, customerId, salesOrderId }, { page: parsedPage, pageSize: parsedPageSize });
  }

  @Post('transactions/:id/reverse')
  async reverse(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: ReverseDto) {
    return this.treasury.reverseTransaction(id, dto.reason, req.user.id);
  }
}
