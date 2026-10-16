import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { CustomersService, CustomerImportRow } from '../application/customers.service';
import { CustomerProfileService } from '../application/customer-profile.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { ExcelService, ColumnSpec } from '../../../foundation/excel/excel.service';
import { ORDER_WORKFLOW_POLICIES, OrderWorkflowPolicy } from '../domain/order-workflow-policy';

class CreateCustomerDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  // Gap G-5 — the real CRM master sheet's own fields (see customers.service.ts's CreateCustomerInput doc comment).
  @IsOptional()
  @IsString()
  managerName?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  governorate?: string;

  @IsOptional()
  @IsString()
  whatsappPhone?: string;

  @IsOptional()
  @IsString()
  contactMethod?: string;

  @IsOptional()
  @IsString()
  responsivenessLevel?: string;

  @IsOptional()
  @IsString()
  disinterestNotes?: string;

  @IsOptional()
  @IsString()
  priceSatisfactionLevel?: string;

  @IsOptional()
  @IsString()
  topBrand?: string;

  @IsOptional()
  @IsString()
  midBrand?: string;

  @IsOptional()
  @IsString()
  lowBrand?: string;

  @IsOptional()
  @IsString()
  shippingMethodPreference?: string;

  @IsOptional()
  @IsString()
  locationUrl?: string;
}

class AssignSalesRepDto {
  @IsString()
  salesRepUserId!: string;

  @IsIn(['primary', 'secondary'])
  assignmentType!: 'primary' | 'secondary';
}

class SetWorkflowPolicyDto {
  @IsIn(ORDER_WORKFLOW_POLICIES)
  orderWorkflowPolicy!: OrderWorkflowPolicy;
}

class SetPriceListDto {
  // null clears the assignment (back to "use each product's base price") — validated only when not null/undefined.
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  priceListId!: string | null;
}

class SetCustomerStatusDto {
  @IsIn(['pending', 'active', 'suspended'])
  status!: 'pending' | 'active' | 'suspended';
}

class SetFinancialSettingsDto {
  // null explicitly clears the limit ("no limit set"); omitted leaves it untouched — same convention as `SetPriceListDto`.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumberString()
  creditLimit?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  paymentTermsDays?: number | null;

  @IsOptional()
  @IsIn(['cash', 'credit'])
  accountType?: 'cash' | 'credit';

  @IsOptional()
  @IsIn(['active', 'on_hold', 'suspended'])
  financialStatus?: 'active' | 'on_hold' | 'suspended';
}

/**
 * Customer profile (gap matrix §5.3). Every property is optional: `undefined` leaves a field untouched, a blank string/`null` clears it.
 * Value rules (party type, language, e-mail format, lengths) live in `CustomerProfileService` so the API answers with one clear 400.
 */
class UpdateCustomerProfileDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(64) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(64) whatsappPhone?: string | null;
  @IsOptional() @IsString() @MaxLength(255) managerName?: string | null;
  @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @IsOptional() @IsString() @MaxLength(128) governorate?: string | null;
  @IsOptional() @IsString() @MaxLength(16) partyType?: string | null;
  @IsOptional() @IsString() @MaxLength(255) legalName?: string | null;
  @IsOptional() @IsString() @MaxLength(64) taxRegistrationNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(64) vatRegistrationNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(64) commercialRegistrationNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(255) email?: string | null;
  @IsOptional() @IsString() @MaxLength(255) website?: string | null;
  @IsOptional() @IsString() @MaxLength(8) language?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) internalNotes?: string | null;
}

class CustomerContactDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(128) title?: string | null;
  @IsOptional() @IsString() @MaxLength(64) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(255) email?: string | null;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

class CustomerAddressDto {
  @IsOptional() @IsString() @MaxLength(128) label?: string | null;
  @IsOptional() @IsString() @MaxLength(500) addressLine?: string;
  @IsOptional() @IsString() @MaxLength(128) city?: string | null;
  @IsOptional() @IsString() @MaxLength(128) governorate?: string | null;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() isBilling?: boolean;
  @IsOptional() @IsBoolean() isShipping?: boolean;
}

