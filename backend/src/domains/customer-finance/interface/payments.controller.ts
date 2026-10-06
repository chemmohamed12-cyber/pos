import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaymentsService } from '../application/payments.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { SALES_CUSTOMERS_CONTRACT, SalesCustomersContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { IdempotencyService } from '../../../foundation/error-contract/idempotency.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

class RecordPaymentDto {
  @IsString()
  customerId!: string;

  @IsString()
  invoiceId!: string;

  @IsNumberString()
  amount!: string;

  @IsString()
  method!: string;

  @IsUUID()
  treasuryAccountId!: string;

  @IsOptional()
  @IsString()
  reference?: string;
}

/** CUS-01 — an on-account / advance payment: no invoice yet; optionally earmarked for a sales order of the same customer. */
class RecordOnAccountPaymentDto {
  @IsUUID()
  customerId!: string;

  @IsOptional()
  @IsUUID()
  salesOrderId?: string;

  @IsNumberString()
  amount!: string;

  @IsString()
  method!: string;

  @IsUUID()
  treasuryAccountId!: string;

  @IsOptional()
  @IsString()
  reference?: string;
}

/** CUS-01 — explicit settlement of an unapplied receipt against an invoice (partial amounts supported). */
class ApplyPaymentDto {
  @IsUUID()
  invoiceId!: string;

  @IsNumberString()
  amount!: string;
}

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized,
 * controller #13). `CompanyContextGuard` added at the class level — every
 * route threads `req.companyContext.dataSource.manager` into
 * `PaymentsService`.
 */
@Controller()
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('finance')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
    private readonly idempotency: IdempotencyService,
    private readonly events: EventBusService,
  ) {}

  /**
   * Security Assurance Gate — Track S4 (Business Logic / Sequencing
   * Abuse), found 2026-09-08: `IdempotencyService` (`DAII_API_ARCHITECTURE.md`
   * §6's own "belt-and-suspenders" backstop for a duplicate submission —
   * e.g. a lost-response network retry, or a double-click before a
   * button disables) existed as infrastructure, fully unit-tested, but
   * had ZERO real call sites anywhere in the application — genuinely dead
   * code, not a working control. Payment recording is the highest-value
   * place to wire it first: `recordPayment`'s own remaining-balance check
   * only catches a duplicate that would OVERPAY the invoice — a duplicate
   * PARTIAL payment (e.g. two identical $50 postings against $200 owed)
   * is individually valid each time and was never caught, a genuine
   * duplicate financial effect. Opt-in via the standard `Idempotency-Key`
   * header — a caller that doesn't send one gets the exact previous,
   * unchanged behaviour (`IdempotencyService.withIdempotency` runs the
   * operation unconditionally when no key is given), so this is
   * additive, not a breaking change.
   *
   * Gap Resolution Package 3 (2026-09-14): switched from `withIdempotency`
   * to `withIdempotencyInTransaction` — the dedup record and every write
   * `recordPayment` makes now commit or roll back together (rows 33/34).
   * `dispatchPending()` runs after the wrapper's transaction returns
   * (committed either way — a cache hit's read-only path or a fresh
   * write), same "only the transaction owner dispatches" convention
   * `TreasuryService.cashInCore` already uses.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.payment.create', 'editable')
  @Post('payments')
  async record(@Req() req: CompanyScopedRequest, @Body() dto: RecordPaymentDto, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const result = await this.idempotency.withIdempotencyInTransaction(
      'payments.record',
      idempotencyKey,
      (txManager) =>
        this.payments.recordPayment(dto.customerId, dto.invoiceId, dto.amount, dto.method, dto.treasuryAccountId, dto.reference ?? null, req.user!.id, txManager),
      req.companyContext.dataSource.manager,
    );
    await this.events.dispatchAfterCommit(req.companyContext.dataSource.manager);
    return result;
  }

  /** CUS-01 — record an on-account / advance customer payment (Dr mapped bank / Cr `ar`; unapplied credit in the Customer Ledger). */
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.payment.create', 'editable')
  @Post('payments/on-account')
  async recordOnAccount(@Req() req: CompanyScopedRequest, @Body() dto: RecordOnAccountPaymentDto, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const result = await this.idempotency.withIdempotencyInTransaction(
      'payments.record_on_account',
      idempotencyKey,
      (txManager) =>
        this.payments.recordOnAccountPayment(dto.customerId, dto.salesOrderId ?? null, dto.amount, dto.method, dto.treasuryAccountId, dto.reference ?? null, req.user!.id, txManager),
      req.companyContext.dataSource.manager,
    );
    await this.events.dispatchAfterCommit(req.companyContext.dataSource.manager);
    return result;
  }

  /** CUS-01 — settle (part of) an unapplied receipt against an invoice. */
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.payment.create', 'editable')
  @Post('payments/:id/apply')
  async apply(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: ApplyPaymentDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.payments.applyPayment(id, dto.invoiceId, dto.amount, req.user.id, req.companyContext.dataSource.manager);
  }

  /** CUS-01 — "Customer Advance / Unapplied Receipt" list (Scope-filtered, optionally for one customer). */
  @Get('payments/unapplied')
  async listUnapplied(@Req() req: CompanyScopedRequest, @Query('customerId') customerId?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.payments.listUnappliedPayments(req.user.id, customerId, req.companyContext.dataSource.manager);
  }

  /** AUDIT-SEC-03 remediation: previously no Scope check and no permission node at all — any authenticated user with the `finance` module entitled could list ANY customer's payment history by id. */
  @Get('customers/:id/payments')
  async listForCustomer(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.customers.getCustomer(id, req.user.id, req.companyContext.dataSource.manager);
    return this.payments.listPaymentsForCustomer(id, req.companyContext.dataSource.manager);
  }

  /** ERP UI Integration (CTO directive) — the "التحصيلات والمدفوعات" list screen, across every customer the caller may see. Scope-filtered, not role-gated (a rep legitimately sees their own customers' payment history); recording a payment stays finance/admin-gated above. */
  @Get('payments')
  async listAll(@Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.payments.listAllPayments(req.user.id, req.companyContext.dataSource.manager);
  }
}
