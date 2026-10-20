import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Query, Req, UnauthorizedException, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { IsIn, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { TreasuryService } from '../application/treasury.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { IdempotencyService } from '../../../foundation/error-contract/idempotency.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

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

/**
 * T2 (transitional restriction, 2026-10-20) — the generic cash-in / cash-out endpoints stay (no caller is broken) but may no longer carry misleading business
 * labels or be anonymous: a customer / sales-order label on a direct movement creates NO receivable effect (the customer's invoice stays open), so it is refused
 * and the user is pointed to the customer payment flow; a purpose (`reason`) and a supporting `reference` are mandatory. Removal of these endpoints waits for a
 * reviewed caller inventory (every call is audited as `treasury.cash_in` / `treasury.cash_out` with `direct: true`).
 */
function assertGenericCashEntry(dto: CashMoveDto): void {
  if (dto.customerId || dto.salesOrderId) {
    throw new UnprocessableEntityException(
      'A customer or sales order cannot be attached to a generic cash movement — it would not settle any invoice or change the customer account. Record the receipt as a customer payment instead. Nothing was recorded.',
    );
  }
  if (!dto.reason || dto.reason.trim().length < 3) throw new BadRequestException('A purpose (reason) is required for a generic cash movement. Nothing was recorded.');
  if (!dto.reference || dto.reference.trim().length < 1) throw new BadRequestException('A reference (the supporting document number) is required for a generic cash movement. Nothing was recorded.');
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
/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * `CompanyContextGuard` added at the class level — `TreasuryAccount`/
 * `TreasuryAccountType`/`TreasuryTransaction` are genuinely Company-owned
 * data. Picked specifically because §26 (`shipment.controller.ts`
 * STOP/ESCALATE) named `TreasuryService.listAccountTypes`/`createAccount`
 * as blockers — both are now manager-capable, unblocking that controller's
 * eventual retrofit. Two foundation-level gaps were found and fixed in the
 * same pass, both discovered via this controller's own `ScopeResolver`
 * dependency: `OrganizationService` and `IdempotencyService` were still
 * `@InjectRepository`-based, the exact same structural gap `ScopeService`
 * had before its own fix (§16) — see `organization.service.ts`/
 * `idempotency.service.ts`.
 */
@Controller('treasury')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
@RequireModule('finance')
export class TreasuryController {
  constructor(
    private readonly treasury: TreasuryService,
    private readonly idempotency: IdempotencyService,
    private readonly events: EventBusService,
  ) {}

  @RequirePermission('finance.cash_account.manage', 'editable')
  @Post('account-types')
  async createAccountType(@Req() req: CompanyScopedRequest, @Body() dto: CreateAccountTypeDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.treasury.createAccountType(dto.code, dto.name, req.user.id, req.companyContext.dataSource.manager);
  }

  @RequirePermission('finance.cash.view', 'editable')
  @Get('account-types')
  async listAccountTypes(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.treasury.listAccountTypes(req.companyContext.dataSource.manager);
  }

  @RequirePermission('finance.cash_account.manage', 'editable')
  @Post('accounts')
  async createAccount(@Req() req: CompanyScopedRequest, @Body() dto: CreateAccountDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.treasury.createAccount(dto.code, dto.name, dto.accountTypeId, req.user.id, req.companyContext.dataSource.manager);
  }

  @RequirePermission('finance.cash.view', 'editable')
  @Get('accounts')
  async listAccounts(@Req() req: CompanyScopedRequest, @Query('search') search?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.treasury.listAccountsWithBalances(req.user.id, { search }, req.companyContext.dataSource.manager);
  }

  // AUDIT-SEC-28 (S21, 2026-09-10): `setAccountStatus` had a permission
  // gate only — no Scope check, unlike the sibling `ledger` read
  // (`assertLedgerAccountAccess`). Any `finance:editable` holder could
  // deactivate/reactivate any branch's account. Now scope-checked first.
  @RequirePermission('finance.cash_account.manage', 'editable')
  @Post('accounts/:id/status')
  async setAccountStatus(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetAccountStatusDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.treasury.assertLedgerAccountAccess(id, req.user.id, manager);
    return this.treasury.setAccountStatus(id, dto.status, req.user.id, manager);
  }

  /**
   * F06 / F06-H1 (ADR-038 D7). Map a Treasury account to its GL account
   * (a `bank` control account), or clear the mapping. Scope-checked first,
   * the same as `setAccountStatus`.
   */
  @RequirePermission('finance.cash_account.mapping.manage', 'editable')
  @Post('accounts/:id/gl-mapping')
  async setGlMapping(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetGlMappingDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.treasury.assertLedgerAccountAccess(id, req.user.id, manager);
    return this.treasury.setAccountGlMapping(id, dto.glAccountCode ?? null, req.user.id, manager);
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
  @RequirePermission('finance.cash.post', 'editable')
  @Post('cash-in')
  async cashIn(@Req() req: CompanyScopedRequest, @Body() dto: CashMoveDto, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    assertGenericCashEntry(dto);
    const manager = req.companyContext.dataSource.manager;
    // F06-H1: the Treasury-UI path uses `cashInDirect` — the emitting
    // variant. The `FinanceTreasuryContract.cashIn` other domains call
    // stays non-emitting (ADR-038 D4).
    // T-06x: the dedup record and the cash movement commit together under a per-key lock (`withIdempotency` wrote the record after the operation, without a lock: concurrent same-key requests all executed).
    const result = await this.idempotency.withIdempotencyInTransaction(
      'treasury.cash-in',
      idempotencyKey,
      (tx) => this.treasury.cashInDirect(dto.accountId, dto.amount, dto.customerId ?? null, dto.salesOrderId ?? null, dto.reference ?? null, dto.reason ?? null, req.user!.id, tx),
      manager,
    );
    await this.events.dispatchAfterCommit(manager);
    return result;
  }

  /** Same finding/fix as `cashIn` above. */
  @RequirePermission('finance.cash.post', 'editable')
  @Post('cash-out')
  async cashOut(@Req() req: CompanyScopedRequest, @Body() dto: CashMoveDto, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    assertGenericCashEntry(dto);
    const manager = req.companyContext.dataSource.manager;
    // T-06x: the dedup record and the cash movement commit together under a per-key lock (`withIdempotency` wrote the record after the operation, without a lock: concurrent same-key requests all executed).
    const result = await this.idempotency.withIdempotencyInTransaction(
      'treasury.cash-out',
      idempotencyKey,
      (tx) => this.treasury.cashOutDirect(dto.accountId, dto.amount, dto.customerId ?? null, dto.salesOrderId ?? null, dto.reference ?? null, dto.reason ?? null, req.user!.id, tx),
      manager,
    );
    await this.events.dispatchAfterCommit(manager);
    return result;
  }

  /** Same finding/fix as `cashIn` above — a retried transfer would otherwise post a second pair of legs. */
  @RequirePermission('finance.cash.transfer', 'editable')
  @Post('transfer')
  async transfer(@Req() req: CompanyScopedRequest, @Body() dto: TransferDto, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    // T-06x: the dedup record and the cash movement commit together under a per-key lock (`withIdempotency` wrote the record after the operation, without a lock: concurrent same-key requests all executed).
    const result = await this.idempotency.withIdempotencyInTransaction(
      'treasury.transfer',
      idempotencyKey,
      (tx) => this.treasury.transferDirect(dto.sourceAccountId, dto.destinationAccountId, dto.amount, dto.reference ?? null, dto.reason ?? null, req.user!.id, tx),
      manager,
    );
    await this.events.dispatchAfterCommit(manager);
    return result;
  }

  /** AUDIT-SEC-03 (F3) remediation: an `accountId` filter must pass ScopeResolver before the ledger query runs — was previously any `finance:editable` user, any account, no check. */
  @RequirePermission('finance.cash.view', 'editable')
  @Get('ledger')
  async ledger(
    @Req() req: CompanyScopedRequest,
    @Query('accountId') accountId?: string,
    @Query('customerId') customerId?: string,
    @Query('salesOrderId') salesOrderId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    if (accountId) await this.treasury.assertLedgerAccountAccess(accountId, req.user.id, manager);
    if (page === undefined && pageSize === undefined) {
      return this.treasury.listLedger({ accountId, customerId, salesOrderId }, manager);
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.treasury.listLedgerPage({ accountId, customerId, salesOrderId }, { page: parsedPage, pageSize: parsedPageSize }, manager);
  }

  // AUDIT-SEC-28 (S21, 2026-09-10): same gap — `reverseTransaction` had
  // no Scope check, so any `finance:editable` holder could reverse
  // (double-credit/debit) a transaction on ANY treasury account across
  // org-unit boundaries. Resolves the transaction's owning account and
  // scope-checks it first, via the same mechanism the ledger read uses.
  @RequirePermission('finance.cash.reverse', 'editable')
  @Post('transactions/:id/reverse')
  async reverse(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: ReverseDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.treasury.assertTransactionAccess(id, req.user.id, manager);
    return this.treasury.reverseTransaction(id, dto.reason, req.user.id, manager);
  }
}
