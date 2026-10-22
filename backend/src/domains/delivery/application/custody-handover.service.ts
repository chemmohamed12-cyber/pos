import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CustodyHandover } from '../infrastructure/custody-handover.entity';
import { Collection } from '../infrastructure/collection.entity';
import { CustodyExpense } from '../infrastructure/custody-expense.entity';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { VehicleAccessService } from '../../shipment/application/vehicle-access.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { CustodyReconciliation, computeCustodyReconciliation } from './custody-reconciliation';

/** Postgres advisory-lock key serialising everything that changes the cash a vehicle's driver is carrying (handover declarations and expense postings). */
export const vehicleCashLockKey = (vehicleId: string): string => `delivery:vehicle-cash:${vehicleId}`;

const cents = (a: string): number => Math.round(Number(a) * 100);

/**
 * Vehicle Driver Workspace, Stage C / C4 - the driver's cash handover to the cashier and the server-side custody reconciliation of a vehicle.
 *  - DECLARE (the vehicle's driver, or an admin): an amount that may not exceed the cash the driver is still expected to carry (counted collections - posted expenses - handovers
 *    already declared/confirmed), serialised per vehicle, idempotent by `clientKey`.
 *  - CONFIRM / REJECT (someone other than the declarer, with `logistics.collection.post`): operational only - it moves no money and posts nothing. The settlement of each collection
 *    (custody account -> settlement account, receivable credit, GL) stays with the existing remittance; handed-over and remitted are shown as separate lines.
 *  - RECONCILIATION: computed here from verified rows only, readable by whoever may read the vehicle (F-1 rule).
 */
