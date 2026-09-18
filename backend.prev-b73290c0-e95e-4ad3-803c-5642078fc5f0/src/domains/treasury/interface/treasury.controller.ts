import { Body, Controller, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { TreasuryService } from '../application/treasury.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { IdempotencyService } from '../../../foundation/error-contract/idempotency.service';

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

class SetGlMappingDto {
  // The GL account code (`GLAccount.code`) this Treasury account posts to,
  // or null / '' to clear the mapping. F06 / F06-H1 (ADR-038 D7).
  @IsOptional()
  @IsString()
  glAccountCode?: string | null;
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
 *
 * P4 Tranche-2 ("remaining 9 domains" pass, 2026-09-06): the original
 * gate was a single CLASS-level `@RequireRole('admin', 'finance')`,
 * uniform across every route. `PermissionGuard` (unlike
 * `RequireModuleGuard`) reads its metadata via `context.getHandler()`
 * ONLY — no class-level fallback — so reproducing this uniform gate
 * requires `@RequirePermission('finance', 'editable')` on EVERY route
 * individually, not just once at class level (a class-level-only
 * `@RequirePermission` would silently no-op every route — verified by
 * reading `permission.guard.ts` directly before writing any of this).
 * `@RequireModule`/`RequireModuleGuard` stays class-level (it DOES
 * fall back to `context.getClass()`).
 */
@Controller('treasury')
@UseGuards(JwtAuthGuard, RequireModuleGuard, PermissionGuard)
@RequireModule('finance')
export class TreasuryController {
  constructor(
    private readonly treasury: TreasuryService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @RequirePermission('finance', 'editable')
  @Post('account-types')
  async createAccountType(@Req() req: AuthenticatedRequest, @Body() dto: CreateAccountTypeDto) {
    return this.treasury.createAccountType(dto.code, dto.name, req.user.id);
  }

  @RequirePermission('finance', 'editable')
  @Get('account-types')
  async listAccountTypes() {
    return this.treasury.listAccountTypes();
  }

  @RequirePermission('finance', 'editable')
  @Post('accounts')
  async createAccount(@Req() req: AuthenticatedRequest, @Body() dto: CreateAccountDto) {
    return this.treasury.createAccount(dto.code, dto.name, dto.accountTypeId, req.user.id);
  }

  @RequirePermission('finance', 'editable')
  @Get('accounts')
  async listAccounts(@Req() req: AuthenticatedRequest, @Query('search') search?: string) {
    return this.treasury.listAccountsWithBalances(req.user.id, { search });
  }

  // AUDIT-SEC-28 (S21, 2026-09-10): `setAccountStatus` had a permission
  // gate only — no Scope check, unlike the sibling `ledger` read
  // (`assertLedgerAccountAccess`). Any `finance:editable` holder could
  // deactivate/reactivate any branch's account. Now scope-checked first.
  @RequirePermission('finance', 'editable')
  @Post('accounts/:id/status')
  async setAccountStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetAccountStatusDto) {
    await this.treasury.assertLedgerAccountAccess(id, req.user.id);
    return this.treasury.setAccountStatus(id, dto.status, req.user.id);
  }

  /**
   * F06 / F06-H1 (ADR-038 D7). Map a Treasury account to its GL account
   * (a `bank` control account), or clear the mapping. Scope-checked first,
   * the same as `setAccountStatus`.
   */
  @RequirePermission('finance', 'editable')
  @Post('accounts/:id/gl-mapping')
  async setGlMapping(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetGlMappingDto) {
    await this.treasury.assertLedgerAccountAccess(id, req.user.id);
    return this.treasury.setAccountGlMapping(id, dto.glAccountCode ?? null, req.user.id);
  }

  /**
   * Security Assurance Gate — Track S4, found 2026-09-08 (same class as
   * AUDIT-SEC-23): a retried `cash-in` request (lost response, double
   * submission) posts a second, individually-valid `cash_in` leg — this
   * isn't a Process-Engine state transition the way invoice posting is,
   * so there's no existing lock/re-validation to catch a genuine retry.
   * `Idempotency-Key` is opt-in and additive — a caller that sends none
   * gets the exact previous, unconditional behaviour.
   */
  @RequirePermission('finance', 'editable')
  @Post('cash-in')
  async cashIn(@Req() req: AuthenticatedRequest, @Body() dto: CashMoveDto, @Headers('idempotency-key') idempotencyKey?: string) {
    // F06-H1: the Treasury-UI path uses `cashInDirect` — the emitting
    // variant. The `FinanceTreasuryContract.cashIn` other domains call
    // stays non-emitting (ADR-038 D4).
    return this.idempotency.withIdempotency('treasury.cash-in', idempotencyKey, () =>
      this.treasury.cashInDirect(dto.accountId, dto.amount, dto.customerId ?? null, dto.salesOrderId ?? null, dto.reference ?? null, dto.reason ?? null, req.user.id),
    );
  }

  /** Same finding/fix as `cashIn` above. */
  @RequirePermission('finance', 'editable')
  @Post('cash-out')
  async cashOut(@Req() req: AuthenticatedRequest, @Body() dto: CashMoveDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.idempotency.withIdempotency('treasury.cash-out', idempotencyKey, () =>
      this.treasury.cashOutDirect(dto.accountId, dto.amount, dto.customerId ?? null, dto.salesOrderId ?? null, dto.reference ?? null, dto.reason ?? null, req.user.id),
    );
  }

  /** Same finding/fix as `cashIn` above — a retried transfer would otherwise post a second pair of legs. */
  @RequirePermission('finance', 'editable')
  @Post('transfer')
  async transfer(@Req() req: AuthenticatedRequest, @Body() dto: TransferDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.idempotency.withIdempotency('treasury.transfer', idempotencyKey, () =>
      this.treasury.transferDirect(dto.sourceAccountId, dto.destinationAccountId, dto.amount, dto.reference ?? null, dto.reason ?? null, req.user.id),
    );
  }

  /** AUDIT-SEC-03 (F3) remediation: an `accountId` filter must pass ScopeResolver before the ledger query runs — was previously any `finance:editable` user, any account, no check. */
  @RequirePermission('finance', 'editable')
  @Get('ledger')
  async ledger(
    @Req() req: AuthenticatedRequest,
    @Query('accountId') accountId?: string,
    @Query('customerId') customerId?: string,
    @Query('salesOrderId') salesOrderId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (accountId) await this.treasury.assertLedgerAccountAccess(accountId, req.user.id);
    if (page === undefined && pageSize === undefined) {
      return this.treasury.listLedger({ accountId, customerId, salesOrderId });
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.treasury.listLedgerPage({ accountId, customerId, salesOrderId }, { page: parsedPage, pageSize: parsedPageSize });
  }

  // AUDIT-SEC-28 (S21, 2026-09-10): same gap — `reverseTransaction` had
  // no Scope check, so any `finance:editable` holder could reverse
  // (double-credit/debit) a transaction on ANY treasury account across
  // org-unit boundaries. Resolves the transaction's owning account and
  // scope-checks it first, via the same mechanism the ledger read uses.
  @RequirePermission('finance', 'editable')
  @Post('transactions/:id/reverse')
  async reverse(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: ReverseDto) {
    await this.treasury.assertTransactionAccess(id, req.user.id);
    return this.treasury.reverseTransaction(id, dto.reason, req.user.id);
  }
}
