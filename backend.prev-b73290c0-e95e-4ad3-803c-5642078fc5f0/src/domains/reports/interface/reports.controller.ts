import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ReportsService } from '../application/reports.service';
import { CustomerAccountsService } from '../application/customer-accounts.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { ExcelService, ColumnSpec } from '../../../foundation/excel/excel.service';

const SALES_ORDERS_COLUMNS: ColumnSpec[] = [
  { key: 'orderNumber', header: 'Order Number', width: 20 },
  { key: 'createdAt', header: 'Date', width: 20 },
  { key: 'customerName', header: 'Customer', width: 26 },
  { key: 'salesRepName', header: 'Sales Representative', width: 22 },
  { key: 'status', header: 'Status', width: 20 },
  { key: 'workflowPolicy', header: 'Workflow Policy', width: 16 },
  { key: 'totalAmount', header: 'Total Amount', width: 16 },
  { key: 'depositStatus', header: 'Deposit Status', width: 16 },
  { key: 'depositAmount', header: 'Deposit Amount', width: 16 },
];

const SALES_BY_PERIOD_COLUMNS: ColumnSpec[] = [
  { key: 'period', header: 'Period', width: 14 },
  { key: 'orderCount', header: 'Order Count', width: 14 },
  { key: 'totalAmount', header: 'Total Amount', width: 16 },
];

const SALES_BY_CUSTOMER_COLUMNS: ColumnSpec[] = [
  { key: 'customerName', header: 'Customer', width: 26 },
  { key: 'orderCount', header: 'Order Count', width: 14 },
  { key: 'totalAmount', header: 'Total Amount', width: 16 },
];

const SALES_BY_REP_COLUMNS: ColumnSpec[] = [
  { key: 'salesRepName', header: 'Sales Representative', width: 22 },
  { key: 'orderCount', header: 'Order Count', width: 14 },
  { key: 'totalAmount', header: 'Total Amount', width: 16 },
];

const CUSTODY_COD_COLUMNS: ColumnSpec[] = [
  { key: 'custodianType', header: 'Type', width: 12 },
  { key: 'custodianCode', header: 'Code', width: 20 },
  { key: 'custodianName', header: 'Name', width: 26 },
  { key: 'custodyBalance', header: 'Custody Balance', width: 18 },
  { key: 'activeShipmentsCount', header: 'Active Shipments', width: 16 },
  { key: 'codCollectedTotal', header: 'COD Collected', width: 16 },
  { key: 'codPendingTotal', header: 'COD Pending Remittance', width: 20 },
  { key: 'codRemittedTotal', header: 'COD Remitted', width: 16 },
];

/**
 * Operational Reports — reads broadly available to every authenticated
 * user (matches the rest of the platform's "reads broadly available"
 * boundary); each report's underlying data is already Scope-filtered by
 * the domain service it calls (`SalesOrdersService.listOrders`), so a
 * plain sales_rep viewing these reports sees only their own orders,
 * automatically — no separate role/scope gate needed here.
 */