class SetClassificationDto {
  // empty string clears the classification — same "explicit null-ish clear" convention as SetPriceListDto.
  @IsString()
  classification!: string;
}

/**
 * Gap G-5 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4) —
 * these headers ARE the real CRM master sheet's own column headers
 * (`احمد/شيت تحليل العملاء الرئيسي الجديد.xlsx`, sheet `بيانات العملاء`,
 * row 2), per the CTO's explicit instruction to adopt that sheet as
 * Daii's customer import/export format rather than an invented one.
 * `كود` (code) is deliberately omitted — Daii's Numbering Engine issues
 * it, never a user-supplied value (same precedent as Products/
 * Warehouses import). Sales rep is matched by NAME here because the
 * real sheet has no email column (see `CustomersService.importRows`).
 */
const IMPORT_COLUMNS: ColumnSpec[] = [
  { key: 'name', header: 'اسم العميل', width: 28, example: 'Aylin Restaurant & cafe' },
  { key: 'managerName', header: 'اسم المدير', width: 22, example: 'استاذ مصطفي' },
  { key: 'address', header: 'العنوان', width: 24, example: 'مول طنطا' },
  { key: 'governorate', header: 'المحافظه', width: 16, example: 'الغربيه' },
  { key: 'classification', header: 'تصنيف العملاء', width: 14, example: 'A' },
  { key: 'phone', header: 'رقم التليفون للتواصل', width: 20, example: '01067100334' },
  { key: 'whatsappPhone', header: 'رقم التليفون الواتس', width: 20, example: '01067100334' },
  { key: 'salesRepName', header: 'اسم المندوب', width: 20, example: 'ا حسين' },
  { key: 'contactMethod', header: 'طريقه التواصل', width: 18 },
  { key: 'responsivenessLevel', header: 'مدي استجابه العميل للرد علينا', width: 22 },
  { key: 'disinterestNotes', header: 'ملاحظات ع اسباب غير مهتم', width: 26 },
  { key: 'priceSatisfactionLevel', header: 'مدي رضا العميل عن الاسعار', width: 22 },
  { key: 'topBrand', header: 'البراند اكثر طلبا', width: 18 },
  { key: 'midBrand', header: 'البراند متوسط طلبا', width: 18 },
  { key: 'lowBrand', header: 'البراند اقل طلبا', width: 18 },
  { key: 'shippingMethodPreference', header: 'طريقه الشحن', width: 16 },
  { key: 'locationUrl', header: 'اللوكيشن', width: 24 },
];

const EXPORT_COLUMNS: ColumnSpec[] = [
  { key: 'code', header: 'كود', width: 14 },
  ...IMPORT_COLUMNS,
  { key: 'status', header: 'الحالة', width: 14 },
];

/**
 * CRM / Customer Management — Stage 2 build-order item 22.
 * Every route requires authentication (JwtAuthGuard); Scope enforcement
 * happens inside CustomersService itself (get/list), not here — the
 * controller stays a thin translation layer, per this session's
 * established pattern. Excel export reuses `listCustomers`, so it is
 * automatically Scope-filtered exactly like the operational screen — a
 * plain sales_rep can never export another rep's customers (CTO
 * finalization directive §8).
 *
 * Area 21 Operational Company Scoping Retrofit (2026-09-27,
 * CTO-authorized). `CompanyContextGuard` added at the class level —
 * `Customer`/`CustomerAssignment` are genuinely Company-owned data
 * (established by `sales-orders.controller.ts`'s own retrofit; both
 * entities already registered in `crm-company-entities.ts`). Every route
 * threads `req.companyContext.dataSource.manager` into
 * `CustomersService`, which in turn threads it into every nested
 * `ScopeService`/`AuthorizationService`/`NumberingService`/`AuditService`/
 * `LimitService` call — none of those stop at this controller's own
 * boundary. `LimitService.check()` itself gained a `manager?` parameter
 * during this pass — it previously had none at all, so
 * `createCustomer`'s `sales.max_customers` pre-check would otherwise have
 * kept silently resolving the ambient (Platform) connection's counters
 * even after every other part of this retrofit was correct.
 */
