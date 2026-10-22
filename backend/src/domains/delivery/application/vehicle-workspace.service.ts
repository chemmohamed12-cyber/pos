import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Collection } from '../infrastructure/collection.entity';
import { ShipmentLineDelivery } from '../infrastructure/shipment-line-delivery.entity';
import { computeDeliveryProgress } from './line-delivery-progress';
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
  /** Stage C / C1: recorded (driver) -> confirmed | rejected (someone else). */
  verificationStatus: 'recorded' | 'confirmed' | 'rejected';
  rejectionReason: string | null;
}

/** Server-computed totals of one shipment's collections (whole-cent arithmetic; a rejected collection counts for nothing). */
export interface WorkspaceCollectionTotals {
  expected: string | null;
  recorded: string;
  confirmed: string;
  rejected: string;
  /** recorded + confirmed - what still counts toward the expected total. */
  counted: string;
  remaining: string | null;
}

const cents = (a: string): number => Math.round(Number(a) * 100);
const money = (c: number): string => (c / 100).toFixed(2);

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
    const byShipment = new Map<string, Collection>();
    const allByShipment = new Map<string, Collection[]>();
    for (const c of [...collectionRows].sort((x, y) => x.occurredAt.getTime() - y.occurredAt.getTime())) {
      allByShipment.set(c.shipmentId, [...(allByShipment.get(c.shipmentId) ?? []), c]);
      if (c.verificationStatus !== 'rejected') byShipment.set(c.shipmentId, c); // the latest one that still counts
    }
    const view = (c: Collection): WorkspaceCollection => ({
      id: c.id,
      amount: c.amount,
      method: c.method,
      remittanceStatus: c.remittanceStatus,
      remittedAt: c.remittedAt,
      occurredAt: c.occurredAt,
      verificationStatus: c.verificationStatus,
      rejectionReason: c.rejectionReason,
    });
    const totalsOf = (list: Collection[], expected: string | null): WorkspaceCollectionTotals => {
      const sum = (st: string) => list.filter((c) => c.verificationStatus === st).reduce((t, c) => t + cents(c.amount), 0);
      const counted = sum('recorded') + sum('confirmed');
      const exp = expected !== null && Number(expected) > 0 ? cents(expected) : null;
      return { expected: exp === null ? null : money(exp), recorded: money(sum('recorded')), confirmed: money(sum('confirmed')), rejected: money(sum('rejected')), counted: money(counted), remaining: exp === null ? null : money(Math.max(0, exp - counted)) };
    };

    // Stage C / C2: per-line delivery progress, batched for every shipment returned (lines are a frozen snapshot of the shipment, events are append-only). "Partially delivered" is
    // DERIVED here from real events - never stored, never a shipment state.
    const shipmentIds = list.rows.map((s) => s.id);
    const lineRows: Array<{ id: string; shipmentId: string; productId: string; quantity: number }> = shipmentIds.length
      ? await (manager ?? this.dataSource).query(`SELECT "id","shipmentId","productId","quantity" FROM "shipment_lines" WHERE "shipmentId" = ANY($1::uuid[])`, [shipmentIds])
      : [];
    const eventRows: ShipmentLineDelivery[] = shipmentIds.length
      ? await (manager ?? this.dataSource).getRepository(ShipmentLineDelivery).createQueryBuilder('e').where('e."shipmentId" IN (:...ids)', { ids: shipmentIds }).getMany()
      : [];

    const rows = list.rows.map((s) => {
      const c = byShipment.get(s.id);
      const collection: WorkspaceCollection | null = c ? view(c) : null;
      const list = allByShipment.get(s.id) ?? [];
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
        // Stage C / C1: every instalment (rejected ones included, flagged) and the server-computed totals; `null` when this user may not see the collections of this shipment.
        collections: visible.has(s.id) ? list.map(view) : null,
        lineProgress: computeDeliveryProgress(
          lineRows.filter((l) => l.shipmentId === s.id),
          eventRows.filter((e) => e.shipmentId === s.id),
        ),
        collectionTotals: visible.has(s.id) ? totalsOf(list, s.codAmount) : null,
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
