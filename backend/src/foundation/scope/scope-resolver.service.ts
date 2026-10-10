import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ScopeService } from './scope.service';
import { OrganizationService } from '../organization/organization.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { SCOPE_DERIVATION_REGISTRY } from './scope-derivation.registry';
import { AccessScopeService } from './access-scope.service';


/**
 * ADR-031 — Scope Derivation Architecture (closes AUDIT-SEC-03).
 *
 * The ONE place derivation logic lives — every domain calls the same two
 * methods, none of them re-implements the rule. `ScopeService` itself is
 * unchanged (still the `direct`-strategy engine, still what `customer`/
 * `sales_order` use); this composes it with `OrganizationService`'s
 * existing org-unit tree rather than duplicating either.
 */
@Injectable()
export class ScopeResolver {
  constructor(
    private readonly scope: ScopeService,
    private readonly organization: OrganizationService,
    private readonly authorization: AuthorizationService,
    /** F6: the single definition of the caller's accessible org units (memberships + explicit grants, descendants, one statement). */
    private readonly accessScope: AccessScopeService,
  ) {}

  private async isUnrestricted(userId: string, manager?: EntityManager): Promise<boolean> {
    return (await this.authorization.workflowAccess(userId, manager)).allows('core.scope.unrestricted');
  }

  /**
   * @param derivationRef Meaning depends on the resource type's registered
   *   strategy — the caller already loaded the record to get here, so this
   *   is always a cheap pass-through, never an extra query this service
   *   makes:
   *   - `org_unit`: the resource's OWN owning unit.
   *   - `parent`: the resource's own parent-resource id (e.g. an invoice's
   *     `salesOrderId`) — resolved by recursing into the parent's own
   *     registry entry, not duplicated logic.
   *   `null`/`undefined` = no scoping info recorded for this resource =
   *   accessible to everyone, which is exactly today's behaviour on every
   *   installation that hasn't populated it (ADR-031 §3 — zero behaviour
   *   change by construction).
   */
  async assertAccess(userId: string, resourceType: string, resourceId: string, derivationRef?: string | null, manager?: EntityManager): Promise<void> {
    const entry = SCOPE_DERIVATION_REGISTRY[resourceType];
    if (!entry || entry.strategy === 'unscoped') return; // deliberate, reviewable declaration — not a missing check

    if (entry.strategy === 'direct') {
      return this.scope.assertAccess(userId, resourceType, resourceId, manager);
    }

    if (entry.strategy === 'parent') {
      if (!derivationRef) return; // no parent recorded (e.g. an ad hoc shipment with no sales order) — nothing to derive from, defer to accessible
      return this.assertAccess(userId, entry.parentType!, derivationRef, undefined, manager);
    }

    // 'org_unit'
    if (!derivationRef) return; // no branch assigned to this resource = root = everyone, today's behaviour unchanged
    this.accessScope.assertUnit(await this.accessScope.resolve(userId, manager), derivationRef); // 404, not 403 — anti-enumeration, ADR-005
  }

  /** List-query safety net — same role as `ScopeService.filterAllowed`, extended to org-unit derivation. */
  async filterAllowedByOrgUnit<T extends { id: string; orgUnitId?: string | null }>(userId: string, rows: T[], manager?: EntityManager): Promise<T[]> {
    const scope = await this.accessScope.resolve(userId, manager);
    return rows.filter((r) => this.accessScope.allowsUnit(scope, r.orgUnitId));
  }

  /**
   * List-query safety net for 'parent'-strategy resource types. `refIdOf`
   * returns each row's already-known reference id into `resourceType`
   * (a 'direct' or 'org_unit' entry) — the immediate FK for a one-hop
   * parent (e.g. an invoice's own `salesOrderId`), or a joined-in id for a
   * two-hop one (e.g. a collection's parent shipment's `salesOrderId`).
   * `null`/`undefined` = no scope info recorded = row kept (ADR-031 §3).
   */
  async filterAllowedByReference<T>(userId: string, rows: T[], resourceType: string, refIdOf: (row: T) => string | null | undefined, manager?: EntityManager): Promise<T[]> {
    if (await this.isUnrestricted(userId, manager)) return rows;
    const allowed = await this.scope.getAssignedResourceIds(userId, resourceType, manager);
    if (allowed === 'ALL') return rows;
    const allowedSet = new Set(allowed);
    return rows.filter((row) => {
      const ref = refIdOf(row);
      return !ref || allowedSet.has(ref);
    });
  }
}
