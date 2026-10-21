import { Body, Controller, Headers, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { SupplierPaymentReversalService } from '../application/supplier-payment-reversal.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { IdempotencyService } from '../../../foundation/error-contract/idempotency.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

class ReverseSupplierPaymentDto {
  @IsString()
  @MinLength(3)
  reason!: string;
}

/**
 * T2-S — reverse a SUPPLIER payment through its owning document (Treasury leg + Supplier Ledger + invoice status + GL mirror, one transaction). Own permission node
 * (`finance.supplier_payment.reverse`, separate from recording a payment); `Idempotency-Key` is honoured, and the DB's UNIQUE(supplierPaymentId) makes a double reversal
 * impossible regardless.
 */
@Controller('procurement/supplier-payments')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('procurement')
export class SupplierPaymentReversalController {
  constructor(
    private readonly reversals: SupplierPaymentReversalService,
    private readonly idempotency: IdempotencyService,
    private readonly events: EventBusService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('finance.supplier_payment.reverse', 'editable')
  @Post(':id/reverse')
  async reverse(
    @Req() req: CompanyScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseSupplierPaymentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const result = await this.idempotency.withIdempotencyInTransaction(
      'supplier_payments.reverse',
      idempotencyKey,
      (txManager) => this.reversals.reversePayment(id, dto.reason, req.user!.id, txManager),
      req.companyContext.dataSource.manager,
    );
    await this.events.dispatchAfterCommit(req.companyContext.dataSource.manager);
    return result;
  }
}