@Controller('customers')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('sales')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly profile: CustomerProfileService,
    private readonly excel: ExcelService,
  ) {}

  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateCustomerDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.customers.createCustomer(dto, req.user.id, req.companyContext.dataSource.manager);
  }

  /**
   * `salesRepUserId` (CTO instruction, Priority 1): when the Sales Order
   * screen's rep-selector picks a specific rep, this narrows the list to
   * ONLY that rep's assigned customers, enforced server-side in
   * `listCustomersForRep` (a plain rep may only ever pass their own id).
   * Omitted, behavior is unchanged — a rep sees their own Scope-filtered
   * list, a reviewer sees everyone (including unassigned customers).
   */
  /**
   * `page`/`pageSize` are opt-in (pagination audit fix, MASTER_PROJECT_
   * STATUS.md §6): omitted entirely, this keeps returning the full plain
   * array exactly as before — every existing consumer (the rep-selector
   * narrowing above, and any caller that hasn't been updated to the new
   * `{rows, total}` shape) keeps working unchanged. Pass either param to
   * opt into the real, take/skip-bounded `listCustomersPage` and get
   * back `{rows, total}` instead — same clamp convention as
   * `InventoryController.warehouseInventory` (page >= 1, pageSize 1..200,
   * default 50).
   *
   * `search` (Smart Lookup UX initiative): also opts into the paginated
   * path — a Customer picker needs `?search=` support since the table is
   * unbounded, and there's no reason to add a THIRD response shape just
   * for the search case.
   */
  @Get()
  async list(
    @Req() req: CompanyScopedRequest,
    @Query('salesRepUserId') salesRepUserId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    if (!page && !pageSize && !search) {
      return this.customers.listCustomersForRep(req.user.id, salesRepUserId, req.companyContext.dataSource.manager);
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.customers.listCustomersPage(
      req.user.id,
      { salesRepUserId, search, page: parsedPage, pageSize: parsedPageSize },
      req.companyContext.dataSource.manager,
    );
  }

  @Get('import-template')
  async importTemplate(@Res() res: Response) {
    // Plain (non-passthrough) @Res() bypasses the global ResponseEnvelopeInterceptor,
    // which would otherwise JSON-wrap this binary xlsx buffer — see products.controller.ts.
    const buffer = await this.excel.buildTemplate('Customers', IMPORT_COLUMNS);
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="customers-import-template.xlsx"',
      })
      .send(buffer);
  }

  // Security Assurance Gate — Track S7 (Resource Exhaustion): unbounded
  // full-dataset query + in-memory XLSX build on every call, only the
  // generic 300/min global throttle applied — narrowed here the same way
  // `AuthController` narrows its own sensitive routes (see
  // `ReportsController.salesOrdersExport`'s own comment for full rationale).
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('export')
  async export(@Req() req: CompanyScopedRequest, @Res() res: Response) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const rows = await this.customers.listCustomers(req.user.id, manager);
    const repNames = await this.customers.getPrimaryRepNamesByCustomerId(rows.map((c) => c.id), manager);
    const buffer = await this.excel.buildExport(
      'Customers',
      EXPORT_COLUMNS,
      rows.map((c) => ({
        code: c.code,
        name: c.name,
        managerName: c.managerName ?? '',
        address: c.address ?? '',
        governorate: c.governorate ?? '',
        classification: c.classification ?? '',
        phone: c.phone ?? '',
        whatsappPhone: c.whatsappPhone ?? '',
        salesRepName: repNames.get(c.id) ?? '',
        contactMethod: c.contactMethod ?? '',
        responsivenessLevel: c.responsivenessLevel ?? '',
        disinterestNotes: c.disinterestNotes ?? '',
        priceSatisfactionLevel: c.priceSatisfactionLevel ?? '',
        topBrand: c.topBrand ?? '',
        midBrand: c.midBrand ?? '',
        lowBrand: c.lowBrand ?? '',
        shippingMethodPreference: c.shippingMethodPreference ?? '',
        locationUrl: c.locationUrl ?? '',
        status: c.status,
      })),
    );
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="customers-export.xlsx"',
      })
      .send(buffer);
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async import(@Req() req: CompanyScopedRequest, @UploadedFile() file: Express.Multer.File) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, IMPORT_COLUMNS);
    if (headerErrors.length > 0) {
      return { totalRows: 0, succeededCount: 0, rejected: [], headerErrors };
    }
    const { succeeded, rejected } = await this.customers.importRows(
      rows as unknown as CustomerImportRow[],
      req.user.id,
      req.companyContext.dataSource.manager,
    );
    return { totalRows: rows.length, succeededCount: succeeded.length, rejectedCount: rejected.length, rejected, headerErrors: [] };
  }

  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.customers.getCustomer(id, req.user.id, req.companyContext.dataSource.manager);
  }

  /** ERP UI Integration (CTO directive) — Customer Account header's "Sales Representative" field. Reuses the existing `getPrimaryRepNamesByCustomerId` (built for the Excel export) for a single customer, Scope-checked via `getCustomer` first. */
  @Get(':id/primary-rep')
  async primaryRep(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    const names = await this.customers.getPrimaryRepNamesByCustomerId([id], manager);
    return { name: names.get(id) ?? null };
  }

  // V1 Release Audit HIGH fix — this was the one write on this
  // controller missing a role gate (every sibling business-policy route
  // below requires admin/sales_manager); assigning a sales rep grants
  // that rep real Scope access to the customer, so it's not a low-risk
  // gap to leave open to any authenticated user.
  //
  // AUDIT-SEC-27 (Security Assurance Gate S2, live-proven 2026-09-09):
  // the permission gate above was the ONLY check — no Scope check ever
  // ran, so any actor holding `sales.customer.assign` (regardless of
  // which customers they actually have Scope over) could reassign ANY
  // customer in the system. `getCustomer()` is called here purely for
  // its scope-check side effect (404s for an out-of-scope customer,
  // REVIEWER_ROLES bypass) — the exact same pattern `primaryRep()` above
  // already uses, extended to this write path. Deliberately NOT added
  // inside `CustomersService.assignSalesRep()` itself: that method is
  // also called internally right after a customer is first CREATED (bulk
  // import's own self-assignment, and the QR Store integration's system-
  // user assignment) — at that moment the actor legitimately has no
  // PRE-EXISTING scope over a customer that didn't exist a moment ago, so
  // a service-level check would break those two legitimate flows. The
  // gap was specifically this PUBLIC endpoint never re-validating scope
  // for an ALREADY-EXISTING customer being reassigned by someone else.
  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.assign', 'editable')
  @Post(':id/assign')
  async assign(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: AssignSalesRepDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.customers.assignSalesRep(id, dto.salesRepUserId, dto.assignmentType, req.user.id, manager);
  }

  /**
   * Gap G-1 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md,
   * CTO handover directive §6) — a business-policy decision, not a
   * per-rep action, so it's role-gated above the plain JwtAuthGuard every
   * other route here uses.
   */
  // AUDIT-SEC-28 (S21, 2026-09-10): found alongside AUDIT-SEC-27 by an
  // independent sweep for the same gap shape — a permission gate with no
  // Scope check. Today only `sales_manager`/`admin` hold
  // `sales.customer.edit`, both `CustomersService.REVIEWER_ROLES`
  // members who already bypass Scope by design, so this was latent, not
  // live-exploitable — but that's a role-grant-table fact, not a code
  // invariant, and AUDIT-SEC-27 was treated as a real gap on the same
  // reasoning regardless of which roles happened to hold the node.
  // `getCustomer()` (the same scope-check-with-REVIEWER_ROLES-bypass
  // helper `assign()` was fixed to use) added to every write below.
  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.edit', 'editable')
  @Post(':id/workflow-policy')
  async setWorkflowPolicy(
    @Req() req: CompanyScopedRequest,
    @Param('id') id: string,
    @Body() dto: SetWorkflowPolicyDto,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.customers.setOrderWorkflowPolicy(id, dto.orderWorkflowPolicy, req.user.id, manager);
  }

  /** Gap G-3 — same role tier as workflow-policy above: a commercial-policy decision, not a per-rep action. */
  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.edit', 'editable')
  @Post(':id/price-list')
  async setPriceList(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetPriceListDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.customers.setPriceList(id, dto.priceListId, req.user.id, manager);
  }

  /**
   * Completes a real gap found in a UI-completion review: `CustomersService.setStatus`
   * and `canTransitionCustomerStatus` already existed with real transition
   * rules, but no controller route ever exposed them — the capability was
   * backend-only, unreachable even via a raw API call. Admin-gated (not
   * sales_manager) since activating/suspending a customer is closer to
   * an administrative action than a commercial-policy one.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer_status.edit', 'editable')
  @Post(':id/status')
  async setStatus(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetCustomerStatusDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.customers.setStatus(id, dto.status, req.user.id, manager);
  }

  /** Same gap class as setStatus above — `Customer.classification` existed in the schema with zero write path anywhere. */
  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.edit', 'editable')
  @Post(':id/classification')
  async setClassification(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetClassificationDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.customers.setClassification(id, dto.classification || null, req.user.id, manager);
  }

  // ---- Customer profile (gap matrix §5.3): reads follow the customer read scope; writes need `sales.customer.edit`. ----

  @Get(':id/profile')
  async getProfile(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager); // the existing row-scope / read-any check
    return this.profile.getProfile(id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.edit', 'editable')
  @Post(':id/update') // POST, not PATCH: the shared frontend `api` helper has no PATCH (same convention as suppliers)
  async updateProfile(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerProfileDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.profile.updateProfile(id, dto, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.edit', 'editable')
  @Post(':id/contacts')
  async addContact(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CustomerContactDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.profile.addContact(id, dto, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.edit', 'editable')
  @Post(':id/contacts/:contactId/update')
  async updateContact(
    @Req() req: CompanyScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: CustomerContactDto,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.profile.updateContact(id, contactId, dto, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.edit', 'editable')
  @Post(':id/contacts/:contactId/remove')
  async removeContact(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('contactId', ParseUUIDPipe) contactId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.profile.removeContact(id, contactId, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.edit', 'editable')
  @Post(':id/addresses')
  async addAddress(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CustomerAddressDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.profile.addAddress(id, dto, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.edit', 'editable')
  @Post(':id/addresses/:addressId/update')
  async updateAddress(
    @Req() req: CompanyScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() dto: CustomerAddressDto,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.profile.updateAddress(id, addressId, dto, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer.edit', 'editable')
  @Post(':id/addresses/:addressId/remove')
  async removeAddress(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('addressId', ParseUUIDPipe) addressId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.profile.removeAddress(id, addressId, req.user.id, manager);
  }

  /** Customer Financial Account / AR (CTO directive §10 — Credit Control) — admin-only, a finance-policy decision. */
  @UseGuards(PermissionGuard)
  @RequirePermission('sales.customer_financial.edit', 'editable')
  @Post(':id/financial-settings')
  async setFinancialSettings(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetFinancialSettingsDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.customers.getCustomer(id, req.user.id, manager);
    return this.customers.setFinancialSettings(
      id,
      {
        creditLimit: dto.creditLimit,
        paymentTermsDays: dto.paymentTermsDays,
        accountType: dto.accountType,
        financialStatus: dto.financialStatus,
      },
      req.user.id,
      manager,
    );
  }
}
