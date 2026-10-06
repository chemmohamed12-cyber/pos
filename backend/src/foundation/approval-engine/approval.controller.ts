import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsNumberString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApprovalEngineService } from './approval-engine.service';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../company/company-context.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';

class UpsertMatrixRuleDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  requestTypeCode!: string;

  @IsOptional()
  minApprovers?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  requiredPermissionNode!: string;

  @IsOptional()
  @IsNumberString()
  valueThreshold?: string | null;

  @IsOptional()
  @IsString()
  orgUnitId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class DecideDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

/**
 * FA-01 — Generic Approval / Maker-Checker Engine — generic admin +
 * checker API. `core.approval.view` / `core.approval.manage` are
 * grandfathered `core.*` permission nodes (ADR-024 §3.3), resolved by the
 * Permission Engine's ancestor walk exactly like `core.config` /
 * `core.limit`; the migration grants `admin` 'editable' at `core.approval`.
 *
 * **No `submit` route** — a maker is always a consuming domain's own
 * service (`FiscalPeriodService.requestReopen()`, F04's payment flow, …)
 * calling `ApprovalEngineService.submit(...)` with the authenticated
 * actor as `makerUserId` (contract §6). A raw HTTP handler taking a
 * client-supplied `makerUserId` is exactly what the contract forbids.
 *
 * `decide` / `withdraw` DO have routes — a checker acts directly on a
 * request, which is generic, not domain-specific. `approverUserId` /
 * `actorUserId` are always `req.user.id`, never from the body. The
 * service enforces the real gates (maker ≠ checker; the per-request
 * `resolvedRequiredNode` at 'editable').
 */
/**
 * Area 21 (2026-10-05): Company-scoped. `CompanyContextGuard` validates the Membership and resolves the
 * Company's own DataSource; every route threads `req.companyContext.dataSource.manager`, so requests,
 * decisions and matrix rules are the CALLER'S COMPANY's — an approver never sees or decides another
 * Company's request (its id simply does not exist in their database).
 */
@Controller('approvals')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RolesGuard)
export class ApprovalController {
  constructor(private readonly approvals: ApprovalEngineService) {}

  @Get('request-types')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.approval.view', 'read-only')
  listRequestTypes(@Req() req: CompanyScopedRequest) {
    return this.approvals.listRequestTypes(req.companyContext!.dataSource.manager);
  }

  @Get('matrix-rules')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.approval.view', 'read-only')
  listMatrixRules(@Req() req: CompanyScopedRequest, @Query('requestTypeCode') requestTypeCode?: string) {
    return this.approvals.listMatrixRules(requestTypeCode, req.companyContext!.dataSource.manager);
  }

  @Put('matrix-rules')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.approval.manage', 'editable')
  upsertMatrixRule(@Body() dto: UpsertMatrixRuleDto, @Req() req: CompanyScopedRequest) {
    return this.approvals.upsertMatrixRule(dto, req.user!.id, req.companyContext!.dataSource.manager);
  }

  @Get('requests')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.approval.view', 'read-only')
  listRequests(
    @Req() req: CompanyScopedRequest,
    @Query('requestTypeCode') requestTypeCode?: string,
    @Query('makerUserId') makerUserId?: string,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
  ) {
    return this.approvals.listRequests({ requestTypeCode, makerUserId, resourceType, resourceId }, req.companyContext!.dataSource.manager);
  }

  @Get('requests/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.approval.view', 'read-only')
  getRequest(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.approvals.getRequest(id, req.companyContext!.dataSource.manager);
  }

  @Post('requests/:id/decide')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.approval.view', 'read-only')
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto, @Req() req: CompanyScopedRequest) {
    return this.approvals.decide(id, req.user!.id, dto.decision, dto.note ?? null, req.companyContext!.dataSource.manager);
  }

  @Post('requests/:id/withdraw')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.approval.view', 'read-only')
  withdraw(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.approvals.withdraw(id, req.user!.id, req.companyContext!.dataSource.manager);
  }

  @Post('requests/:id/escalate')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.approval.manage', 'editable')
  escalate(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.approvals.escalate(id, req.user!.id, req.companyContext!.dataSource.manager);
  }
}
