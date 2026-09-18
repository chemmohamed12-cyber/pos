import { Body, Controller, Get, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Min, MinLength, ValidateIf } from 'class-validator';
import { CustomersService } from '../application/customers.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RolesGuard } from '../../../foundation/authorization/roles.guard';
import { RequireRole } from '../../../foundation/authorization/require-role.decorator';
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
 */
@Controller('customers')
@UseGuards(JwtAuthGuard)
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly excel: ExcelService,
  ) {}

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateCustomerDto) {
    return this.customers.createCustomer(dto, req.user.id);
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
   */
  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('salesRepUserId') salesRepUserId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (!page && !pageSize) {
      return this.customers.listCustomersForRep(req.user.id, salesRepUserId);
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.customers.listCustomersPage(req.user.id, { salesRepUserId, page: parsedPage, pageSize: parsedPageSize });
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

  @Get('export')
  async export(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const rows = await this.customers.listCustomers(req.user.id);
    const repNames = await this.customers.getPrimaryRepNamesByCustomerId(rows.map((c) => c.id));
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
  async import(@Req() req: AuthenticatedRequest, @UploadedFile() file: Express.Multer.File) {
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, IMPORT_COLUMNS);
    if (headerErrors.length > 0) {
      return { totalRows: 0, succeededCount: 0, rejected: [], headerErrors };
    }
    const { succeeded, rejected } = await this.customers.importRows(
      rows as Array<{
        name: string;
        managerName: string;
        address: string;
        governorate: string;
        classification: string;
        phone: string;
        whatsappPhone: string;
        salesRepName: string;
        contactMethod: string;
        responsivenessLevel: string;
        disinterestNotes: string;
        priceSatisfactionLevel: string;
        topBrand: string;
        midBrand: string;
        lowBrand: string;
        shippingMethodPreference: string;
        locationUrl: string;
      }>,
      req.user.id,
    );
    return { totalRows: rows.length, succeededCount: succeeded.length, rejectedCount: rejected.length, rejected, headerErrors: [] };
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.customers.getCustomer(id, req.user.id);
  }

  /** ERP UI Integration (CTO directive) — Customer Account header's "Sales Representative" field. Reuses the existing `getPrimaryRepNamesByCustomerId` (built for the Excel export) for a single customer, Scope-checked via `getCustomer` first. */
  @Get(':id/primary-rep')
  async primaryRep(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.customers.getCustomer(id, req.user.id);
    const names = await this.customers.getPrimaryRepNamesByCustomerId([id]);
    return { name: names.get(id) ?? null };
  }

  // V1 Release Audit HIGH fix — this was the one write on this
  // controller missing a role gate (every sibling business-policy route
  // below requires admin/sales_manager); assigning a sales rep grants
  // that rep real Scope access to the customer, so it's not a low-risk
  // gap to leave open to any authenticated user.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireRole('admin', 'sales_manager')
  @Post(':id/assign')
  async assign(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: AssignSalesRepDto) {
    return this.customers.assignSalesRep(id, dto.salesRepUserId, dto.assignmentType, req.user.id);
  }

  /**
   * Gap G-1 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md,
   * CTO handover directive §6) — a business-policy decision, not a
   * per-rep action, so it's role-gated above the plain JwtAuthGuard every
   * other route here uses.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireRole('admin', 'sales_manager')
  @Post(':id/workflow-policy')
  async setWorkflowPolicy(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SetWorkflowPolicyDto,
  ) {
    return this.customers.setOrderWorkflowPolicy(id, dto.orderWorkflowPolicy, req.user.id);
  }

  /** Gap G-3 — same role tier as workflow-policy above: a commercial-policy decision, not a per-rep action. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireRole('admin', 'sales_manager')
  @Post(':id/price-list')
  async setPriceList(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetPriceListDto) {
    return this.customers.setPriceList(id, dto.priceListId, req.user.id);
  }

  /**
   * Completes a real gap found in a UI-completion review: `CustomersService.setStatus`
   * and `canTransitionCustomerStatus` already existed with real transition
   * rules, but no controller route ever exposed them — the capability was
   * backend-only, unreachable even via a raw API call. Admin-gated (not
   * sales_manager) since activating/suspending a customer is closer to
   * an administrative action than a commercial-policy one.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireRole('admin')
  @Post(':id/status')
  async setStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetCustomerStatusDto) {
    return this.customers.setStatus(id, dto.status, req.user.id);
  }

  /** Same gap class as setStatus above — `Customer.classification` existed in the schema with zero write path anywhere. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireRole('admin', 'sales_manager')
  @Post(':id/classification')
  async setClassification(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetClassificationDto) {
    return this.customers.setClassification(id, dto.classification || null, req.user.id);
  }

  /** Customer Financial Account / AR (CTO directive §10 — Credit Control) — admin-only, a finance-policy decision. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireRole('admin')
  @Post(':id/financial-settings')
  async setFinancialSettings(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetFinancialSettingsDto) {
    return this.customers.setFinancialSettings(
      id,
      {
        creditLimit: dto.creditLimit,
        paymentTermsDays: dto.paymentTermsDays,
        accountType: dto.accountType,
        financialStatus: dto.financialStatus,
      },
      req.user.id,
    );
  }
}