@Controller('reports')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('reporting')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly customerAccounts: CustomerAccountsService,
    private readonly excel: ExcelService,
  ) {}

  /** Customer Financial Account / AR (CTO directive) — the primary statement, sourced from the real Customer Ledger, never a stored/cached balance. */
  @Get('customer-accounts/:customerId')
  async customerAccount(@Req() req: AuthenticatedRequest, @Param('customerId') customerId: string) {
    return this.customerAccounts.getCustomerAccountStatement(customerId, req.user.id);
  }

  /** Cross-check against the ORIGINAL live-composition statement (pre-Customer-Ledger) — useful for historical orders with no ledger rows yet. Declared AFTER the ':customerId' route above is fine (this is a nested static suffix, not a sibling wildcard). */
  @Get('customer-accounts/:customerId/reconcile')
  async customerAccountReconcile(@Req() req: AuthenticatedRequest, @Param('customerId') customerId: string) {
    return this.customerAccounts.getCustomerAccountReconciliation(customerId, req.user.id);
  }

  @Get('sales-orders')
  async salesOrders(@Req() req: AuthenticatedRequest) {
    return this.reports.getSalesOrdersReport(req.user.id);
  }

  // Security Assurance Gate — Track S7 (Resource Exhaustion): every export
  // route here runs an unbounded, unpaginated full-dataset query (a
  // deliberate, previously-reviewed design — aggregation reports can't be
  // paginated without breaking correctness, see MASTER_PROJECT_STATUS.md
  // §6) then builds a full XLSX buffer in memory. The generic 300/min
  // global throttle was sized for ordinary UI navigation, not for bounding
  // repeated heavy report/export generation — narrowed here the same way
  // `AuthController` already narrows its own sensitive routes.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('sales-orders/export')
  async salesOrdersExport(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const rows = await this.reports.getSalesOrdersReport(req.user.id);
    const buffer = await this.excel.buildExport('Sales Orders Report', SALES_ORDERS_COLUMNS, rows.map((r) => ({ ...r })));
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="sales-orders-report.xlsx"',
      })
      .send(buffer);
  }

  @Get('sales-by-period')
  async salesByPeriod(@Req() req: AuthenticatedRequest, @Query('groupBy') groupBy?: 'day' | 'month') {
    return this.reports.getSalesByPeriod(req.user.id, groupBy === 'month' ? 'month' : 'day');
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // S7 — see salesOrdersExport's own comment
  @Get('sales-by-period/export')
  async salesByPeriodExport(@Req() req: AuthenticatedRequest, @Res() res: Response, @Query('groupBy') groupBy?: 'day' | 'month') {
    const rows = await this.reports.getSalesByPeriod(req.user.id, groupBy === 'month' ? 'month' : 'day');
    const buffer = await this.excel.buildExport('Sales by Period', SALES_BY_PERIOD_COLUMNS, rows.map((r) => ({ ...r })));
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="sales-by-period.xlsx"',
      })
      .send(buffer);
  }

  @Get('sales-by-customer')
  async salesByCustomer(@Req() req: AuthenticatedRequest) {
    return this.reports.getSalesByCustomer(req.user.id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // S7 — see salesOrdersExport's own comment
  @Get('sales-by-customer/export')
  async salesByCustomerExport(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const rows = await this.reports.getSalesByCustomer(req.user.id);
    const buffer = await this.excel.buildExport('Sales by Customer', SALES_BY_CUSTOMER_COLUMNS, rows.map((r) => ({ ...r })));
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="sales-by-customer.xlsx"',
      })
      .send(buffer);
  }

  @Get('sales-by-rep')
  async salesByRep(@Req() req: AuthenticatedRequest) {
    return this.reports.getSalesByRep(req.user.id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // S7 — see salesOrdersExport's own comment
  @Get('sales-by-rep/export')
  async salesByRepExport(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const rows = await this.reports.getSalesByRep(req.user.id);
    const buffer = await this.excel.buildExport('Sales by Sales Representative', SALES_BY_REP_COLUMNS, rows.map((r) => ({ ...r })));
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="sales-by-rep.xlsx"',
      })
      .send(buffer);
  }

  /** Custody / COD Reporting (CTO directive, Phase 5) — money-sensitive, same admin/finance tier as Treasury's own routes and the pending-remittance queue. */
  @UseGuards(PermissionGuard)
  @RequirePermission('reporting.finance.view', 'read-only')
  @Get('custody-cod')
  async custodyCod() {
    return this.reports.getCustodyCodReport();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('reporting.finance.export', 'read-only')
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // S7 — see salesOrdersExport's own comment
  @Get('custody-cod/export')
  async custodyCodExport(@Res() res: Response) {
    const report = await this.reports.getCustodyCodReport();
    const buffer = await this.excel.buildExport('Custody & COD Report', CUSTODY_COD_COLUMNS, report.rows.map((r) => ({ ...r })));
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="custody-cod-report.xlsx"',
      })
      .send(buffer);
  }
}
