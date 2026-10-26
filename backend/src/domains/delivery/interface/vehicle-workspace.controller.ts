import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { VehicleWorkspaceService } from '../application/vehicle-workspace.service';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { OrgContextService } from '../../../foundation/scope/org-context.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';

/** Vehicle Driver Workspace read model (Stage C / F-3..F-5): read-only; the vehicle access rule (F-1) and the per-collection visibility rule are enforced in the service. */
@Controller('vehicle-workspace')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('logistics')
export class VehicleWorkspaceController {
  constructor(
    private readonly workspace: VehicleWorkspaceService,
    private readonly shipments: ShipmentService,
    private readonly orgContext: OrgContextService,
  ) {}

  @Get(':vehicleId')
  async get(@Req() req: CompanyScopedRequest, @Param('vehicleId', ParseUUIDPipe) vehicleId: string, @Query('limit') limit?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    // org-engine rule (kept): a vehicle of a branch outside the caller's scope answers 404; the F-1 rule is applied inside the service - both must pass
    await this.orgContext.assertVisible(req, (await this.shipments.getVehicle(vehicleId, req.companyContext.dataSource.manager)).orgUnitId);
    const parsed = limit === undefined ? undefined : Math.max(1, Math.min(500, Number(limit) || 300));
    return this.workspace.getWorkspace(vehicleId, req.user.id, { limit: parsed }, req.companyContext.dataSource.manager);
  }
}
