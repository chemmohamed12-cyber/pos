import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { JournalEntryService } from '../application/journal-entry.service';
import { LedgerService } from '../application/ledger.service';
import { FinancialReportingService, SectionAccountRow } from '../application/financial-reporting.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { ExcelService, ColumnSpec } from '../../../foundation/excel/excel.service';
import { JOURNAL_SOURCE_TYPES } from '../domain/journal';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class JournalLineDimensionDto {
  @IsUUID()
  dimensionTypeId!: string;

  @IsUUID()
  dimensionValueId!: string;
}

class JournalLineDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string | null;

  @IsOptional()
  @IsNumberString()
  debit?: string;

  @IsOptional()
  @IsNumberString()
  credit?: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JournalLineDimensionDto)
  dimensions?: JournalLineDimensionDto[];
}

class CreateJournalEntryDto {
  @IsIn(JOURNAL_SOURCE_TYPES.filter((s) => s === 'MANUAL' || s === 'OPENING'))
  sourceType!: string;

  @IsISO8601()
  businessDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string | null;

  @IsString()
  @MinLength(3)
  @MaxLength(3)
  transactionCurrencyCode!: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}

class UpdateJournalEntryDto {
  @IsOptional()
  @IsISO8601()
  businessDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  transactionCurrencyCode?: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines?: JournalLineDto[];
}

// F14 (ADR-047 D8) — export column specs, matching `ReportsController`'s own `ColumnSpec[]` convention.
const BALANCE_SHEET_COLUMNS: ColumnSpec[] = [
  { key: 'section', header: 'Section', width: 16 },
  { key: 'code', header: 'Account Code', width: 16 },
  { key: 'name', header: 'Account Name', width: 32 },
  { key: 'balance', header: 'Amount', width: 18 },
];

const CASH_FLOW_COLUMNS: ColumnSpec[] = [
  { key: 'line', header: 'Line', width: 40 },
  { key: 'amount', header: 'Amount', width: 18 },
];

class ReverseJournalEntryDto {
  @IsOptional()
  @IsISO8601()
  businessDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;
}

/**
 * F03 — General Ledger + Financial Event Engine (Blueprint §20). Every
 * route: `@RequireModule('accounting')` (404 for an un-entitled module,
 * checked before permission — no admin bypass) + a per-route
 * `@RequirePermission('accounting.<feature>.<action>')`, the exact guard
 * stack F01/F02 use.
 */
/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * `CompanyContextGuard` at class level — every route threads
 * `req.companyContext.dataSource.manager` into the journal/ledger/reporting/
 * financial-event services.
 */
@Controller('accounting')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('accounting')
export class GeneralLedgerController {
  constructor(
    private readonly journals: JournalEntryService,
    private readonly ledger: LedgerService,
    private readonly reporting: FinancialReportingService,
    private readonly financialEvents: FinancialEventService,
    private readonly excel: ExcelService,
  ) {}

