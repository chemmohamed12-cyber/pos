import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { ShipmentService } from '../application/shipment.service';
import { VehicleAccessService } from '../application/vehicle-access.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { OrgContextService } from '../../../foundation/scope/org-context.service';

class CreateShipmentDto {
  @IsString()
  fulfillmentOrderId!: string;

  @IsOptional()
  @IsString()
  shippingCompanyId?: string;

  @IsOptional()
  @IsNumberString()
  codAmount?: string;

  @IsOptional()
  @IsString()
  vehicleId?: string;
}

class CreateShippingCompanyDto {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  responsiblePerson?: string;

  @IsOptional()
  @IsString()
  parentWarehouseId?: string;
}

class UpdateShippingCompanyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  responsiblePerson?: string;
}

class CreateVehicleDto {
  @IsOptional()
  @IsString()
  orgUnitId?: string;

  @IsString()
  code!: string;

  @IsString()
  plateNumber!: string;

  @IsOptional()
  @IsString()
  driverUserId?: string;

  @IsOptional()
  @IsString()
  shippingCompanyId?: string;

  @IsOptional()
  @IsString()
  branch?: string;

  @IsOptional()
  @IsString()
  parentWarehouseId?: string;
}

class ApplyVehicleMappingDto {
  /** The vehicles the owner confirmed from the mapping report; only an unambiguous `proposed` match is ever applied. */
  @IsArray()
  @IsString({ each: true })
  vehicleIds!: string[];
}

class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  orgUnitId?: string;

  @IsOptional()
  @IsString()
  plateNumber?: string;

  @IsOptional()
  @IsString()
  branch?: string;
}

class SetVehicleDriverDto {
  @IsOptional()
  @IsString()
  driverUserId?: string;
}

class SetVehicleStatusDto {
  @IsIn(['active', 'retired'])
  status!: 'active' | 'retired';
}

class SetVehicleSettlementAccountDto {
  @IsOptional()
  @IsString()
  treasuryAccountId?: string;
}

class SetVehicleExpenseFloatDto {
  @IsOptional()
  @IsUUID()
  treasuryAccountId?: string;
}

class SetShippingCompanyTreasuryAccountDto {
  @IsOptional()
  @IsString()
  treasuryAccountId?: string;
}

class SetShippingCompanyStatusDto {
  @IsIn(['active', 'inactive'])
  status!: 'active' | 'inactive';
}

class AssignDriverDto {
  @IsString()
  driverUserId!: string;
}

class SetCarrierWaybillDto {
  @IsOptional()
  @IsString()
  carrierWaybillNumber?: string;

  @IsOptional()
  @IsString()
  waybillImageMediaAssetId?: string;

  @IsOptional()
  @IsString()
  carrierContactPhone?: string;
}

class AssignShippingRouteDto {
  @IsOptional()
  @IsString()
  shippingCompanyId?: string;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

class TransitionDto {
  @IsString()
  action!: string;
}

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * `CompanyContextGuard` added at the class level — `Shipment`/
 * `ShipmentLine`/`ShippingCompany`/`Vehicle`/`TrackingEvent` are
 * genuinely Company-owned data. Previously STOP/ESCALATED
 * (AREA21-RETROFIT-MATRIX.md §26) — `TreasuryService.listAccountTypes`/
 * `createAccount` (§28) and `FulfillmentService.getFulfillmentOrder`/
 * `getFulfillmentOrderBySalesOrderId` (§26 update) were both closed
 * afterward, and the remaining `SalesOrdersReadContract`/
 * `InventoryLogisticsContract`/`SalesCustomersContract` interface-drift
 * items were widened in the same pass as this retrofit — see this
 * section's own §29 write-up for the full call-graph audit.
 */
@Controller('shipments')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('logistics')
export class ShipmentController {
  constructor(
    private readonly shipments: ShipmentService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly orgContext: OrgContextService,
  ) {}

  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateShipmentDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.createShipment(
      dto.fulfillmentOrderId,
      req.user.id,
      dto.shippingCompanyId ?? null,
      dto.codAmount ?? null,
      dto.vehicleId ?? null,
      req.companyContext.dataSource.manager,
    );
  }

  // ---- Shipping Companies (CTO directive — multi-carrier support) ----
  // Reads broadly available (a warehouse worker creating a shipment needs
  // to see the company list), writes gated to admin — same "Catalog
  // writes admin-gated; reads broadly available" boundary Commerce uses.

