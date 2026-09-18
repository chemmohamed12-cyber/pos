import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, Min, MaxLength, MinLength } from 'class-validator';
import { SupplierService } from '../application/supplier.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateSupplierDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  legalName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  tradingName?: string;

  @IsOptional()
  @IsIn(['company', 'individual'])
  supplierType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxRegistrationNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  vatRegistrationNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  commercialRegistrationNumber?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  paymentTermsDays?: number;

  @IsOptional()
  @IsNumberString()
  creditLimitBase?: string;
}

class SetStatusDto {
  @IsIn(['active', 'inactive'])
  status!: string;
}

class AddContactDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

class AddAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  label?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  addressLine!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  governorate?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

class AddBankAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  bankName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  accountNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  swift?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

/**
 * ADR-048 — Procurement's Supplier Master routes. Same guard stack as
 * every other built module: `@RequireModule('procurement')` (404 for
 * un-entitled) + a per-route `@RequirePermission`.
 */
@Controller('procurement/suppliers')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('procurement')
export class SupplierController {
  constructor(
    private readonly suppliers: SupplierService,
    private readonly ledger: SupplierLedgerService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.view', 'read-only')
  @Get()
  async list(@Query('status') status?: string) {
    return this.suppliers.list(status as 'active' | 'inactive' | undefined);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.view', 'read-only')
  @Get('all')
  async listAllActive() {
    return this.suppliers.listAllActive();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.view', 'read-only')
  @Get(':id/ledger')
  async getLedger(@Param('id', ParseUUIDPipe) id: string, @Query('from') from?: string, @Query('to') to?: string) {
    const [entries, balance] = await Promise.all([this.ledger.listLedger(id, { from, to }), this.ledger.getSupplierBalance(id)]);
    return { entries, balance };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.view', 'read-only')
  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.getById(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.create', 'editable')
  @Post()
  async create(@Body() dto: CreateSupplierDto, @Req() req: AuthenticatedRequest) {
    return this.suppliers.create(dto as never, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/status')
  async setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetStatusDto, @Req() req: AuthenticatedRequest) {
    return this.suppliers.setStatus(id, dto.status as 'active' | 'inactive', req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/contacts')
  async addContact(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddContactDto) {
    return this.suppliers.addContact(id, dto);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/addresses')
  async addAddress(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddAddressDto) {
    return this.suppliers.addAddress(id, dto);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/bank-accounts')
  async addBankAccount(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddBankAccountDto, @Req() req: AuthenticatedRequest) {
    return this.suppliers.addBankAccount(id, dto, req.user.id);
  }
}
