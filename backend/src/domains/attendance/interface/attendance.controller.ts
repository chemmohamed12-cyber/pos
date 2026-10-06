import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { AttendanceService } from '../application/attendance.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { AttendancePunchType } from '../domain/attendance-day-status';

class CreateConnectorDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsIn(['manual'])
  connectorType!: string;
}

class CreateMappingDto {
  @IsUUID()
  connectorId!: string;

  @IsUUID()
  employeeId!: string;

  @IsString()
  @MinLength(1)
  deviceUserRef!: string;
}

class ManualPunchDto {
  @IsUUID()
  employeeId!: string;

  @IsISO8601()
  punchTimestamp!: string;

  @IsIn(['in', 'out', 'unknown'])
  punchType!: AttendancePunchType;
}

class SubmitApprovalBatchDto {
  @IsISO8601()
  periodStart!: string;

  @IsISO8601()
  periodEnd!: string;
}

class DecideDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

class CorrectDayDto {
  @IsOptional()
  @IsISO8601()
  checkIn?: string | null;

  @IsOptional()
  @IsISO8601()
  checkOut?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}

/**
 * ADR-065 — `attendance`'s composition-root controller. Every route
 * requires the module to be entitled (`@RequireModule('attendance')`);
 * writes additionally require the matching `attendance.*` permission
 * node.
 */
@Controller('attendance')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.connector.create', 'editable')
  @Post('connectors')
  async createConnector(@Body() dto: CreateConnectorDto, @Req() req: CompanyScopedRequest) {
    return this.attendance.createConnector(dto.name, dto.connectorType, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.connector.view', 'read-only')
  @Get('connectors')
  async listConnectors(@Req() req: CompanyScopedRequest) {
    return this.attendance.listConnectors(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.mapping.create', 'editable')
  @Post('mappings')
  async createMapping(@Body() dto: CreateMappingDto, @Req() req: CompanyScopedRequest) {
    return this.attendance.createMapping(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.mapping.edit', 'editable')
  @Post('mappings/:id/close')
  async closeMapping(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.attendance.closeMapping(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.mapping.view', 'read-only')
  @Get('mappings')
  async listMappings(@Req() req: CompanyScopedRequest) {
    return this.attendance.listMappings(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.raw_record.view', 'read-only')
  @Get('raw-records/unmapped')
  async listUnmappedRecords(@Req() req: CompanyScopedRequest) {
    return this.attendance.listUnmappedRecords(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.manual_entry.create', 'editable')
  @Post('manual-entries')
  async recordManualPunch(@Body() dto: ManualPunchDto, @Req() req: CompanyScopedRequest) {
    return this.attendance.recordManualPunch(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.import.view', 'read-only')
  @Get('import-template')
  async importTemplate(@Res() res: Response) {
    const buffer = await this.attendance.buildImportTemplate();
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="attendance-import-template.xlsx"' });
    res.send(buffer);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.import.create', 'editable')
  @Post('import/preview')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async previewImport(@UploadedFile() file: Express.Multer.File, @Req() req: CompanyScopedRequest) {
    return this.attendance.previewImport(file.buffer, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.import.create', 'editable')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async importExcel(@UploadedFile() file: Express.Multer.File, @Req() req: CompanyScopedRequest) {
    return this.attendance.importExcel(file.buffer, file.originalname, req.user.id, req.companyContext!.dataSource.manager);
  }

  // ---------------------------------------------------------------------------
  // Biometric Daily Attendance Summary — CTO directive (2026-09-20). Same
  // `attendance.import.*` permission nodes as the punch-log importer above
  // — this is the same capability (importing attendance), a different
  // confirmed source format, not a new scope.
  // ---------------------------------------------------------------------------

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.import.view', 'read-only')
  @Get('biometric-import-template')
  async biometricImportTemplate(@Res() res: Response) {
    const buffer = await this.attendance.buildBiometricDailyImportTemplate();
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="biometric-daily-attendance-template.xlsx"' });
    res.send(buffer);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.import.create', 'editable')
  @Post('biometric-import/preview')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async previewBiometricImport(@UploadedFile() file: Express.Multer.File, @Req() req: CompanyScopedRequest) {
    return this.attendance.previewBiometricDailyImport(file.buffer, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.import.create', 'editable')
  @Post('biometric-import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async importBiometric(@UploadedFile() file: Express.Multer.File, @Req() req: CompanyScopedRequest) {
    return this.attendance.importBiometricDailySummary(file.buffer, file.originalname, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.raw_record.view', 'read-only')
  @Get('biometric-import/unmapped')
  async listUnmappedBiometricRows(@Req() req: CompanyScopedRequest) {
    return this.attendance.listUnmappedBiometricRows(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.import.view', 'read-only')
  @Get('biometric-import/history')
  async listBiometricImportBatches(@Req() req: CompanyScopedRequest) {
    return this.attendance.listBiometricImportBatches(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.day.view', 'read-only')
  @Get('biometric-facts')
  async listBiometricFacts(@Req() req: CompanyScopedRequest, @Query('employeeId') employeeId?: string) {
    return this.attendance.listBiometricFacts(employeeId, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.day.view', 'read-only')
  @Get('days')
  async listDays(@Req() req: CompanyScopedRequest, @Query('employeeId') employeeId?: string) {
    return this.attendance.listDays(employeeId, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.correction.create', 'editable')
  @Post('days/:id/correct')
  async correctDay(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectDayDto, @Req() req: CompanyScopedRequest) {
    return this.attendance.correctDay(id, dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.approval.create', 'editable')
  @Post('approval-batches')
  async submitApprovalBatch(@Body() dto: SubmitApprovalBatchDto, @Req() req: CompanyScopedRequest) {
    return this.attendance.submitApprovalBatch(dto.periodStart, dto.periodEnd, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.approval.view', 'read-only')
  @Get('approval-batches')
  async listApprovalBatches(@Req() req: CompanyScopedRequest) {
    return this.attendance.listApprovalBatches(req.companyContext!.dataSource.manager);
  }

  /** Same generic decide route for BOTH request types this module registers (approval batches and corrections) — `ApprovalEngineService.decide` needs only the request id, never a type discriminator, so one route serves both. Same shape as `ApprovalsPanel`'s own generic `decidePath`. */
  @UseGuards(PermissionGuard)
  @RequirePermission('attendance.approval.approve', 'editable')
  @Post('approvals/:requestId/decide')
  async decide(@Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: DecideDto, @Req() req: CompanyScopedRequest) {
    return this.attendance.decide(requestId, req.user.id, dto.decision, dto.note, req.companyContext!.dataSource.manager);
  }
}