  @Get('shipping-companies')
  async listShippingCompanies(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.shipments.listShippingCompanies(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.carrier.create', 'editable')
  @Post('shipping-companies')
  async createShippingCompany(@Req() req: CompanyScopedRequest, @Body() dto: CreateShippingCompanyDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.createShippingCompany(
      dto.code,
      dto.name,
      dto.contactPhone ?? null,
      dto.address ?? null,
      dto.responsiblePerson ?? null,
      req.user.id,
      dto.parentWarehouseId ?? null,
      req.companyContext.dataSource.manager,
    );
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.carrier.edit', 'editable')
  @Post('shipping-companies/:id')
  async updateShippingCompany(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: UpdateShippingCompanyDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.updateShippingCompany(id, dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @Get('shipping-companies/:id/overview')
  async getShippingCompanyOverview(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    // F-1: a company's custody balance and stock are for fleet readers only (no "assigned driver" of a shipping company)
    await this.vehicleAccess.assertCanReadFleet(req.user.id, 'Shipping company', req.companyContext.dataSource.manager);
    return this.shipments.getCustodianOverview('company', id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.carrier.edit', 'editable')
  @Post('shipping-companies/:id/treasury-account')
  async setShippingCompanyTreasuryAccount(
    @Req() req: CompanyScopedRequest,
    @Param('id') id: string,
    @Body() dto: SetShippingCompanyTreasuryAccountDto,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.setShippingCompanyTreasuryAccount(id, dto.treasuryAccountId ?? null, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.carrier.edit', 'editable')
  @Post('shipping-companies/:id/status')
  async setShippingCompanyStatus(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetShippingCompanyStatusDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.setShippingCompanyStatus(id, dto.status, req.user.id, req.companyContext.dataSource.manager);
  }

  // ---- Company Vehicles (CTO directive §2) ----

  /** Org engine Stage 3 — a vehicle of a branch the caller cannot reach answers 404, like a missing one. An unlinked (legacy) vehicle is visible to everyone. */
  private async assertVehicleInScope(req: CompanyScopedRequest, id: string): Promise<void> {
    const vehicle = await this.shipments.getVehicle(id, req.companyContext!.dataSource.manager);
    await this.orgContext.assertVisible(req, vehicle.orgUnitId);
  }

  /**
   * Integration of two rules, BOTH kept (neither weakened): the org-engine branch scope (a vehicle of an unreachable branch is not visible) AND the F-1 access rule (a fleet reader sees
   * every vehicle in scope; anyone else - a driver - only the vehicles they are the assigned driver of).
   */
  @Get('vehicles')
  async listVehicles(@Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const inScope = await this.orgContext.filterVisible(req, await this.shipments.listVehicles(manager));
    return this.vehicleAccess.visibleVehicles(inScope, req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.create', 'editable')
  @Post('vehicles')
  async createVehicle(@Req() req: CompanyScopedRequest, @Body() dto: CreateVehicleDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    // Org engine Stage 2 — the branch is resolved and validated on the server (active branch, inside the caller's scope); required once the Company has branches.
    const orgUnitId = await this.orgContext.resolveBranch(req, { requested: dto.orgUnitId, required: true });
    return this.shipments.createVehicle(
      dto.code,
      dto.plateNumber,
      dto.driverUserId ?? null,
      dto.shippingCompanyId ?? null,
      dto.branch ?? null,
      req.user.id,
      dto.parentWarehouseId ?? null,
      req.companyContext.dataSource.manager,
      orgUnitId,
    );
  }

  /** Legacy free-text branch -> validated branch: a report only, nothing is applied or guessed. */
  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Get('vehicles-branch-mapping-report')
  async vehicleBranchMappingReport(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.shipments.vehicleBranchMappingReport(req.companyContext.dataSource.manager);
  }

  /** Owner-confirmed application of the mapping report: each listed vehicle is re-checked (still unassigned, exactly one branch with that name, inside the caller's scope) and then edited through the normal audited path. Ambiguous / unmatched / no-text vehicles are skipped with a reason, never guessed. */
  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Post('vehicles-branch-mapping-apply')
  async applyVehicleBranchMapping(@Req() req: CompanyScopedRequest, @Body() dto: ApplyVehicleMappingDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const report = await this.shipments.vehicleBranchMappingReport(manager);
    const applied: Array<{ vehicleId: string; code: string; orgUnitId: string }> = [];
    const skipped: Array<{ vehicleId: string; reason: string }> = [];
    for (const id of dto.vehicleIds) {
      const row = report.rows.find((r) => r.vehicleId === id);
      if (!row) { skipped.push({ vehicleId: id, reason: 'not_found_or_already_assigned' }); continue; }
      if (row.status !== 'proposed') { skipped.push({ vehicleId: id, reason: row.status }); continue; }
      const orgUnitId = await this.orgContext.resolveBranch(req, { requested: row.candidates[0].id });
      await this.shipments.updateVehicle(id, { orgUnitId }, req.user.id, manager);
      applied.push({ vehicleId: id, code: row.code, orgUnitId: orgUnitId! });
    }
    return { applied, skipped };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Post('vehicles/:id')
  async updateVehicle(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: UpdateVehicleDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.assertVehicleInScope(req, id);
    const orgUnitId = dto.orgUnitId ? await this.orgContext.resolveBranch(req, { requested: dto.orgUnitId }) : undefined;
    return this.shipments.updateVehicle(id, { plateNumber: dto.plateNumber, branch: dto.branch, ...(orgUnitId ? { orgUnitId } : {}) }, req.user.id, req.companyContext.dataSource.manager);
  }

  /** F-1: the assigned driver or a fleet reader; any other user gets "not found" (the vehicle is not revealed). */
  @Get('vehicles/:id/overview')
  async getVehicleOverview(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    await this.assertVehicleInScope(req, id); // org scope AND the F-1 access rule
    await this.vehicleAccess.assertCanReadVehicle(await this.shipments.getVehicle(id, manager), req.user.id, manager);
    return this.shipments.getCustodianOverview('vehicle', id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Post('vehicles/:id/driver')
  async setVehicleDriver(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetVehicleDriverDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.assertVehicleInScope(req, id);
    return this.shipments.setVehicleDriver(id, dto.driverUserId ?? null, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Post('vehicles/:id/status')
  async setVehicleStatus(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetVehicleStatusDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.assertVehicleInScope(req, id);
    return this.shipments.setVehicleStatus(id, dto.status, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Post('vehicles/:id/settlement-account')
  async setVehicleSettlementAccount(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetVehicleSettlementAccountDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.assertVehicleInScope(req, id);
    return this.shipments.setVehicleSettlementAccount(id, dto.treasuryAccountId ?? null, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Get('vehicles/:id/expense-float-candidates')
  async expenseFloatCandidates(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.assertVehicleInScope(req, id);
    const rows = await this.shipments.listExpenseFloatCandidates(id, req.companyContext.dataSource.manager);
    return (await this.orgContext.filterVisible(req, rows)).map((r) => ({ id: r.id, code: r.code, name: r.name }));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Post('vehicles/:id/expense-float')
  async setVehicleExpenseFloat(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetVehicleExpenseFloatDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.assertVehicleInScope(req, id);
    return this.shipments.setVehicleExpenseFloat(id, dto.treasuryAccountId ?? null, req.user.id, req.companyContext.dataSource.manager);
  }

  @Get()
  async list(@Req() req: CompanyScopedRequest, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    if (page === undefined && pageSize === undefined) {
      return this.shipments.listShipments(req.user.id, manager);
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.shipments.listShipmentsPage(req.user.id, { page: parsedPage, pageSize: parsedPageSize }, manager);
  }

  /** RSH Shipping Orders (CTO directive §3) — declared BEFORE the `:id` wildcard below so `by-sales-order` is never shadowed (same route-ordering discipline already established in this controller). */
  @Get('by-sales-order/:salesOrderId')
  async getBySalesOrderId(@Req() req: CompanyScopedRequest, @Param('salesOrderId') salesOrderId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.getShipmentBySalesOrderId(salesOrderId, req.user.id, req.companyContext.dataSource.manager);
  }

  /** Returns Engine Phase B — custody return search screen's backing read. Declared BEFORE the `:id` wildcard below, same discipline as `by-sales-order`. */
  @Get('custody-search')
  async searchCustodyShipments(
    @Req() req: CompanyScopedRequest,
    @Query('customerId') customerId?: string,
    @Query('customerCode') customerCode?: string,
    @Query('shipmentId') shipmentId?: string,
    @Query('waybillNumber') waybillNumber?: string,
    @Query('rshNumber') rshNumber?: string,
    @Query('shippingCompanyId') shippingCompanyId?: string,
    @Query('vehicleId') vehicleId?: string,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.searchCustodyShipments(
      { customerId, customerCode, shipmentId, waybillNumber, rshNumber, shippingCompanyId, vehicleId },
      req.user.id,
      req.companyContext.dataSource.manager,
    );
  }

  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.getShipment(id, req.user.id, req.companyContext.dataSource.manager);
  }

  /** Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16) — the shipment-centric detail screen (customer/address/phone/governorate/order total/carrier/line items) in one response. */
  @Get(':id/detail')
  async getDetail(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.getShipmentDetail(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @Post(':id/assign-driver')
  async assignDriver(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: AssignDriverDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const status = await this.shipments.assignDriver(id, dto.driverUserId, req.user.id, req.companyContext.dataSource.manager);
    return { shipmentId: id, status };
  }

  /** CTO directive ("Shipping Company waybill-required flow") — record the carrier's own waybill number/photo before `pickup` can be confirmed. */
  @Post(':id/carrier-waybill')
  async setCarrierWaybill(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetCarrierWaybillDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.setCarrierWaybill(
      id,
      dto.carrierWaybillNumber ?? null,
      dto.waybillImageMediaAssetId ?? null,
      req.user.id,
      dto.carrierContactPhone ?? null,
      req.companyContext.dataSource.manager,
    );
  }

  /** Shipping Screen Redesign directive §3 — assign/reassign a shipment's route to a shipping company or vehicle, fully audited; locked once pickup is confirmed. */
  @Post(':id/assign-route')
  async assignShippingRoute(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: AssignShippingRouteDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.assignShippingRoute(id, dto.shippingCompanyId ?? null, dto.vehicleId ?? null, req.user.id, dto.reason ?? null, req.companyContext.dataSource.manager);
  }

  @Post(':id/transition')
  async transition(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: TransitionDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const status = await this.shipments.transitionShipment(id, dto.action, req.user.id, req.companyContext.dataSource.manager);
    return { shipmentId: id, status };
  }

  @Get(':id/tracking')
  async tracking(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.shipments.getTrackingHistory(id, req.user.id, req.companyContext.dataSource.manager);
  }
}
