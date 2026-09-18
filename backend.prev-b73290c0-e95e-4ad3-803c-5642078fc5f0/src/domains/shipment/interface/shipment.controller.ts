import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsNumberString, IsOptional, IsString } from 'class-validator';
import { ShipmentService } from '../application/shipment.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

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

class UpdateVehicleDto {
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

@Controller('shipments')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('logistics')
export class ShipmentController {
  constructor(private readonly shipments: ShipmentService) {}

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateShipmentDto) {
    return this.shipments.createShipment(
      dto.fulfillmentOrderId,
      req.user.id,
      dto.shippingCompanyId ?? null,
      dto.codAmount ?? null,
      dto.vehicleId ?? null,
    );
  }

  // ---- Shipping Companies (CTO directive — multi-carrier support) ----
  // Reads broadly available (a warehouse worker creating a shipment needs
  // to see the company list), writes gated to admin — same "Catalog
  // writes admin-gated; reads broadly available" boundary Commerce uses.

  @Get('shipping-companies')
  async listShippingCompanies() {
    return this.shipments.listShippingCompanies();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.carrier.create', 'editable')
  @Post('shipping-companies')
  async createShippingCompany(@Req() req: AuthenticatedRequest, @Body() dto: CreateShippingCompanyDto) {
    return this.shipments.createShippingCompany(
      dto.code,
      dto.name,
      dto.contactPhone ?? null,
      dto.address ?? null,
      dto.responsiblePerson ?? null,
      req.user.id,
      dto.parentWarehouseId ?? null,
    );
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.carrier.edit', 'editable')
  @Post('shipping-companies/:id')
  async updateShippingCompany(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateShippingCompanyDto) {
    return this.shipments.updateShippingCompany(id, dto, req.user.id);
  }

  @Get('shipping-companies/:id/overview')
  async getShippingCompanyOverview(@Param('id') id: string) {
    return this.shipments.getCustodianOverview('company', id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.carrier.edit', 'editable')
  @Post('shipping-companies/:id/treasury-account')
  async setShippingCompanyTreasuryAccount(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SetShippingCompanyTreasuryAccountDto,
  ) {
    return this.shipments.setShippingCompanyTreasuryAccount(id, dto.treasuryAccountId ?? null, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.carrier.edit', 'editable')
  @Post('shipping-companies/:id/status')
  async setShippingCompanyStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetShippingCompanyStatusDto) {
    return this.shipments.setShippingCompanyStatus(id, dto.status, req.user.id);
  }

  // ---- Company Vehicles (CTO directive §2) ----

  @Get('vehicles')
  async listVehicles() {
    return this.shipments.listVehicles();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.create', 'editable')
  @Post('vehicles')
  async createVehicle(@Req() req: AuthenticatedRequest, @Body() dto: CreateVehicleDto) {
    return this.shipments.createVehicle(
      dto.code,
      dto.plateNumber,
      dto.driverUserId ?? null,
      dto.shippingCompanyId ?? null,
      dto.branch ?? null,
      req.user.id,
      dto.parentWarehouseId ?? null,
    );
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Post('vehicles/:id')
  async updateVehicle(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateVehicleDto) {
    return this.shipments.updateVehicle(id, dto, req.user.id);
  }

  @Get('vehicles/:id/overview')
  async getVehicleOverview(@Param('id') id: string) {
    return this.shipments.getCustodianOverview('vehicle', id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Post('vehicles/:id/driver')
  async setVehicleDriver(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetVehicleDriverDto) {
    return this.shipments.setVehicleDriver(id, dto.driverUserId ?? null, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Post('vehicles/:id/status')
  async setVehicleStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetVehicleStatusDto) {
    return this.shipments.setVehicleStatus(id, dto.status, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.vehicle.edit', 'editable')
  @Post('vehicles/:id/settlement-account')
  async setVehicleSettlementAccount(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetVehicleSettlementAccountDto) {
    return this.shipments.setVehicleSettlementAccount(id, dto.treasuryAccountId ?? null, req.user.id);
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    if (page === undefined && pageSize === undefined) {
      return this.shipments.listShipments(req.user.id);
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.shipments.listShipmentsPage(req.user.id, { page: parsedPage, pageSize: parsedPageSize });
  }

  /** RSH Shipping Orders (CTO directive §3) — declared BEFORE the `:id` wildcard below so `by-sales-order` is never shadowed (same route-ordering discipline already established in this controller). */
  @Get('by-sales-order/:salesOrderId')
  async getBySalesOrderId(@Req() req: AuthenticatedRequest, @Param('salesOrderId') salesOrderId: string) {
    return this.shipments.getShipmentBySalesOrderId(salesOrderId, req.user.id);
  }

  /** Returns Engine Phase B — custody return search screen's backing read. Declared BEFORE the `:id` wildcard below, same discipline as `by-sales-order`. */
  @Get('custody-search')
  async searchCustodyShipments(
    @Req() req: AuthenticatedRequest,
    @Query('customerId') customerId?: string,
    @Query('customerCode') customerCode?: string,
    @Query('shipmentId') shipmentId?: string,
    @Query('waybillNumber') waybillNumber?: string,
    @Query('rshNumber') rshNumber?: string,
    @Query('shippingCompanyId') shippingCompanyId?: string,
    @Query('vehicleId') vehicleId?: string,
  ) {
    return this.shipments.searchCustodyShipments(
      { customerId, customerCode, shipmentId, waybillNumber, rshNumber, shippingCompanyId, vehicleId },
      req.user.id,
    );
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.shipments.getShipment(id, req.user.id);
  }

  @Post(':id/assign-driver')
  async assignDriver(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: AssignDriverDto) {
    const status = await this.shipments.assignDriver(id, dto.driverUserId, req.user.id);
    return { shipmentId: id, status };
  }

  /** CTO directive ("Shipping Company waybill-required flow") — record the carrier's own waybill number/photo before `pickup` can be confirmed. */
  @Post(':id/carrier-waybill')
  async setCarrierWaybill(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetCarrierWaybillDto) {
    return this.shipments.setCarrierWaybill(
      id,
      dto.carrierWaybillNumber ?? null,
      dto.waybillImageMediaAssetId ?? null,
      req.user.id,
      dto.carrierContactPhone ?? null,
    );
  }

  /** Shipping Screen Redesign directive §3 — assign/reassign a shipment's route to a shipping company or vehicle, fully audited; locked once pickup is confirmed. */
  @Post(':id/assign-route')
  async assignShippingRoute(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: AssignShippingRouteDto) {
    return this.shipments.assignShippingRoute(id, dto.shippingCompanyId ?? null, dto.vehicleId ?? null, req.user.id, dto.reason ?? null);
  }

  @Post(':id/transition')
  async transition(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: TransitionDto) {
    const status = await this.shipments.transitionShipment(id, dto.action, req.user.id);
    return { shipmentId: id, status };
  }

  @Get(':id/tracking')
  async tracking(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.shipments.getTrackingHistory(id, req.user.id);
  }
}
