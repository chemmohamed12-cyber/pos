import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CurrencyService } from '../application/currency.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { TaxCodeService } from '../application/tax-code.service';
import { TaxPeriodService } from '../application/tax-period.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { GLAccountService } from '../application/gl-account.service';
import { ClosingExceptionService } from '../application/closing-exception.service';
import { ClosingSnapshotService } from '../application/closing-snapshot.service';
import { GL_ACCOUNT_TYPES } from '../domain/gl-account-type';
import { TAX_CODE_TYPES, TaxCodeType } from '../infrastructure/tax-code.entity';
import { ACCOUNT_CURRENCY_MODES, CONTROL_FUNCTIONS, DIMENSION_RULE_MODES } from '../domain/control-function';
import { CurrencyRoundingMode } from '../domain/currency-rounding-mode';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { RequireFeature, RequireFeatureGuard } from '../../../foundation/module-registry/require-feature.decorator';

class CreateCurrencyDto {
  @IsString()
  @Length(3, 3)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(1)
  symbol!: string;

  @IsOptional()
  @IsIn(['half_up', 'half_even', 'half_down'])
  roundingMode?: CurrencyRoundingMode;

  @IsOptional()
  @IsBoolean()
  isBaseCurrency?: boolean;
}

class RecordExchangeRateDto {
  @IsISO8601()
  rateDate!: string;

  @IsNumberString()
  rate!: string;

  @IsOptional()
  @IsIn(['manual', 'api'])
  rateSource?: 'manual' | 'api';
}

class CreateFiscalYearDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsISO8601()
  startDate!: string;

  @IsISO8601()
  endDate!: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;
}

/** ADR-046 D4 — `close` is deliberately NOT a legal value here: it is FA-01-gated, submitted via its own `POST fiscal-periods/:id/close` route below, never fired directly through this generic transition endpoint. */
class TransitionPeriodDto {
  @IsIn(['soft_close', 'reopen_from_soft_close', 'close_after_reopen'])
  action!: string;
}

class CreateTaxCodeDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsNumberString()
  rate!: string;

  @IsOptional()
  @IsBoolean()
  isInclusive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  accountMappingRef?: string;

  /** F10 (ADR-043 D2). */
  @IsOptional()
  @IsIn(TAX_CODE_TYPES as unknown as string[])
  type?: TaxCodeType;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  jurisdictionCode?: string;

  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;
}

class UpdateTaxCodeDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumberString()
  rate?: string;

  @IsOptional()
  @IsBoolean()
  isInclusive?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  accountMappingRef?: string;

  /** F10 (ADR-043 D2). */
  @IsOptional()
  @IsIn(TAX_CODE_TYPES as unknown as string[])
  type?: TaxCodeType;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  jurisdictionCode?: string;

  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;
}

class CreateTaxPeriodDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsISO8601()
  startDate!: string;

  @IsISO8601()
  endDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  jurisdictionCode?: string;
}

class CreateDimensionTypeDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;
}

class CreateDimensionValueDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;
}

/** F11 (ADR-044 D8/D11) — update/deactivate. */
class UpdateDimensionTypeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class UpdateDimensionValueDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ---- F02 — Chart of Accounts ----

class CreateGLAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameAr?: string;

  @IsIn(GL_ACCOUNT_TYPES as unknown as string[])
  accountType!: string;

  @IsOptional()
  @IsBoolean()
  isContra?: boolean;

  @IsOptional()
  @IsUUID()
  parentAccountId?: string;

  @IsOptional()
  @IsBoolean()
  isPostable?: boolean;

  @IsOptional()
  @IsIn(CONTROL_FUNCTIONS as unknown as string[])
  controlFunction?: string;

  @IsOptional()
  @IsIn(ACCOUNT_CURRENCY_MODES as unknown as string[])
  currencyMode?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  restrictCurrencyCode?: string;

  @IsOptional()
  @IsBoolean()
  allowManualJournal?: boolean;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;
}

class UpdateGLAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameAr?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isContra?: boolean;

  @IsOptional()
  @IsIn(ACCOUNT_CURRENCY_MODES as unknown as string[])
  currencyMode?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  restrictCurrencyCode?: string | null;

  @IsOptional()
  @IsBoolean()
  allowManualJournal?: boolean;
}

