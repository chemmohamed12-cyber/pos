import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Vehicle } from '../infrastructure/vehicle.entity';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { PermissionService } from '../../../foundation/permission/permission.service';

/**
 * Vehicle Driver Workspace, Stage C / F-1 (2026-10-22) — server-side access rule for the vehicle READ endpoints (`GET /shipments/vehicles`, `GET /shipments/vehicles/:id/overview`,
 * `GET /shipments/shipping-companies/:id/overview`). Before this, any authenticated user of the Company could read every vehicle's stock and custody balance by URL or API call.
 *
 * Who may read the whole fleet ("fleet reader") — the union of what the product already grants to the people who legitimately work with vehicles and custody, so no existing role
 * loses access: the workflow capabilities of the shipping board / custody / dispatch (`board_all`, `read_any`, `custody_query`, `act_any`, `assign_driver`, `set_route`,
 * `manage_non_driver_actions`) or a module permission on vehicles, shipments or collections (`logistics.vehicle.view|edit|create`, `logistics.shipment`, `logistics.collection`;
 * the `logistics` module-wide grants of admin / manager / viewer resolve through these by ancestry).
 * Everyone else — in particular a driver — sees ONLY the vehicles they are the assigned driver of. A vehicle one may not read is answered "not found" (never "forbidden"), like
 * every other denied route of the Permission Engine, so the screen does not reveal that it exists.
 * Read access only: it grants nothing to write, and the shipment-level checks (`assertDriverOrAdmin`, `assertCanReadShipment`) are untouched.
 */
const FLEET_WORKFLOW_RULES = [
  'logistics.shipment.board_all',
  'logistics.shipment.read_any',
  'logistics.shipment.custody_query',
  'logistics.shipment.act_any',
  'logistics.shipment.assign_driver',
  'logistics.shipment.set_route',
  'logistics.shipment.manage_non_driver_actions',
] as const;
const FLEET_PERMISSION_NODES = ['logistics.vehicle.view', 'logistics.vehicle.edit', 'logistics.vehicle.create', 'logistics.shipment', 'logistics.collection'] as const;

@Injectable()
export class VehicleAccessService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly permissions: PermissionService,
  ) {}

  async canReadFleet(actorUserId: string, manager?: EntityManager): Promise<boolean> {
    const access = await this.authorization.workflowAccess(actorUserId, manager);
    if (FLEET_WORKFLOW_RULES.some((rule) => access.allows(rule))) return true;
    for (const node of FLEET_PERMISSION_NODES) {
      if (await this.permissions.hasAtLeast(actorUserId, node, 'read-only', manager)) return true;
    }
    return false;
  }

  /** The vehicles this user may see: all of them for a fleet reader, otherwise only the vehicles they are the assigned driver of. */
  async visibleVehicles(vehicles: Vehicle[], actorUserId: string, manager?: EntityManager): Promise<Vehicle[]> {
    if (await this.canReadFleet(actorUserId, manager)) return vehicles;
    return vehicles.filter((v) => v.driverUserId === actorUserId);
  }

  /** One vehicle's overview (stock + custody balance): the assigned driver or a fleet reader; anyone else gets "not found". */
  async assertCanReadVehicle(vehicle: Vehicle, actorUserId: string, manager?: EntityManager): Promise<void> {
    if (vehicle.driverUserId === actorUserId) return;
    if (await this.canReadFleet(actorUserId, manager)) return;
    throw new NotFoundException(`Vehicle "${vehicle.id}" not found.`);
  }

  /** A shipping company's overview (its custody balance and stock) has no "assigned driver": fleet readers only. */
  async assertCanReadFleet(actorUserId: string, what: string, manager?: EntityManager): Promise<void> {
    if (await this.canReadFleet(actorUserId, manager)) return;
    throw new NotFoundException(`${what} not found.`);
  }
}
