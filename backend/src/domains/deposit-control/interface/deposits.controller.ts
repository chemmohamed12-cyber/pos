import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { DepositsService } from '../application/deposits.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
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

@Controller('deposits')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('sales')
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Post()
  async submit(@Req() req: AuthenticatedRequest, @Body() dto: SubmitDepositDto) {
    return this.deposits.submitDeposit(
      dto.salesOrderId,
      dto.amount,
      dto.method,
      dto.reference ?? null,
      dto.evidenceMediaAssetId ?? null,
      req.user.id,
    );
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.deposits.getDeposit(id, req.user.id);
  }

  @Get()
  async byOrder(@Req() req: AuthenticatedRequest, @Query('salesOrderId') salesOrderId: string) {
    return this.deposits.getLatestDepositForOrder(salesOrderId, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.deposit.approve', 'editable')
  @Post(':id/approve')
  async approve(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: ApproveDepositDto) {
    return this.deposits.approveDeposit(id, req.user.id, dto.treasuryAccountId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.deposit.reject', 'editable')
  @Post(':id/reject')
  async reject(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: RejectDepositDto) {
    return this.deposits.rejectDeposit(id, dto.reason, req.user.id);
  }
}
