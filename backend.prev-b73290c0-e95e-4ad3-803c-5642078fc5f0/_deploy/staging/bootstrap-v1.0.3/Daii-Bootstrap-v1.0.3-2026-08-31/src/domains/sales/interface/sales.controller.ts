import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { SalesService } from '../application/sales.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RolesGuard } from '../../../foundation/authorization/roles.guard';
import { RequireRole } from '../../../foundation/authorization/require-role.decorator';

class CreateSalesRepDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  territory?: string;
}

@Controller('sales/reps')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @RequireRole('admin')
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateSalesRepDto) {
    return this.sales.createSalesRepProfile(dto.userId, dto.territory ?? null, req.user.id);
  }

  @Get(':userId')
  async get(@Param('userId') userId: string) {
    return this.sales.getSalesRepProfile(userId);
  }
}
