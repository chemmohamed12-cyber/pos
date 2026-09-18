import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { DepositsService } from '../application/deposits.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RolesGuard } from '../../../foundation/authorization/roles.guard';
import { RequireRole } from '../../../foundation/authorization/require-role.decorator';

class RejectDepositDto {
  @IsString()
  reason!: string;
}

class ApproveDepositDto {
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
@UseGuards(JwtAuthGuard)
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

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'finance')
  @Post(':id/approve')
  async approve(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: ApproveDepositDto) {
    return this.deposits.approveDeposit(id, req.user.id, dto.treasuryAccountId);
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'finance')
  @Post(':id/reject')
  async reject(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: RejectDepositDto) {
    return this.deposits.rejectDeposit(id, dto.reason, req.user.id);
  }
}
