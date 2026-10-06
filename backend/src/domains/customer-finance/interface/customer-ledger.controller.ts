import { Controller, Get, Inject, Param, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { CustomerLedgerService } from '../application/customer-ledger.service';
import { SALES_CUSTOMERS_CONTRACT, SalesCustomersContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModule, RequireModuleGuard } from '../../../foundation/module-registry/require-module.decorator';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * `CompanyContextGuard` added — `CustomerLedgerEntry`/`Customer` are
 * genuinely Company-owned data. Picked after `invoices.controller.ts`
 * (same `customer-finance` domain) was found to transitively depend on
 * `accounting`'s un-retrofitted `TaxEngineService` — this controller's
 * own 3 routes never touch invoicing/tax, confirmed by direct read of
 * `CustomerLedgerService`'s full file before starting (see
 * AREA21-RETROFIT-MATRIX.md §25).
 */
@Controller('customer-finance')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('finance')
export class CustomerLedgerController {
  constructor(
    private readonly ledger: CustomerLedgerService,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
  ) {}

  @Get('ledger/:customerId')
  async listLedger(
    @Req() req: CompanyScopedRequest,
    @Param('customerId') customerId: string,
    @Query('entryType') entryType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(customerId, req.user.id, manager); // Scope-checked (404s outside the caller's own Scope)
    return this.ledger.listLedger(customerId, { entryType, from, to }, manager);
  }

  @Get('credit-summary/:customerId')
  async creditSummary(@Req() req: CompanyScopedRequest, @Param('customerId') customerId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(customerId, req.user.id, manager);
    return this.ledger.getCreditSummary(customerId, manager);
  }

  /** ERP UI Integration — "حسابات العملاء" list + section-cover KPIs. Scope-filtered via `CustomersService.listCustomers`, not a separate access check. */
  @Get('balances')
  async balances(@Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.ledger.getBalancesForVisibleCustomers(req.user.id, req.companyContext.dataSource.manager);
  }
}
