import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { TargetService } from '../application/target.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateTargetDto {
  @IsUUID()
  employeeId!: string;

  @IsISO8601()
  periodStart!: string;

  @IsISO8601()
  periodEnd!: string;

  @IsString()
  targetValue!: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;
}

class DecideDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

/** ADR-071 §4/§6/§10 — `targets`'s composition-root controller. */
@Controller('targets')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('targets')
export class TargetController {
  constructor(private readonly targets: TargetService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('targets.target.create', 'editable')
  @Post('targets')
  async create(@Body() dto: CreateTargetDto, @Req() req: CompanyScopedRequest) {
    return this.targets.create(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('targets.target.view', 'read-only')
  @Get('targets')
  async listTargets(@Req() req: CompanyScopedRequest, @Query('employeeId') employeeId?: string) {
    return this.targets.listTargets(employeeId, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('targets.target.create', 'editable')
  @Post('targets/:id/submit')
  async submit(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.targets.submitForApproval(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('targets.target.approve', 'editable')
  @Post('approvals/:requestId/decide')
  async decide(@Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: DecideDto, @Req() req: CompanyScopedRequest) {
    return this.targets.decide(requestId, req.user.id, dto.decision, dto.note, req.companyContext!.dataSource.manager);
  }
}
