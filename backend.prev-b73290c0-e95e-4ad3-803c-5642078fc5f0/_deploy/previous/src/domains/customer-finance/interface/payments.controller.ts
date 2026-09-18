import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaymentsService } from '../application/payments.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RolesGuard } from '../../../foundation/authorization/roles.guard';
import { RequireRole } from '../../../foundation/authorization/require-role.decorator';

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
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'finance')
  @Post('payments')
  async record(@Req() req: AuthenticatedRequest, @Body() dto: RecordPaymentDto) {
    return this.payments.recordPayment(dto.customerId, dto.invoiceId, dto.amount, dto.method, dto.treasuryAccountId, dto.reference ?? null, req.user.id);
  }

  @Get('customers/:id/payments')
  async listForCustomer(@Param('id') id: string) {
    return this.payments.listPaymentsForCustomer(id);
  }

  /** ERP UI Integration (CTO directive) — the "التحصيلات والمدفوعات" list screen, across every customer the caller may see. Scope-filtered, not role-gated (a rep legitimately sees their own customers' payment history); recording a payment stays finance/admin-gated above. */
  @Get('payments')
  async listAll(@Req() req: AuthenticatedRequest) {
    return this.payments.listAllPayments(req.user.id);
  }
}