@Injectable()
export class CustodyHandoverService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly shipments: ShipmentService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
  ) {}

  /** Every collection of the vehicle's shipments (legacy rows without a custody record included), every expense and handover of the vehicle - the inputs of the reconciliation. */
  async loadFacts(vehicleId: string, manager: EntityManager) {
    const ids: Array<{ id: string }> = await manager.query(`SELECT id::text AS id FROM "shipments" WHERE "vehicleId" = $1`, [vehicleId]);
    const shipmentIds = ids.map((r) => r.id);
    const collections = shipmentIds.length ? await manager.getRepository(Collection).createQueryBuilder('c').where('c."shipmentId" IN (:...ids)', { ids: shipmentIds }).getMany() : [];
    const expenses = await manager.getRepository(CustodyExpense).find({ where: { vehicleId } });
    const handovers = await manager.getRepository(CustodyHandover).find({ where: { vehicleId }, order: { createdAt: 'ASC', id: 'ASC' } });
    return { collections, expenses, handovers };
  }

  async getReconciliation(vehicleId: string, actorUserId: string, manager?: EntityManager): Promise<{ vehicleId: string; reconciliation: CustodyReconciliation; handovers: CustodyHandover[] }> {
    const m = manager ?? this.dataSource.manager;
    const vehicle = await this.shipments.getVehicle(vehicleId, m);
    await this.vehicleAccess.assertCanReadVehicle(vehicle, actorUserId, m);
    const facts = await this.loadFacts(vehicleId, m);
    const overview = await this.shipments.getCustodianOverview('vehicle', vehicleId, m);
    return {
      vehicleId,
      reconciliation: computeCustodyReconciliation({ collections: facts.collections, expenses: facts.expenses, handovers: facts.handovers, custodyBalance: overview.custodyBalance }),
      handovers: facts.handovers,
    };
  }

  async declare(vehicleId: string, amount: string, note: string | null, clientKey: string | null, actorUserId: string, manager?: EntityManager): Promise<CustodyHandover> {
    const m = manager ?? this.dataSource.manager;
    const vehicle = await this.shipments.getVehicle(vehicleId, m);
    const access = await this.authorization.workflowAccess(actorUserId, m);
    if (vehicle.driverUserId !== actorUserId && !access.allows('logistics.shipment.act_any')) {
      throw new ForbiddenException('Only the driver of this vehicle (or an admin) may declare a handover.');
    }
    if (typeof amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new BadRequestException('The amount must be a positive number with at most two decimals.');
    const text = note?.trim() || null;
    if (text && text.length > 255) throw new BadRequestException('The note is too long.');
    if (clientKey !== null && !/^[A-Za-z0-9_.:-]{8,64}$/.test(clientKey)) throw new BadRequestException('clientKey must be 8-64 characters (letters, digits, _ . : -).');

    let replayed = false;
    const saved = await m.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [vehicleCashLockKey(vehicleId)]);
      const repo = tx.getRepository(CustodyHandover);
      if (clientKey) {
        const prior = await repo.findOne({ where: { clientKey } });
        if (prior) {
          if (prior.vehicleId !== vehicleId || prior.driverUserId !== actorUserId || Number(prior.amount) !== Number(amount)) throw new ConflictException('This clientKey was already used for a different handover.');
          replayed = true;
          return prior;
        }
      }
      const facts = await this.loadFacts(vehicleId, tx);
      const recon = computeCustodyReconciliation({ collections: facts.collections, expenses: facts.expenses, handovers: facts.handovers, custodyBalance: null });
      if (cents(amount) > cents(recon.derived.cashInDriverHand)) {
        throw new ConflictException(
          `The handover ${amount} exceeds the cash this vehicle is expected to be carrying (${recon.derived.cashInDriverHand}: ${recon.derived.cashInDriverHandFormula}). Nothing was recorded.`,
        );
      }
      await this.numbering.registerDocumentType('custody_handover', 'CHO', true, tx);
      const handoverNumber = await this.numbering.getNextNumber('custody_handover', tx);
      return repo.save(repo.create({ handoverNumber, vehicleId, driverUserId: actorUserId, amount, note: text, status: 'declared', clientKey }));
    });
    if (replayed) return saved;
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'delivery.custody_handover.declared', resource: 'custody_handover', resourceId: saved.id, result: 'success', correlationId: null, after: { handoverNumber: saved.handoverNumber, vehicleId, amount } },
      manager,
    );
    return saved;
  }

  async decide(id: string, decision: 'confirmed' | 'rejected', reason: string | null, actorUserId: string, manager?: EntityManager): Promise<CustodyHandover> {
    const m = manager ?? this.dataSource.manager;
    const why = reason?.trim() || null;
    if (decision === 'rejected' && (!why || why.length < 3 || why.length > 255)) throw new BadRequestException('A rejection reason of 3-255 characters is required.');
    const found = await m.getRepository(CustodyHandover).findOne({ where: { id } });
    if (!found) throw new NotFoundException(`Handover "${id}" not found.`);
    const saved = await m.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [vehicleCashLockKey(found.vehicleId)]);
      const repo = tx.getRepository(CustodyHandover);
      const row = await repo.findOne({ where: { id } });
      if (!row) throw new NotFoundException(`Handover "${id}" not found.`);
      if (row.status === decision) return null; // idempotent
      if (row.status !== 'declared') throw new ConflictException(`This handover is already ${row.status}.`);
      if (row.driverUserId === actorUserId) throw new ForbiddenException('A handover must be confirmed or rejected by someone other than the person who declared it.');
      row.status = decision;
      row.confirmedByUserId = actorUserId;
      row.decidedAt = new Date();
      row.rejectionReason = decision === 'rejected' ? why : null;
      return repo.save(row);
    });
    if (!saved) return (await m.getRepository(CustodyHandover).findOne({ where: { id } }))!;
    await this.audit.record(
      { actorUserId, organizationId: null, action: `delivery.custody_handover.${decision}`, resource: 'custody_handover', resourceId: id, result: 'success', correlationId: null, after: { amount: saved.amount, reason: why } },
      manager,
    );
    return saved;
  }
}
