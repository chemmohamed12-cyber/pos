import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, Min, MaxLength, MinLength } from 'class-validator';
import { SupplierService } from '../application/supplier.service';
import { SupplierProfileService } from '../application/supplier-profile.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateSupplierDto {
  /** D9 — optional: omitted = auto-numbered ("SUP-000001"). */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string;

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

/** D9 — editable master data. `code` is not accepted (immutable); unknown properties are stripped by the global ValidationPipe. */
class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  tradingName?: string | null;

  @IsOptional()
  @IsIn(['company', 'individual'])
  supplierType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxRegistrationNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  vatRegistrationNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  commercialRegistrationNumber?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  paymentTermsDays?: number;

  @IsOptional()
  @IsNumberString()
  creditLimitBase?: string | null;

  // Supplier profile (gap matrix §5.3) — value rules (e-mail format, language) are enforced in `SupplierService.updateSupplier`.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  internalNotes?: string | null;
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

class UpdateSupplierContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string | null;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

class UpdateSupplierAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  label?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  addressLine?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  governorate?: string | null;

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
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('procurement')
export class SupplierController {
  constructor(
    private readonly suppliers: SupplierService,
    private readonly ledger: SupplierLedgerService,
    private readonly profile: SupplierProfileService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest, @Query('status') status?: string) {
    return this.suppliers.list(status as 'active' | 'inactive' | undefined, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.view', 'read-only')
  /** The default supplier code for the create form (a preview; nothing is issued). Same permission as creating a supplier. Declared before `:id`. */
  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.create', 'editable')
  @Get('next-code')
  async nextCode(@Req() req: CompanyScopedRequest) {
    return { code: await this.suppliers.peekNextCode(req.companyContext!.dataSource.manager) };
  }

  @Get('all')
  async listAllActive(@Req() req: CompanyScopedRequest) {
    return this.suppliers.listAllActive(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.view', 'read-only')
  @Get(':id/ledger')
  async getLedger(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    const manager = req.companyContext!.dataSource.manager;
    const [entries, balance] = await Promise.all([this.ledger.listLedger(id, { from, to }, manager), this.ledger.getSupplierBalance(id, manager)]);
    return { entries, balance };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.view', 'read-only')
  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.suppliers.getById(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.create', 'editable')
  @Post()
  async create(@Body() dto: CreateSupplierDto, @Req() req: CompanyScopedRequest) {
    return this.suppliers.create(dto as never, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/update') // POST, not PATCH: the shared frontend `api` helper has no PATCH (same convention as CompanyMembers)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto, @Req() req: CompanyScopedRequest) {
    return this.suppliers.updateSupplier(id, dto as never, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/status')
  async setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetStatusDto, @Req() req: CompanyScopedRequest) {
    return this.suppliers.setStatus(id, dto.status as 'active' | 'inactive', req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/contacts')
  async addContact(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddContactDto, @Req() req: CompanyScopedRequest) {
    return this.suppliers.addContact(id, dto, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/contacts/:contactId/update')
  async updateContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateSupplierContactDto,
    @Req() req: CompanyScopedRequest,
  ) {
    return this.profile.updateContact(id, contactId, dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/contacts/:contactId/remove')
  async removeContact(@Param('id', ParseUUIDPipe) id: string, @Param('contactId', ParseUUIDPipe) contactId: string, @Req() req: CompanyScopedRequest) {
    return this.profile.removeContact(id, contactId, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/addresses/:addressId/update')
  async updateAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() dto: UpdateSupplierAddressDto,
    @Req() req: CompanyScopedRequest,
  ) {
    return this.profile.updateAddress(id, addressId, dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/addresses/:addressId/remove')
  async removeAddress(@Param('id', ParseUUIDPipe) id: string, @Param('addressId', ParseUUIDPipe) addressId: string, @Req() req: CompanyScopedRequest) {
    return this.profile.removeAddress(id, addressId, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/addresses')
  async addAddress(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddAddressDto, @Req() req: CompanyScopedRequest) {
    return this.suppliers.addAddress(id, dto, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier.edit', 'editable')
  @Post(':id/bank-accounts')
  async addBankAccount(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddBankAccountDto, @Req() req: CompanyScopedRequest) {
    return this.suppliers.addBankAccount(id, dto, req.user.id, req.companyContext!.dataSource.manager);
  }
}
