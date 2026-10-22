import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Collection } from '../infrastructure/collection.entity';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { VehicleAccessService } from '../../shipment/application/vehicle-access.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { PermissionService } from '../../../foundation/permission/permission.service';

export interface WorkspaceCollection {
  id: string;
  amount: string;
  method: string;
  remittanceStatus: 'pending' | 'remitted';
  remittedAt: Date | null;
  occurredAt: Date;
}

/**
 * Vehicle Driver Workspace, Stage C / F-3, F-4, F-5 (2026-10-22) — ONE permission-checked, read-only read model for the workspace screen, replacing what the browser used to assemble
 * from many calls:
 *  - F-3: the driver's display NAME is resolved here (name only), so no user-list permission is needed;
 *  - F-4: the vehicle's shipments are filtered on the server (and scoped like the board: everyone who may see all shipments sees all of this vehicle's, a driver only his own);
 *  - F-5: the collection records come from ONE batched query instead of one request per shipment, are COMPLETE for the shipments returned, and are shown per shipment only to
 *    people who may see that collection (the shipment's own driver, `act_any`, or the `logistics.collection.view` permission) — `collectionVisible: false` marks a hidden one
 *    (never an empty/zero), and `collectionsComplete` is false when any is hidden.
 * Access to the vehicle itself is the F-1 rule (assigned driver or fleet reader, otherwise "not found"). No write, no new permission, no new entity.
 */
@Injectable()
export class VehicleWorkspaceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly shipments: ShipmentService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly authorization: AuthorizationService,
    private readonly permissions: PermissionService,
  ) {}

  async getWorkspace(vehicleId: string, actorUserId: string, opts: { limit?: number } = {}, manager?: EntityManager) {
    const vehicle = await this.shipments.getVehicle(vehicleId, manager);
    await this.vehicleAccess.assertCanReadVehicle(vehicle, actorUserId, manager);

    const [overview, driverName, list] = await Promise.all([
      this.shipments.getCustodianOverview('vehicle', vehicleId, manager),
      vehicle.driverUserId ? this.shipments.getUserDisplayName(vehicle.driverUserId) : Promise.resolve(null),
      this.shipments.listShipmentsForVehicle(vehicleId, actorUserId, opts, manager),
    ]);

    const access = await this.authorization.workflowAccess(actorUserId, manager);
    const seesAllCollections = access.allows('logistics.shipment.act_any') || (await this.permissions.hasAtLeast(actorUserId, 'logistics.collection.view', 'read-only', manager));
    const visible = new Set(list.rows.filter((s) => seesAllCollections || s.driverUserId === actorUserId).map((s) => s.id));

    const ids = [...visible];
    const collectionRows: Collection[] = ids.length
      ? await (manager ?? this.dataSource).getRepository(Collection).createQueryBuilder('c').where('c."shipmentId" IN (:...ids)', { ids }).getMany()
      : [];
    const byShipment = new Map(collectionRows.map((c) => [c.shipmentId, c]));

    const rows = list.rows.map((s) => {
      const c = byShipment.get(s.id);
      const collection: WorkspaceCollection | null = c
        ? { id: c.id, amount: c.amount, method: c.method, remittanceStatus: c.remittanceStatus, remittedAt: c.remittedAt, occurredAt: c.occurredAt }
        : null;
      return {
        id: s.id,
        waybillNumber: s.waybillNumber,
        rshNumber: s.rshNumber,
        salesOrderNumber: s.salesOrderNumber,
        state: s.state,
        customerName: s.customerName,
        governorate: s.governorate,
        totalAmount: s.totalAmount,
        codAmount: s.codAmount,
        driverUserId: s.driverUserId,
        vehicleId: s.vehicleId,
        createdAt: s.createdAt,
        collectionVisible: visible.has(s.id),
        collection: visible.has(s.id) ? collection : null,
      };
    });

    return {
      vehicle: {
        id: vehicle.id,
        code: vehicle.code,
        plateNumber: vehicle.plateNumber,
        driverUserId: vehicle.driverUserId,
        driverName,
        branch: vehicle.branch,
        status: vehicle.status,
        custodyAccountId: vehicle.custodyAccountId,
        warehouseId: vehicle.warehouseId,
      },
      overview: { custodyBalance: overview.custodyBalance, activeShipmentsCount: overview.activeShipmentsCount, stock: overview.stock },
      shipments: rows,
      truncated: list.truncated,
      collectionsComplete: rows.every((r) => r.collectionVisible),
    };
  }
}
