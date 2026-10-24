import { Body, Controller, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsInt, IsUUID, Min } from 'class-validator';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
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

/** Manufacturing Engine S6 - the quick assembly gesture on the Work Order path (same permission as the legacy assembly: `inventory.assembly.create`). */
@Controller('manufacturing/quick-assembly')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('manufacturing')
export class QuickAssemblyController {
  constructor(private readonly quick: QuickAssemblyService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.assembly.create', 'editable')
  @Post()
  async assemble(@Body() dto: QuickAssemblyDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const r = await this.quick.quickAssemble(dto.warehouseId, dto.finishedProductId, dto.quantity, req.user.id, req.companyContext.dataSource.manager);
    return { assemblyReference: r.workOrderNumber, workOrderId: r.workOrderId, workOrderNumber: r.workOrderNumber };
  }
}
