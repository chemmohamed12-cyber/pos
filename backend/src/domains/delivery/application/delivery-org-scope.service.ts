import { Injectable } from '@nestjs/common';
import { CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { OrgContextService } from '../../../foundation/scope/org-context.service';

/**
 * Integration of the vehicle workspace routes with the org-structure engine (CTO 2026-10-26: every route that accepts a shipment id must keep the branch scope). One place resolves the
 * branch (`org unit`) of whatever the route addresses - a shipment, a collection, an expense, a handover or a vehicle - and answers "not found" (404) when it lies outside the caller's
 * scope, exactly like the org engine's own vehicle rule. A record with no org link (legacy) is not a scope matter (visible to everyone, as the org engine defines it). It runs IN
 * FRONT of the existing ownership / driver-assignment / permission checks, which still apply in the services - both must pass.
 * A missing record answers nothing here (the service raises its own 404), so existence is never revealed by the scope check itself.
 */
@Injectable()
export class DeliveryOrgScopeService {
  constructor(private readonly orgContext: OrgContextService) {}

  private async branchOf(req: CompanyScopedRequest, sql: string, id: string): Promise<{ found: boolean; unit: string | null }> {
    const rows: Array<{ unit: string | null }> = await req.companyContext!.dataSource.manager.query(sql, [id]);
    return rows.length === 0 ? { found: false, unit: null } : { found: true, unit: rows[0].unit };
  }

  private async assertBy(req: CompanyScopedRequest, sql: string, id: string): Promise<void> {
    const b = await this.branchOf(req, sql, id);
    if (b.found) await this.orgContext.assertVisible(req, b.unit);
  }

  assertShipment(req: CompanyScopedRequest, shipmentId: string): Promise<void> {
    return this.assertBy(req, `SELECT "branchOrgUnitId" AS unit FROM "shipments" WHERE id::text = $1`, shipmentId);
  }

  assertCollection(req: CompanyScopedRequest, collectionId: string): Promise<void> {
    return this.assertBy(req, `SELECT s."branchOrgUnitId" AS unit FROM "collections" c JOIN "shipments" s ON s.id::text = c."shipmentId" WHERE c.id::text = $1`, collectionId);
  }

  assertExpense(req: CompanyScopedRequest, expenseId: string): Promise<void> {
    return this.assertBy(req, `SELECT s."branchOrgUnitId" AS unit FROM "custody_expenses" e JOIN "shipments" s ON s.id::text = e."shipmentId" WHERE e.id::text = $1`, expenseId);
  }

  assertHandover(req: CompanyScopedRequest, handoverId: string): Promise<void> {
    return this.assertBy(req, `SELECT v."orgUnitId" AS unit FROM "custody_handovers" h JOIN "vehicles" v ON v.id = h."vehicleId" WHERE h.id::text = $1`, handoverId);
  }

  assertVehicle(req: CompanyScopedRequest, vehicleId: string): Promise<void> {
    return this.assertBy(req, `SELECT "orgUnitId" AS unit FROM "vehicles" WHERE id::text = $1`, vehicleId);
  }
}
