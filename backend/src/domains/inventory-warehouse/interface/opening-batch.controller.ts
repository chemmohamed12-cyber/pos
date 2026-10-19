import { BadRequestException, Body, Controller, Get, Optional, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors, Query } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { OpeningBatchService } from '../application/opening-batch.service';
import { InventoryPostingDispatchService } from '../application/inventory-posting-dispatch.service';
import { OPENING_STOCK_IMPORT_COLUMNS } from './inventory.controller';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { WarehouseScopeGuard } from '../../../foundation/scope/warehouse-scope.guard';
import { WarehouseScopeFiltered, WarehouseScoped } from '../../../foundation/scope/warehouse-scope.decorator';
import { AuthorizationContextService } from '../../../foundation/authorization/authorization-context.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ExcelService } from '../../../foundation/excel/excel.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class OpeningLineDto {
  @IsUUID('all')
  productId!: string;

  @IsInt()
  quantity!: number;

  @IsOptional()
  @IsNumberString()
  unitCostBase?: string;
}

class CreateOpeningBatchDto {
  @IsUUID('all')
  warehouseId!: string;

  @Matches(DATE, { message: 'cutOffDate must be a date (YYYY-MM-DD).' })
  cutOffDate!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => OpeningLineDto)
  lines!: OpeningLineDto[];

  @IsOptional()
  @IsString()
  notes?: string;

  /** needs `inventory.opening_batch.override` AND a written reason; the service refuses it otherwise */
  @IsOptional()
  @IsBoolean()
  allowExistingActivity?: boolean;

  @IsOptional()
  @IsString()
  overrideReason?: string;
}

class SubmitDto {
  @IsOptional()
  @IsInt()
  declaredLineCount?: number;

  @IsOptional()
  @IsInt()
  declaredTotalQuantity?: number;

  @IsOptional()
  @IsNumberString()
  declaredTotalValueBase?: string;
}

class ReversalDto {
  @Matches(DATE, { message: 'cutOffDate must be a date (YYYY-MM-DD).' })
  cutOffDate!: string;

  @IsString()
  reason!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

class CorrectionLineDto {
  @IsUUID('all')
  productId!: string;

  @IsInt()
  deltaQuantity!: number;

  @IsOptional()
  @IsNumberString()
  unitCostBase?: string;
}

class CorrectionDto extends ReversalDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CorrectionLineDto)
  lines!: CorrectionLineDto[];
}

class DecideDto {
  @IsString()
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  note?: string;
}

/**
 * C4 (ADR-INV-01) - the Opening Balance Batch API. Authorisation is enforced HERE and in the service/approval engine (never only in the UI):
 *  - `inventory.opening_batch.create` (editable) drafts, imports, submits and posts; reads need it at read-only;
 *  - the two approvers are decided by FA-01 with the node the request type resolves (`.approve` for an opening, `.correct` for a reversal / correction); the maker can never decide;
 *  - `inventory.opening_batch.correct` (editable) creates a reversal / correction batch;
 *  - `inventory.opening_batch.override` is checked per request for the eligibility exception.
 * Warehouse scope (F6) applies like every inventory route: a batch for a warehouse outside the caller's scope is answered 404.
 */
@Controller('inventory/opening-batches')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, WarehouseScopeGuard)
@RequireModule('inventory')
export class OpeningBatchController {
  constructor(
    private readonly batches: OpeningBatchService,
    private readonly scopes: AccessScopeService,
    private readonly contexts: AuthorizationContextService,
    private readonly approvals: ApprovalEngineService,
    private readonly excel: ExcelService,
    // optional so a direct construction keeps compiling; Nest always provides it
    @Optional() private readonly dispatch?: InventoryPostingDispatchService,
  ) {}

