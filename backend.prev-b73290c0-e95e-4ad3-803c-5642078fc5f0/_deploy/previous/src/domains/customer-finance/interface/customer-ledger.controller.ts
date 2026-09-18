import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { CustomerLedgerService } from '../application/customer-ledger.service';
import { CustomersService } from '../../crm/application/customers.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';

@Controller('customer-finance')
@UseGuards(JwtAuthGuard)
export class CustomerLedgerController {
  constructor(
    private readonly ledger: CustomerLedgerService,
    private readonly customers: CustomersService,
  ) {}

  @Get('ledger/:customerId')
  async listLedger(
    @Req() req: AuthenticatedRequest,
    @Param('customerId') customerId: string,
    @Query('entryType') entryType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.customers.getCustomer(customerId, req.user.id); // Scope-checked (404s outside the caller's own Scope)
    return this.ledger.listLedger(customerId, { entryType, from, to });
  }

  @Get('credit-summary/:customerId')
  async creditSummary(@Req() req: AuthenticatedRequest, @Param('customerId') customerId: string) {
    await this.customers.getCustomer(customerId, req.user.id);
    return this.ledger.getCreditSummary(customerId);
  }

  /** ERP UI Integration — "حسابات العملاء" list + section-cover KPIs. Scope-filtered via `CustomersService.listCustomers`, not a separate access check. */
  @Get('balances')
  async balances(@Req() req: AuthenticatedRequest) {
    return this.ledger.getBalancesForVisibleCustomers(req.user.id);
  }
}