  // ---- Journals ----

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.journal.view', 'read-only')
  @Get('journals')
  async listJournals(
    @Req() req: CompanyScopedRequest,
    @Query('status') status?: string,
    @Query('sourceType') sourceType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('accountId') accountId?: string,
  ) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.journals.listEntries(
      {
        status: status as never,
        sourceType: sourceType as never,
        from,
        to,
        accountId,
      },
      manager,
    );
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.journal.view', 'read-only')
  @Get('journals/:id')
  async getJournal(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.journals.getEntry(id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.journal.create', 'editable')
  @Post('journals')
  async createJournal(@Body() dto: CreateJournalEntryDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.journals.createEntry(dto as never, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.journal.edit', 'editable')
  @Post('journals/:id')
  async updateJournal(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateJournalEntryDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.journals.updateEntry(id, dto as never, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.journal.submit', 'editable')
  @Post('journals/:id/submit')
  async submitJournal(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.journals.submitEntry(id, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.journal.post', 'editable')
  @Post('journals/:id/post')
  async postJournal(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.journals.postEntry(id, req.user.id, {}, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.journal.reverse', 'editable')
  @Post('journals/:id/reverse')
  async reverseJournal(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReverseJournalEntryDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.journals.reverseEntry(id, req.user.id, dto, manager);
  }

  // ---- Ledger ----

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ledger.view', 'read-only')
  @Get('ledger')
  async getLedgerOverview(@Req() req: CompanyScopedRequest, @Query('from') from?: string, @Query('to') to?: string, @Query('orgUnitId') orgUnitId?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.ledger.getTrialBalance({ from, to, orgUnitId }, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ledger.view', 'read-only')
  @Get('trial-balance')
  async getTrialBalance(@Req() req: CompanyScopedRequest, @Query('from') from?: string, @Query('to') to?: string, @Query('orgUnitId') orgUnitId?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.ledger.getTrialBalance({ from, to, orgUnitId }, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ledger.view', 'read-only')
  @Get('ledger/:accountId')
  async getAccountLedger(
    @Req() req: CompanyScopedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('orgUnitId') orgUnitId?: string,
  ) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.ledger.getAccountLedger(accountId, { from, to, orgUnitId }, manager);
  }

  // ---- Reports (F14, ADR-047) — a pure read model: these routes never create a Journal Entry, never
  // change a Process Engine state, never touch AR/AP/Treasury/Inventory. Drill-down reuses the SAME
  // `getAccountLedger` above — no new ledger/detail mechanism (D2). ----

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.report.view', 'read-only')
  @Get('reports/balance-sheet')
  async getBalanceSheet(@Req() req: CompanyScopedRequest, @Query('asOfDate') asOfDate: string, @Query('orgUnitId') orgUnitId?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.reporting.getBalanceSheet({ asOfDate, orgUnitId }, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.report.export', 'read-only')
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // S7 — matches `ReportsController`'s own export throttle
  @Get('reports/balance-sheet/export')
  async exportBalanceSheet(@Req() req: CompanyScopedRequest, @Query('asOfDate') asOfDate: string, @Query('orgUnitId') orgUnitId: string | undefined, @Res() res: Response) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const bs = await this.reporting.getBalanceSheet({ asOfDate, orgUnitId }, manager);
    const rows = [
      ...bs.assets.map((r) => this.reportRow('Assets', r)),
      { section: 'Assets', code: '', name: 'Total Assets', balance: bs.assetsTotal },
      ...bs.liabilities.map((r) => this.reportRow('Liabilities', r)),
      { section: 'Liabilities', code: '', name: 'Total Liabilities', balance: bs.liabilitiesTotal },
      ...bs.equity.map((r) => this.reportRow('Equity', r)),
      { section: 'Equity', code: '', name: 'Unclosed Net Income (computed)', balance: bs.unclosedNetIncome },
      { section: 'Equity', code: '', name: 'Total Equity', balance: bs.equityTotal },
    ];
    const buffer = await this.excel.buildExport('Balance Sheet', BALANCE_SHEET_COLUMNS, rows);
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="balance-sheet.xlsx"',
      })
      .send(buffer);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.report.view', 'read-only')
  @Get('reports/profit-and-loss')
  async getProfitAndLoss(@Req() req: CompanyScopedRequest, @Query('from') from: string, @Query('to') to: string, @Query('orgUnitId') orgUnitId?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.reporting.getProfitAndLoss({ from, to, orgUnitId }, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.report.export', 'read-only')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('reports/profit-and-loss/export')
  async exportProfitAndLoss(
    @Req() req: CompanyScopedRequest,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('orgUnitId') orgUnitId: string | undefined,
    @Res() res: Response,
  ) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const pnl = await this.reporting.getProfitAndLoss({ from, to, orgUnitId }, manager);
    const rows = [
      ...pnl.revenue.map((r) => this.reportRow('Revenue', r)),
      { section: 'Revenue', code: '', name: 'Total Revenue', balance: pnl.revenueTotal },
      ...pnl.expenses.map((r) => this.reportRow('Expenses', r)),
      { section: 'Expenses', code: '', name: 'Total Expenses', balance: pnl.expensesTotal },
      { section: 'Net Income', code: '', name: 'Net Income', balance: pnl.netIncome },
    ];
    const buffer = await this.excel.buildExport('Profit and Loss', BALANCE_SHEET_COLUMNS, rows);
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="profit-and-loss.xlsx"',
      })
      .send(buffer);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.report.view', 'read-only')
  @Get('reports/cash-flow')
  async getCashFlowStatement(@Req() req: CompanyScopedRequest, @Query('from') from: string, @Query('to') to: string, @Query('orgUnitId') orgUnitId?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.reporting.getCashFlowStatement({ from, to, orgUnitId }, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.report.export', 'read-only')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('reports/cash-flow/export')
  async exportCashFlowStatement(
    @Req() req: CompanyScopedRequest,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('orgUnitId') orgUnitId: string | undefined,
    @Res() res: Response,
  ) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const cf = await this.reporting.getCashFlowStatement({ from, to, orgUnitId }, manager);
    const rows = [
      { line: 'Beginning Cash', amount: cf.beginningCash },
      { line: 'Operating — Net Income', amount: cf.operating.periodNetIncome },
      { line: 'Operating — Depreciation Add-back', amount: cf.operating.depreciationAddBack },
      { line: 'Operating — AR Movement', amount: cf.operating.arDelta },
      { line: 'Operating — AP Movement', amount: cf.operating.apDelta },
      { line: 'Operating — Inventory Movement', amount: cf.operating.inventoryDelta },
      { line: 'Operating Total', amount: cf.operating.total },
      { line: 'Investing — Acquisitions (cash out)', amount: cf.investing.acquisitionsCashOutflow },
      { line: 'Investing — Disposals (cash in)', amount: cf.investing.disposalsCashInflow },
      { line: 'Investing Total', amount: cf.investing.total },
      { line: 'Financing Total (' + cf.financing.note + ')', amount: cf.financing.total },
      { line: 'Unclassified / Other (reconciling)', amount: cf.unclassifiedOther },
      { line: 'Net Change in Cash', amount: cf.netChangeActual },
      { line: 'Ending Cash', amount: cf.endingCash },
    ];
    const buffer = await this.excel.buildExport('Cash Flow Statement', CASH_FLOW_COLUMNS, rows);
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="cash-flow-statement.xlsx"',
      })
      .send(buffer);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.report.view', 'read-only')
  @Get('reports/tax-period-summary/:taxPeriodId')
  async getTaxPeriodSummary(@Req() req: CompanyScopedRequest, @Param('taxPeriodId', ParseUUIDPipe) taxPeriodId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.reporting.getTaxPeriodSummary(taxPeriodId, manager);
  }

  private reportRow(section: string, r: SectionAccountRow): { section: string; code: string; name: string; balance: string } {
    return { section, code: r.code, name: r.nameAr ?? r.name, balance: r.balance };
  }

  // ---- Financial Events ----

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.financial_event.view', 'read-only')
  @Get('financial-events')
  async listFinancialEvents(@Req() req: CompanyScopedRequest, @Query('status') status?: string, @Query('sourceDomain') sourceDomain?: string, @Query('eventType') eventType?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.financialEvents.listEvents({ status: status as never, sourceDomain, eventType }, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.financial_event.view', 'read-only')
  @Get('financial-events/:id')
  async getFinancialEvent(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.financialEvents.getEvent(id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.journal.post', 'editable')
  @Post('financial-events/:id/redrive')
  async redriveFinancialEvent(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    return this.financialEvents.redrive(id, manager);
  }
}