  private manager(req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return req.companyContext.dataSource.manager;
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.opening_batch.create', 'read-only')
  @WarehouseScopeFiltered("only batches of the caller's visible warehouses")
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    const manager = this.manager(req);
    const visible = await this.scopes.visibleWarehouseIds(await this.scopes.forRequest(req), manager);
    return this.batches.list(manager, visible === 'ALL' ? undefined : visible);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.opening_batch.create', 'read-only')
  @WarehouseScoped({ recordOf: 'inventory_opening_batches', param: 'id' })
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.batches.view(id, this.manager(req));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.opening_batch.create', 'editable')
  @WarehouseScoped({ body: 'warehouseId' })
  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateOpeningBatchDto) {
    const manager = this.manager(req);
    if (dto.allowExistingActivity) {
      const ctx = await this.contexts.forRequest(req);
      if (!ctx.hasAtLeast('inventory.opening_batch.override', 'editable')) {
        // the same answer a denied permission gives everywhere: the caller learns nothing about the exception
        throw new UnauthorizedException('You are not allowed to override opening-batch eligibility.');
      }
    }
    return this.batches.createDraft({ ...dto, lines: dto.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCostBase: l.unitCostBase })) }, req.user!.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.opening_batch.create', 'editable')
  @WarehouseScopeFiltered('every row naming a warehouse outside the batch warehouse is rejected like an unknown code')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async importDraft(@Req() req: CompanyScopedRequest, @UploadedFile() file: Express.Multer.File, @Query('cutOffDate') cutOffDate?: string) {
    const manager = this.manager(req);
    if (!cutOffDate || !DATE.test(cutOffDate)) throw new BadRequestException('cutOffDate (YYYY-MM-DD) is required.');
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, OPENING_STOCK_IMPORT_COLUMNS);
    if (headerErrors.length > 0) return { draft: null, rejected: [], headerErrors };
    // F6: a row naming a warehouse outside the caller's scope is rejected exactly like an unknown code (no enumeration)
    const visible = await this.scopes.visibleWarehouseIds(await this.scopes.forRequest(req), manager);
    const result = await this.batches.createDraftFromRows(rows as Array<{ warehouseCode: string; productSku: string; quantity: string; unitCost: string }>, { cutOffDate }, req.user!.id, manager, visible);
    return { ...result, headerErrors: [] };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.opening_batch.create', 'editable')
  @WarehouseScoped({ recordOf: 'inventory_opening_batches', param: 'id' })
  @Post(':id/submit')
  async submit(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitDto) {
    return this.batches.submit(id, dto, req.user!.id, this.manager(req));
  }

  /** The approvers' decision. FA-01 enforces maker != checker, two distinct approvers and the live permission node of the request type. */
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.opening_batch.create', 'read-only')
  @WarehouseScoped({ recordOf: 'inventory_opening_batches', param: 'id' })
  @Post(':id/decide')
  async decide(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto) {
    const manager = this.manager(req);
    const batch = await this.batches.view(id, manager);
    if (!batch.batch.approvalRequestId) throw new UnauthorizedException('This batch has no approval request.');
    return this.approvals.decide(batch.batch.approvalRequestId, req.user!.id, dto.decision, dto.note ?? null, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.opening_batch.create', 'editable')
  @WarehouseScoped({ recordOf: 'inventory_opening_batches', param: 'id' })
  @Post(':id/post')
  async post(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const manager = this.manager(req);
    const result = await this.batches.post(id, req.user!.id, manager);
    // C2: the events of the posted batch are dispatched in this request and the response states the truth about the GL side
    if (!this.dispatch) return result;
    return { ...result, financialPosting: await this.dispatch.dispatchAndReport(manager, [{ referenceType: '*', referenceId: id }]) };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.opening_batch.correct', 'editable')
  @WarehouseScoped({ recordOf: 'inventory_opening_batches', param: 'id' })
  @Post(':id/reverse')
  async reverse(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReversalDto) {
    return this.batches.createReversalBatch(id, dto, req.user!.id, this.manager(req));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.opening_batch.correct', 'editable')
  @WarehouseScoped({ recordOf: 'inventory_opening_batches', param: 'id' })
  @Post(':id/correct')
  async correct(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectionDto) {
    return this.batches.createCorrectionBatch(id, { cutOffDate: dto.cutOffDate, reason: dto.reason, notes: dto.notes ?? null, lines: dto.lines }, req.user!.id, this.manager(req));
  }
}
