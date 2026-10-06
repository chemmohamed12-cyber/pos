import { Body, Controller, Get, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { DepositsService } from '../application/deposits.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class RejectDepositDto {
  @IsString()
  reason!: string;
}

export class ApproveDepositDto {
  @IsUUID()
  treasuryAccountId!: string;
}

class SubmitDepositDto {
  @IsString()
  salesOrderId!: string;

  @IsNumberString()
  amount!: string;

  @IsString()
  method!: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  evidenceMediaAssetId?: string;
}

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized,
 * controller #16). `CompanyContextGuard` added at the class level — every
 * route threads `req.companyContext.dataSource.manager` into
 * `DepositsService`.
 */
@Controller('deposits')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('sales')
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Post()
  async submit(@Req() req: CompanyScopedRequest, @Body() dto: SubmitDepositDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.deposits.submitDeposit(
      dto.salesOrderId,
      dto.amount,
      dto.method,
      dto.reference ?? null,
      dto.evidenceMediaAssetId ?? null,
      req.user.id,
      req.companyContext.dataSource.manager,
    );
  }

  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.deposits.getDeposit(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @Get()
  async byOrder(@Req() req: CompanyScopedRequest, @Query('salesOrderId') salesOrderId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.deposits.getLatestDepositForOrder(salesOrderId, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.deposit.approve', 'editable')
  @Post(':id/approve')
  async approve(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: ApproveDepositDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.deposits.approveDeposit(id, req.user.id, dto.treasuryAccountId, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.deposit.reject', 'editable')
  @Post(':id/reject')
  async reject(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: RejectDepositDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.deposits.rejectDeposit(id, dto.reason, req.user.id, req.companyContext.dataSource.manager);
  }
}
