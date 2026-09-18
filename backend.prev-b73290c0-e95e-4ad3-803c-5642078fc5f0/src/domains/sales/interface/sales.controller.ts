import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { SalesService } from '../application/sales.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateSalesRepDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  territory?: string;
}

@Controller('sales/reps')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /**
   * P4 Tranche-2 ("remaining 9 domains" pass, 2026-09-06) — no dedicated
   * `.create` leaf exists for `sales.rep` (`sales.manifest.ts` only has
   * `.view`/`.assign`); `.assign` is the closest semantic fit (creating
   * this profile is what designates a user as a sales rep) and is
   * admin-only here exactly as before, so no over-grant risk.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('sales.rep.assign', 'editable')
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateSalesRepDto) {
    return this.sales.createSalesRepProfile(dto.userId, dto.territory ?? null, req.user.id);
  }

  @Get(':userId')
  async get(@Param('userId') userId: string) {
    return this.sales.getSalesRepProfile(userId);
  }
}
