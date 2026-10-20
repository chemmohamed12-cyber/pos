import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNumberString, IsOptional, IsString, IsUUID, Matches, MinLength, ValidateNested } from 'class-validator';
import { BankStatementService } from '../application/bank-statement.service';
import { CashSessionService } from '../application/cash-session.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { IdempotencyService } from '../../../foundation/error-contract/idempotency.service';

class StatementLineDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  valueDate!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsString()
  @Matches(/^-?\d+(\.\d{1,2})?$/)
  amount!: string;
}

class ImportStatementDto {
  @IsUUID()
  treasuryAccountId!: string;

  @IsOptional()
  @IsString()
  statementNumber?: string;

  @IsOptional()
  @IsString()
  sourceName?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  periodStart!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  periodEnd!: string;

  @IsString()
  @Matches(/^-?\d+(\.\d{1,2})?$/)
  openingBalance!: string;

  @IsString()
  @Matches(/^-?\d+(\.\d{1,2})?$/)
  closingBalance!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => StatementLineDto)
  lines!: StatementLineDto[];
}

class ConfirmDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  transactionIds!: string[];
}

class ReasonDto {
  @IsString()
  @MinLength(3)
  reason!: string;
}

class OpenSessionDto {
  @IsUUID()
  treasuryAccountId!: string;

  @IsOptional()
  @IsUUID()
  custodianUserId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

class CloseSessionDto {
  @IsNumberString()
  countedAmount!: string;

  @IsOptional()
  @IsString()
  varianceReason?: string;
}

/**
 * T5 — bank statements: import, suggestions, confirmed matches, reconciliation. One permission node per action (view / import / match / unmatch / reconcile / reopen);
 * importing and matching never post anything.
 */
@Controller('treasury/bank-statements')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
@RequireModule('finance')
export class BankStatementsController {
  constructor(
    private readonly statements: BankStatementService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private ctx(req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return { userId: req.user.id, manager: req.companyContext.dataSource.manager };
  }

  @RequirePermission('finance.bank_statement.view', 'read-only')
  @Get()
  list(@Req() req: CompanyScopedRequest, @Query('treasuryAccountId') treasuryAccountId?: string, @Query('status') status?: string) {
    return this.statements.list({ treasuryAccountId, status }, this.ctx(req).manager);
  }

  @RequirePermission('finance.bank_statement.view', 'read-only')
  @Get(':id')
  get(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.get(id, this.ctx(req).manager);
  }

  @RequirePermission('finance.bank_statement.view', 'read-only')
  @Get(':id/reconciliation')
  reconciliation(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.reconciliation(id, this.ctx(req).manager);
  }

  @RequirePermission('finance.bank_statement.import', 'editable')
  @Post()
  import(@Req() req: CompanyScopedRequest, @Body() dto: ImportStatementDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const { userId, manager } = this.ctx(req);
    return this.idempotency.withIdempotencyInTransaction('treasury.bank-statements.import', idempotencyKey, (tx) => this.statements.importStatement(dto, userId, tx), manager);
  }

  @RequirePermission('finance.bank_statement.match', 'editable')
  @Post(':id/suggest')
  suggest(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { userId, manager } = this.ctx(req);
    return this.statements.suggest(id, userId, manager);
  }

  @RequirePermission('finance.bank_statement.match', 'editable')
  @Post('lines/:lineId/confirm')
  confirm(@Req() req: CompanyScopedRequest, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() dto: ConfirmDto) {
    const { userId, manager } = this.ctx(req);
    return this.statements.confirm(lineId, dto.transactionIds, userId, manager);
  }

  @RequirePermission('finance.bank_statement.unmatch', 'editable')
  @Post('lines/:lineId/unmatch')
  unmatch(@Req() req: CompanyScopedRequest, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() dto: ReasonDto) {
    const { userId, manager } = this.ctx(req);
    return this.statements.unmatch(lineId, dto.reason, userId, manager);
  }

  @RequirePermission('finance.bank_statement.reconcile', 'editable')
  @Post(':id/reconcile')
  reconcile(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { userId, manager } = this.ctx(req);
    return this.statements.reconcile(id, userId, manager);
  }

  @RequirePermission('finance.bank_statement.reopen', 'editable')
  @Post(':id/reopen')
  reopen(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    const { userId, manager } = this.ctx(req);
    return this.statements.reopen(id, dto.reason, userId, manager);
  }
}

/** T5 — cash custody sessions: open / close with a count / controlled reopen; the variance is resolved by a draft Treasury Document, never by a silent adjustment. */
@Controller('treasury/cash-sessions')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
@RequireModule('finance')
export class CashSessionsController {
  constructor(private readonly sessions: CashSessionService) {}

  private ctx(req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return { userId: req.user.id, manager: req.companyContext.dataSource.manager };
  }

  @RequirePermission('finance.cash_session.view', 'read-only')
  @Get()
  list(@Req() req: CompanyScopedRequest, @Query('status') status?: string, @Query('treasuryAccountId') treasuryAccountId?: string) {
    return this.sessions.list({ status, treasuryAccountId }, this.ctx(req).manager);
  }

  @RequirePermission('finance.cash_session.view', 'read-only')
  @Get(':id')
  get(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.get(id, this.ctx(req).manager);
  }

  @RequirePermission('finance.cash_session.open', 'editable')
  @Post()
  open(@Req() req: CompanyScopedRequest, @Body() dto: OpenSessionDto) {
    const { userId, manager } = this.ctx(req);
    return this.sessions.open(dto, userId, manager);
  }

  @RequirePermission('finance.cash_session.close', 'editable')
  @Post(':id/close')
  close(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseSessionDto) {
    const { userId, manager } = this.ctx(req);
    return this.sessions.close(id, dto, userId, manager);
  }

  @RequirePermission('finance.cash_session.reopen', 'editable')
  @Post(':id/reopen')
  reopen(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    const { userId, manager } = this.ctx(req);
    return this.sessions.reopen(id, dto.reason, userId, manager);
  }
}
