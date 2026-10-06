import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsISO8601, IsNumberString, IsOptional, IsPositive, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { FixedAssetService } from '../application/fixed-asset.service';
import { DepreciationService } from '../application/depreciation.service';
import { FixedAssetDisposalService } from '../application/fixed-asset-disposal.service';
import { FixedAssetReconciliationService } from '../application/fixed-asset-reconciliation.service';
import { DEPRECIATION_METHODS } from '../domain/fixed-asset';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { RequireFeatureGuard, RequireFeature } from '../../../foundation/module-registry/require-feature.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateFixedAssetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsUUID()
  categoryDimensionValueId?: string;

  @IsISO8601()
  acquisitionDate!: string;

  @IsNumberString()
  cost!: string;

  @IsOptional()
  @IsNumberString()
  salvageValue?: string;

  @IsInt()
  @IsPositive()
  usefulLifeMonths!: number;

  @IsOptional()
  @IsIn(DEPRECIATION_METHODS as unknown as string[])
  depreciationMethod?: string;

  @IsOptional()
  @IsUUID()
  costAccountId?: string;

  @IsOptional()
  @IsUUID()
  accumulatedDepreciationAccountId?: string;

  @IsOptional()
  @IsUUID()
  depreciationExpenseAccountId?: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @IsOptional()
  @IsUUID()
  acquisitionJournalEntryId?: string;
}

class UpdateFixedAssetDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string | null;

  @IsOptional()
  @IsUUID()
  categoryDimensionValueId?: string | null;

  @IsOptional()
  @IsNumberString()
  cost?: string;

  @IsOptional()
  @IsNumberString()
  salvageValue?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  usefulLifeMonths?: number;

  @IsOptional()
  @IsIn(DEPRECIATION_METHODS as unknown as string[])
  depreciationMethod?: string;

  @IsOptional()
  @IsUUID()
  costAccountId?: string;

  @IsOptional()
  @IsUUID()
  accumulatedDepreciationAccountId?: string;

  @IsOptional()
  @IsUUID()
  depreciationExpenseAccountId?: string;
}

class LinkAcquisitionDto {
  @IsUUID()
  journalEntryId!: string;
}

class RunDepreciationDto {
  @IsString()
  @MinLength(7)
  @MaxLength(7)
  depreciationPeriod!: string;

  @IsOptional()
  @IsISO8601()
  businessDate?: string;
}

class SubmitDisposalDto {
  @IsISO8601()
  disposalDate!: string;

  @IsOptional()
  @IsNumberString()
  proceeds?: string;

  @IsOptional()
  @IsUUID()
  proceedsAccountId?: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;
}

class DecideDto {
  @IsIn(['approved', 'rejected'])
  decision!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

/**
 * F12 — Fixed Assets (ADR-045). Same guard stack as every other accounting controller
 * (`@RequireModule('accounting')` + a per-route `@RequirePermission`), PLUS `@RequireFeature
 * ('accounting.fixed_assets')` on exactly the routes the D4 gate matrix marks DENY-when-OFF —
 * register read, depreciation-run listing, and reconciliation are deliberately NOT feature-gated
 * (master-data/read-only, ADR-045 D4).
 */
@Controller('accounting')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('accounting')
export class FixedAssetController {
  constructor(
    private readonly assets: FixedAssetService,
    private readonly depreciation: DepreciationService,
    private readonly disposals: FixedAssetDisposalService,
    private readonly reconciliation: FixedAssetReconciliationService,
  ) {}

  // ---- Register ----

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fixed_asset.view', 'read-only')
  @Get('fixed-assets')
  async listAssets(@Req() req: CompanyScopedRequest) {
    return this.assets.listAssets(req.companyContext!.dataSource.manager);
  }

  // NOTE: this static route MUST be declared before `fixed-assets/:id` below — NestJS matches routes
  // in declaration order, and `:id` would otherwise greedily match the literal path segment
  // "reconciliation" (then fail `ParseUUIDPipe` with a 400) — a real bug found and fixed by this
  // phase's own HTTP E2E script (exactly the class of gap that script exists to catch).
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fixed_asset.view', 'read-only')
  @Get('fixed-assets/reconciliation')
  async reconcile(@Req() req: CompanyScopedRequest, @Query('asOfDate') asOfDate?: string, @Query('orgUnitId') orgUnitId?: string) {
    return this.reconciliation.reconcile(asOfDate, orgUnitId, req.companyContext!.dataSource.manager);
  }

  /** D8 — the POSTED journal entries that may be linked as this asset's acquisition (read-only; nothing is created or posted). */
  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fixed_asset.view', 'read-only')
  @Get('fixed-assets/:id/acquisition-candidates')
  async acquisitionCandidates(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.assets.listAcquisitionCandidates(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fixed_asset.view', 'read-only')
  @Get('fixed-assets/:id')
  async getAsset(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.assets.getAsset(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('accounting.fixed_assets')
  @RequirePermission('accounting.fixed_asset.create', 'editable')
  @Post('fixed-assets')
  async createAsset(@Body() dto: CreateFixedAssetDto, @Req() req: CompanyScopedRequest) {
    return this.assets.createAsset(dto as never, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('accounting.fixed_assets')
  @RequirePermission('accounting.fixed_asset.edit', 'editable')
  @Post('fixed-assets/:id')
  async updateAsset(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFixedAssetDto, @Req() req: CompanyScopedRequest) {
    return this.assets.updateAsset(id, dto as never, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('accounting.fixed_assets')
  @RequirePermission('accounting.fixed_asset.edit', 'editable')
  @Post('fixed-assets/:id/link-acquisition')
  async linkAcquisition(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkAcquisitionDto, @Req() req: CompanyScopedRequest) {
    return this.assets.linkAcquisitionJournalEntry(id, dto.journalEntryId, req.user.id, req.companyContext!.dataSource.manager);
  }

  // ---- Depreciation ----

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fixed_asset.view', 'read-only')
  @Get('depreciation-runs')
  async listDepreciationRuns(@Req() req: CompanyScopedRequest) {
    return this.depreciation.listRuns(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fixed_asset.view', 'read-only')
  @Get('depreciation-runs/:id/lines')
  async getDepreciationRunLines(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.depreciation.getRunLines(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('accounting.fixed_assets')
  @RequirePermission('accounting.fixed_asset.post', 'editable')
  @Post('depreciation-runs')
  async runDepreciation(@Body() dto: RunDepreciationDto, @Req() req: CompanyScopedRequest) {
    return this.depreciation.runDepreciation(dto.depreciationPeriod, req.user.id, dto.businessDate, req.companyContext!.dataSource.manager);
  }

  // ---- Disposal ----

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('accounting.fixed_assets')
  @RequirePermission('accounting.fixed_asset.adjust', 'editable')
  @Post('fixed-assets/:id/dispose')
  async submitDisposal(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitDisposalDto, @Req() req: CompanyScopedRequest) {
    return this.disposals.submitDisposal({ fixedAssetId: id, ...dto }, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.fixed_asset.view', 'read-only')
  @Get('fixed-assets/:id/disposals')
  async listDisposals(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.disposals.listDisposals(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('accounting.fixed_assets')
  @RequirePermission('accounting.fixed_asset.approve', 'editable')
  @Post('fixed-asset-disposals/:id/decide')
  async decideDisposal(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto, @Req() req: CompanyScopedRequest) {
    return this.disposals.decide(id, req.user.id, dto.decision as 'approved' | 'rejected', dto.note, req.companyContext!.dataSource.manager);
  }
}
