import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ShipmentLineDelivery } from '../infrastructure/shipment-line-delivery.entity';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { ShipmentDeliveryProgress, computeDeliveryProgress } from './line-delivery-progress';

export interface RecordLineDeliveryInput {
  shipmentId: string;
  shipmentLineId: string;
  kind: 'delivered' | 'returned';
  quantity: number;
  reason?: string | null;
  clientKey?: string | null;
}

/**
 * Vehicle Driver Workspace, Stage C / C2 (D-1) - per-line partial-delivery events. The driver (or an admin) records, per shipment line, units handed over or brought back while the
 * shipment is out for delivery. Append-only, serialised per shipment, never above what the line shipped. It adds no shipment state and posts nothing: the final `delivered` outcome
 * (which still fulfils the order) is only allowed once every line is accounted for, and the units that came back go through the existing Returns flow.
 */
@Injectable()
export class LineDeliveryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly shipments: ShipmentService,
    private readonly audit: AuditService,
  ) {}

  async record(input: RecordLineDeliveryInput, actorUserId: string, manager?: EntityManager): Promise<ShipmentLineDelivery> {
    await this.shipments.assertDriverOrAdmin(input.shipmentId, actorUserId, manager);
    if (input.kind !== 'delivered' && input.kind !== 'returned') throw new BadRequestException('kind must be "delivered" or "returned".');
    if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new BadRequestException('quantity must be a whole number of at least 1.');
    const reason = input.reason?.trim() || null;
    if (input.kind === 'returned' && (!reason || reason.length < 3 || reason.length > 255)) throw new BadRequestException('A reason of 3-255 characters is required for returned units.');
    if (reason && reason.length > 255) throw new BadRequestException('The reason is too long.');
    const clientKey = input.clientKey ?? null;
    if (clientKey !== null && !/^[A-Za-z0-9_.:-]{8,64}$/.test(clientKey)) throw new BadRequestException('clientKey must be 8-64 characters (letters, digits, _ . : -).');

    let replayed = false;
    const saved = await (manager ?? this.dataSource).transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delivery:lines:${input.shipmentId}`]);
      const repo = tx.getRepository(ShipmentLineDelivery);
      if (clientKey) {
        const prior = await repo.findOne({ where: { clientKey } });
        if (prior) {
          if (prior.shipmentId !== input.shipmentId || prior.shipmentLineId !== input.shipmentLineId || prior.kind !== input.kind || prior.quantity !== input.quantity) {
            throw new ConflictException('This clientKey was already used for a different line event.');
          }
          replayed = true;
          return prior;
        }
      }
      const state: Array<{ s: string }> = await tx.query(
        `SELECT "currentState" AS s FROM "process_instances" WHERE "definitionKey" = 'shipment_lifecycle' AND "entityType" = 'shipment' AND "entityId"::text = $1 LIMIT 1`,
        [input.shipmentId],
      );
      if (state[0]?.s !== 'out_for_delivery') {
        throw new ConflictException(`Line deliveries are recorded while the shipment is out for delivery (it is "${state[0]?.s ?? 'unknown'}"). Nothing was recorded.`);
      }
      const snap = await this.shipments.getShipmentLinesSnapshot(input.shipmentId, tx);
      if (!snap) throw new NotFoundException(`Shipment "${input.shipmentId}" not found.`);
      const line = snap.lines.find((l) => l.id === input.shipmentLineId);
      if (!line) throw new NotFoundException(`Line "${input.shipmentLineId}" does not belong to this shipment.`);
      const events = await repo.find({ where: { shipmentId: input.shipmentId } });
      const row = computeDeliveryProgress(snap.lines, events).lines.find((l) => l.shipmentLineId === line.id)!;
      if (input.quantity > row.outstanding) {
        throw new ConflictException(`Only ${row.outstanding} unit(s) of this line are still outstanding (shipped ${row.shipped}, delivered ${row.delivered}, returned ${row.returned}). Nothing was recorded.`);
      }
      return repo.save(
        repo.create({ shipmentId: input.shipmentId, shipmentLineId: input.shipmentLineId, kind: input.kind, quantity: input.quantity, reason, recordedByUserId: actorUserId, clientKey }),
      );
    });
    if (replayed) return saved;
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: `delivery.line.${input.kind}`,
        resource: 'shipment_line_delivery',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { shipmentId: input.shipmentId, shipmentLineId: input.shipmentLineId, quantity: input.quantity, reason },
      },
      manager,
    );
    return saved;
  }

  /** Per-line progress plus the raw event history of one shipment (driver-or-admin scoped). */
  async getProgress(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<ShipmentDeliveryProgress & { events: ShipmentLineDelivery[] }> {
    await this.shipments.assertDriverOrAdmin(shipmentId, actorUserId, manager);
    const snap = await this.shipments.getShipmentLinesSnapshot(shipmentId, manager);
    if (!snap) throw new NotFoundException(`Shipment "${shipmentId}" not found.`);
    const events = await (manager ?? this.dataSource).getRepository(ShipmentLineDelivery).find({ where: { shipmentId }, order: { recordedAt: 'ASC', id: 'ASC' } });
    return { ...computeDeliveryProgress(snap.lines, events), events };
  }
}
