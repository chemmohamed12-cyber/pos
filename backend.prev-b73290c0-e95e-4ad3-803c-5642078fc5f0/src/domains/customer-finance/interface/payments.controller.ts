import { Body, Controller, Get, Headers, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaymentsService } from '../application/payments.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
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

@Controller()
@UseGuards(JwtAuthGuard, RequireModuleGuard)
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
  async record(@Req() req: AuthenticatedRequest, @Body() dto: RecordPaymentDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const result = await this.idempotency.withIdempotencyInTransaction('payments.record', idempotencyKey, (manager) =>
      this.payments.recordPayment(dto.customerId, dto.invoiceId, dto.amount, dto.method, dto.treasuryAccountId, dto.reference ?? null, req.user.id, manager),
    );
    await this.events.dispatchPending();
    return result;
  }

  /** AUDIT-SEC-03 remediation: previously no Scope check and no permission node at all — any authenticated user with the `finance` module entitled could list ANY customer's payment history by id. */
  @Get('customers/:id/payments')
  async listForCustomer(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.customers.getCustomer(id, req.user.id);
    return this.payments.listPaymentsForCustomer(id);
  }

  /** ERP UI Integration (CTO directive) — the "التحصيلات والمدفوعات" list screen, across every customer the caller may see. Scope-filtered, not role-gated (a rep legitimately sees their own customers' payment history); recording a payment stays finance/admin-gated above. */
  @Get('payments')
  async listAll(@Req() req: AuthenticatedRequest) {
    return this.payments.listAllPayments(req.user.id);
  }
}