class ReparentGLAccountDto {
  @IsOptional()
  @IsUUID()
  newParentId?: string | null;
}

class AssignControlFunctionDto {
  @IsOptional()
  @IsIn(CONTROL_FUNCTIONS as unknown as string[])
  controlFunction?: string | null;
}

class DimensionRuleDto {
  @IsUUID()
  dimensionTypeId!: string;

  @IsIn(DIMENSION_RULE_MODES as unknown as string[])
  mode!: string;

  @IsOptional()
  @IsUUID()
  defaultValueId?: string | null;
}

class ReplaceDimensionRulesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DimensionRuleDto)
  rules!: DimensionRuleDto[];
}

class ImportTemplateDto {
  @IsString()
  @MinLength(1)
  templateKey!: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/** ADR-051 §2 — the "open -> acknowledged" transition's only required field. */
class AcknowledgeClosingExceptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;
}

/** ADR-051 §3 — the mandatory human justification recorded permanently on the exception's `annotation`. */
class AnnotateTestArtifactDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}

/**
 * F01 — Financial Foundation (Blueprint §19). Every route requires the
 * module to be entitled (`@RequireModule('accounting')`, the same guard
 * every other domain controller uses); writes additionally require the
 * matching `accounting.*` permission node.
 */
@Controller('accounting')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('accounting')
export class AccountingController {
  constructor(
    private readonly currencies: CurrencyService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly taxCodes: TaxCodeService,
    private readonly taxPeriods: TaxPeriodService,
    private readonly dimensions: FinancialDimensionService,
    private readonly glAccounts: GLAccountService,
    private readonly closingExceptions: ClosingExceptionService,
    private readonly closingSnapshots: ClosingSnapshotService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.currency.create', 'editable')
  @Post('currencies')
  async createCurrency(@Body() dto: CreateCurrencyDto, @Req() req: AuthenticatedRequest) {
    return this.currencies.createCurrency(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.currency.view', 'read-only')
  @Get('currencies')
  async listCurrencies() {
    return this.currencies.listCurrencies();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.currency.edit', 'editable')
  @Post('currencies/:code/set-base')
  async setBaseCurrency(@Param('code') code: string, @Req() req: AuthenticatedRequest) {
    return this.currencies.setBaseCurrency(code, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.currency.edit', 'editable')
  @Post('currencies/:code/deactivate')
  async deactivateCurrency(@Param('code') code: string, @Req() req: AuthenticatedRequest) {
    return this.currencies.deactivateCurrency(code, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.exchange_rate.view', 'read-only')
  @Get('currencies/:code/exchange-rates')
  async listExchangeRates(@Param('code') code: string) {
    return this.currencies.listExchangeRates(code);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.exchange_rate.create', 'editable')
  @Post('currencies/:code/exchange-rates')
  async recordExchangeRate(@Param('code') code: string, @Body() dto: RecordExchangeRateDto, @Req() req: AuthenticatedRequest) {
    return this.currencies.recordExchangeRate(code, dto.rateDate, dto.rate, dto.rateSource ?? 'manual', req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_year.view', 'read-only')
  @Get('fiscal-years')
  async listFiscalYears() {
    return this.fiscalPeriods.listFiscalYears();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_year.create', 'editable')
  @Post('fiscal-years')
  async createFiscalYear(@Body() dto: CreateFiscalYearDto, @Req() req: AuthenticatedRequest) {
    return this.fiscalPeriods.createFiscalYear(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_year.create', 'editable')
  @Post('fiscal-years/:id/activate')
  async activateFiscalYear(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.fiscalPeriods.activateFiscalYear(id, req.user.id);
  }

  /** ADR-046 D4/D10 — submits an FA-01 request; does not close the year directly. D10's precondition (every child period already `closed`) is checked here (early rejection) and revalidated at decision time. Decide via the generic `POST /approvals/requests/:id/decide` route (checker permission `accounting.fiscal_year.approve`, ADR-046 D5). */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_year.create', 'editable')
  @Post('fiscal-years/:id/close')
  async submitYearClose(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.fiscalPeriods.submitYearClose(id, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_year.view', 'read-only')
  @Get('fiscal-years/:id/periods')
  async listPeriods(@Param('id', ParseUUIDPipe) id: string) {
    return this.fiscalPeriods.listPeriods(id);
  }

  /** Routine period-management transitions (soft_close/reopen_from_soft_close/close_after_reopen) ONLY — NOT `close` or `reopen`, both FA-01-gated via their own submit routes below (ADR-046 D4). */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_period.edit', 'editable')
  @Post('fiscal-periods/:id/transition')
  async transitionPeriod(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionPeriodDto, @Req() req: AuthenticatedRequest) {
    return this.fiscalPeriods.transitionPeriod(id, dto.action, req.user.id);
  }

  /**
   * ADR-046 D4 — the "hard lock" (`soft_close -> closed`). FA-01-gated:
   * submits a request via the `accounting.fiscal_period.edit` permission
   * (the same maker-side permission the routine transitions above use);
   * decide via the generic `POST /approvals/requests/:id/decide` route
   * (checker permission `accounting.fiscal_period.approve`, ADR-046 D5).
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_period.edit', 'editable')
  @Post('fiscal-periods/:id/close')
  async submitPeriodClose(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.fiscalPeriods.submitPeriodClose(id, req.user.id);
  }

  /**
   * The sensitive `closed -> reopened` transition, split into its own
   * route+permission node so it can be gated independently — F01 shipped
   * the state/transition itself; F13 (ADR-046 D4) now FA-01-gates it:
   * this route SUBMITS a request (still behind the same
   * `accounting.fiscal_period.reopen` permission node as before), it does
   * not fire the transition directly. Decide via the generic
   * `POST /approvals/requests/:id/decide` route (checker permission
   * `accounting.fiscal_period.approve`, ADR-046 D5).
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_period.reopen', 'editable')
  @Post('fiscal-periods/:id/reopen')
  async submitPeriodReopen(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.fiscalPeriods.submitPeriodReopen(id, req.user.id);
  }

  /** ADR-050 — runs a fresh Closing Audit and returns it (does not submit a close request). Lets a maker see blocking/informational exceptions before calling `POST .../close`. */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_period.view', 'read-only')
  @Post('fiscal-periods/:id/closing-audit')
  async runClosingAudit(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.fiscalPeriods.previewClosingAudit(id, req.user.id);
  }

  /** ADR-050 — prior Closing Audit runs for this period, newest first. */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_period.view', 'read-only')
  @Get('fiscal-periods/:id/closing-audit')
  async listClosingAuditRuns(@Param('id', ParseUUIDPipe) id: string) {
    return this.fiscalPeriods.listClosingAuditRuns(id);
  }

  /** ADR-051 §1/§6 — this period's closing ATTEMPTS (first close and every reclose), newest first, each with its own audit/approval evidence linkage. */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fiscal_period.view', 'read-only')
  @Get('fiscal-periods/:id/closing-workflow-runs')
  async listClosingWorkflowRuns(@Param('id', ParseUUIDPipe) id: string) {
    return this.fiscalPeriods.listClosingWorkflowRuns(id);
  }

  /** ADR-051 §4/§5 — every Black Box snapshot for this period, oldest first (closeSequence order). */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.closing_snapshot.view', 'read-only')
  @Get('fiscal-periods/:id/closing-snapshots')
  async listClosingSnapshots(@Param('id', ParseUUIDPipe) id: string) {
    return this.closingSnapshots.listRuns(id);
  }

  /** ADR-051 §3.3/§13 — recomputes content hash, signature, and (if applicable) the predecessor chain link. Read-only — never mutates the snapshot. */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.closing_snapshot.verify', 'read-only')
  @Post('closing-snapshots/:id/verify')
  async verifyClosingSnapshot(@Param('id', ParseUUIDPipe) id: string) {
    return this.closingSnapshots.verify(id);
  }

  /** ADR-051 §2 — every ClosingException ever raised for this period, current status/severity/category included. */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.closing_exception.view', 'read-only')
  @Get('fiscal-periods/:id/closing-exceptions')
  async listClosingExceptions(@Param('id', ParseUUIDPipe) id: string) {
    return this.closingExceptions.list(id);
  }

  /** ADR-051 §2 — `open -> acknowledged` only. `resolved` is never reachable through this route (set only by a fresh Closing Audit run no longer reproducing the finding). */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.closing_exception.resolve', 'editable')
  @Post('closing-exceptions/:id/acknowledge')
  async acknowledgeClosingException(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AcknowledgeClosingExceptionDto, @Req() req: AuthenticatedRequest) {
    return this.closingExceptions.acknowledge(id, req.user.id, dto.note);
  }

  /** ADR-051 §3 — the ONLY path to HISTORICAL_TEST_ARTIFACT. Own, narrower permission node, deliberately separate from ordinary exception handling. */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.closing_exception.annotate_test_artifact', 'editable')
  @Post('closing-exceptions/:id/annotate-test-artifact')
  async annotateClosingExceptionTestArtifact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnnotateTestArtifactDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.closingExceptions.annotateTestArtifact(id, req.user.id, dto.reason);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.tax_code.view', 'read-only')
  @Get('tax-codes')
  async listTaxCodes() {
    return this.taxCodes.listTaxCodes();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.tax_code.create', 'editable')
  @Post('tax-codes')
  async createTaxCode(@Body() dto: CreateTaxCodeDto, @Req() req: AuthenticatedRequest) {
    return this.taxCodes.createTaxCode(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.tax_code.edit', 'editable')
  @Post('tax-codes/:id')
  async updateTaxCode(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaxCodeDto, @Req() req: AuthenticatedRequest) {
    return this.taxCodes.updateTaxCode(id, dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.tax_period.view', 'read-only')
  @Get('tax-periods')
  async listTaxPeriods() {
    return this.taxPeriods.listTaxPeriods();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.tax_period.create', 'editable')
  @Post('tax-periods')
  async createTaxPeriod(@Body() dto: CreateTaxPeriodDto, @Req() req: AuthenticatedRequest) {
    return this.taxPeriods.createTaxPeriod(dto, req.user.id);
  }

  // F11 (ADR-044 D9) — every dimension route below carries RequireFeatureGuard +
  // @RequireFeature('accounting.financial_dimensions'), the first real consumer of that
  // previously-decorative feature toggle. Not entitled -> 404 (same anti-enumeration shape
  // RequireModuleGuard already uses for a whole module). This NEVER gates any GL/ledger read
  // route (GetJournalEntry/GetLedger etc.) — only these CRUD routes and posting-time enforcement
  // (GLAccountService/JournalEntryService) are gated; historical data stays readable regardless.

  @UseGuards(PermissionGuard, RequireFeatureGuard)
  @RequireFeature('accounting.financial_dimensions')
  @RequirePermission('accounting.dimension.view', 'read-only')
  @Get('dimension-types')
  async listDimensionTypes() {
    return this.dimensions.listDimensionTypes();
  }

  @UseGuards(PermissionGuard, RequireFeatureGuard)
  @RequireFeature('accounting.financial_dimensions')
  @RequirePermission('accounting.dimension.create', 'editable')
  @Post('dimension-types')
  async createDimensionType(@Body() dto: CreateDimensionTypeDto, @Req() req: AuthenticatedRequest) {
    return this.dimensions.createDimensionType(dto, req.user.id);
  }

  /** F11 (ADR-044 D8/D11) — update (name and/or deactivate via isActive) an existing dimension type. */
  @UseGuards(PermissionGuard, RequireFeatureGuard)
  @RequireFeature('accounting.financial_dimensions')
  @RequirePermission('accounting.dimension.edit', 'editable')
  @Post('dimension-types/:id')
  async updateDimensionType(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDimensionTypeDto, @Req() req: AuthenticatedRequest) {
    return this.dimensions.updateDimensionType(id, dto, req.user.id);
  }

  /** F11 (ADR-044 D8) — deactivation only, never a delete. */
  @UseGuards(PermissionGuard, RequireFeatureGuard)
  @RequireFeature('accounting.financial_dimensions')
  @RequirePermission('accounting.dimension.edit', 'editable')
  @Post('dimension-types/:id/deactivate')
  async deactivateDimensionType(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.dimensions.deactivateDimensionType(id, req.user.id);
  }

  @UseGuards(PermissionGuard, RequireFeatureGuard)
  @RequireFeature('accounting.financial_dimensions')
  @RequirePermission('accounting.dimension.view', 'read-only')
  @Get('dimension-types/:id/values')
  async listDimensionValues(@Param('id', ParseUUIDPipe) id: string) {
    return this.dimensions.listDimensionValues(id);
  }

  @UseGuards(PermissionGuard, RequireFeatureGuard)
  @RequireFeature('accounting.financial_dimensions')
  @RequirePermission('accounting.dimension.create', 'editable')
  @Post('dimension-types/:id/values')
  async createDimensionValue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateDimensionValueDto, @Req() req: AuthenticatedRequest) {
    return this.dimensions.createDimensionValue(id, dto, req.user.id);
  }

  /** F11 (ADR-044 D8/D11) — update (name and/or deactivate via isActive) an existing dimension value. */
  @UseGuards(PermissionGuard, RequireFeatureGuard)
  @RequireFeature('accounting.financial_dimensions')
  @RequirePermission('accounting.dimension.edit', 'editable')
  @Post('dimension-values/:id')
  async updateDimensionValue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDimensionValueDto, @Req() req: AuthenticatedRequest) {
    return this.dimensions.updateDimensionValue(id, dto, req.user.id);
  }

  /** F11 (ADR-044 D8) — deactivation only, never a delete. */
  @UseGuards(PermissionGuard, RequireFeatureGuard)
  @RequireFeature('accounting.financial_dimensions')
  @RequirePermission('accounting.dimension.edit', 'editable')
  @Post('dimension-values/:id/deactivate')
  async deactivateDimensionValue(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.dimensions.deactivateDimensionValue(id, req.user.id);
  }

  // ---- F02 — Chart of Accounts (Blueprint §19) ----

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.view', 'read-only')
  @Get('accounts')
  async listAccounts(
    @Query('type') type?: string,
    @Query('postableOnly') postableOnly?: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('parentId') parentId?: string,
    @Query('search') search?: string,
  ) {
    return this.glAccounts.listAccounts({
      accountType: type as never,
      postableOnly: postableOnly === 'true',
      includeInactive: includeInactive === 'true',
      parentAccountId: parentId === 'null' ? null : parentId,
      search,
    });
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.view', 'read-only')
  @Get('accounts/tree')
  async getAccountTree(@Query('includeInactive') includeInactive?: string) {
    return this.glAccounts.getTree(includeInactive === 'true');
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.view', 'read-only')
  @Get('chart/templates')
  async listAccountTemplates() {
    return this.glAccounts.listTemplates();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.view', 'read-only')
  @Get('accounts/:id')
  async getAccount(@Param('id', ParseUUIDPipe) id: string) {
    return this.glAccounts.getAccount(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.view', 'read-only')
  @Get('accounts/:id/dimension-rules')
  async listAccountDimensionRules(@Param('id', ParseUUIDPipe) id: string) {
    return this.glAccounts.getDimensionRules(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.create', 'editable')
  @Post('accounts')
  async createAccount(@Body() dto: CreateGLAccountDto, @Req() req: AuthenticatedRequest) {
    return this.glAccounts.createAccount(dto as never, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.edit', 'editable')
  @Post('accounts/:id')
  async updateAccount(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGLAccountDto, @Req() req: AuthenticatedRequest) {
    return this.glAccounts.updateAccount(id, dto as never, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.edit', 'editable')
  @Post('accounts/:id/reparent')
  async reparentAccount(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReparentGLAccountDto, @Req() req: AuthenticatedRequest) {
    return this.glAccounts.reparentAccount(id, dto.newParentId ?? null, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.assign', 'editable')
  @Post('accounts/:id/control-function')
  async assignControlFunction(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignControlFunctionDto, @Req() req: AuthenticatedRequest) {
    return this.glAccounts.assignControlFunction(id, (dto.controlFunction ?? null) as never, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.edit', 'editable')
  @Post('accounts/:id/dimension-rules')
  async replaceAccountDimensionRules(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceDimensionRulesDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.glAccounts.replaceDimensionRules(id, dto.rules as never, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.account.create', 'editable')
  @Post('chart/import-template')
  async importAccountTemplate(@Body() dto: ImportTemplateDto, @Req() req: AuthenticatedRequest) {
    return this.glAccounts.importTemplate(dto.templateKey, dto.dryRun ?? false, req.user.id);
  }
}
