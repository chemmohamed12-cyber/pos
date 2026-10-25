import { Body, Controller, Get, Headers, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsInt, IsUUID, Min } from 'class-validator';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { IdempotencyService } from '../../../foundation/error-contract/idempotency.service';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { WarehouseScopeGuard } from '../../../foundation/scope/warehouse-scope.guard';
import { WarehouseScoped } from '../../../foundation/scope/warehouse-scope.decorator';
import { QuickAssemblyService } from '../application/quick-assembly.service';

class QuickAssemblyDto {
  @IsUUID()
  warehouseId!: string;

  @IsUUID()
  finishedProductId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

/**
 * Manufacturing Engine S6 + UX stage 2 - the quick assembly gesture on the Work Order path (same permission as the legacy assembly: `inventory.assembly.create`).
 * Both routes are warehouse-scoped like the legacy `/inventory/assemble`; the confirm step is idempotent per `Idempotency-Key` (the screen sends one per confirmation).
 */
@Controller('manufacturing/quick-assembly')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, WarehouseScopeGuard)
@RequireModule('manufacturing')
export class QuickAssemblyController {
  constructor(
    private readonly quick: QuickAssemblyService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * D8 - informational, read-only: requirements, availability and shortages for exactly the warehouse the assembly would draw from. It reserves nothing and guarantees nothing;
   * it needs the same permission as the assembly (so a user who may assemble can see the BOM components' availability even without general stock visibility, and ONLY those).
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.assembly.create', 'editable')
  @WarehouseScoped({ query: 'warehouseId' })
  @Get('preview')
  async preview(@Req() req: CompanyScopedRequest, @Query('finishedProductId') finishedProductId: string, @Query('warehouseId') warehouseId: string, @Query('quantity') quantity: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.quick.preview(finishedProductId, warehouseId, Number(quantity), req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.assembly.create', 'editable')
  @WarehouseScoped({ body: 'warehouseId' })
  @Post()
  async assemble(@Body() dto: QuickAssemblyDto, @Req() req: CompanyScopedRequest, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const base = await this.idempotency.withIdempotencyInTransaction(
      'manufacturing.quick_assembly',
      idempotencyKey,
      (tx) => this.quick.quickAssemble(dto.warehouseId, dto.finishedProductId, dto.quantity, req.user!.id, tx),
      manager,
    );
    const result = await this.quick.finish(base, manager);
    return { assemblyReference: result.workOrderNumber, ...result };
  }
}
