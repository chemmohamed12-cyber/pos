import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from './scope.service';
import { OrganizationService } from '../organization/organization.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { SCOPE_DERIVATION_REGISTRY } from './scope-derivation.registry';

const UNRESTRICTED_ROLES = ['admin'];

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
  ) {}

  private async isUnrestricted(userId: string): Promise<boolean> {
    const roles = await this.authorization.getRoleKeysForUser(userId);
    return roles.some((r) => UNRESTRICTED_ROLES.includes(r));
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
  async assertAccess(userId: string, resourceType: string, resourceId: string, derivationRef?: string | null): Promise<void> {
    const entry = SCOPE_DERIVATION_REGISTRY[resourceType];
    if (!entry || entry.strategy === 'unscoped') return; // deliberate, reviewable declaration — not a missing check

    if (entry.strategy === 'direct') {
      return this.scope.assertAccess(userId, resourceType, resourceId);
    }

    if (entry.strategy === 'parent') {
      if (!derivationRef) return; // no parent recorded (e.g. an ad hoc shipment with no sales order) — nothing to derive from, defer to accessible
      return this.assertAccess(userId, entry.parentType!, derivationRef);
    }

    // 'org_unit'
    if (await this.isUnrestricted(userId)) return;
    if (!derivationRef) return; // no branch assigned to this resource = root = everyone, today's behaviour unchanged
    const accessible = await this.accessibleOrgUnitIds(userId);
    if (!accessible.has(derivationRef)) throw new NotFoundException(); // 404, not 403 — anti-enumeration, ADR-005
  }

  /** List-query safety net — same role as `ScopeService.filterAllowed`, extended to org-unit derivation. */
  async filterAllowedByOrgUnit<T extends { id: string; orgUnitId?: string | null }>(userId: string, rows: T[]): Promise<T[]> {
    if (await this.isUnrestricted(userId)) return rows;
    const accessible = await this.accessibleOrgUnitIds(userId);
    return rows.filter((r) => !r.orgUnitId || accessible.has(r.orgUnitId));
  }

  /**
   * List-query safety net for 'parent'-strategy resource types. `refIdOf`
   * returns each row's already-known reference id into `resourceType`
   * (a 'direct' or 'org_unit' entry) — the immediate FK for a one-hop
   * parent (e.g. an invoice's own `salesOrderId`), or a joined-in id for a
   * two-hop one (e.g. a collection's parent shipment's `salesOrderId`).
   * `null`/`undefined` = no scope info recorded = row kept (ADR-031 §3).
   */
  async filterAllowedByReference<T>(userId: string, rows: T[], resourceType: string, refIdOf: (row: T) => string | null | undefined): Promise<T[]> {
    if (await this.isUnrestricted(userId)) return rows;
    const allowed = await this.scope.getAssignedResourceIds(userId, resourceType);
    if (allowed === 'ALL') return rows;
    const allowedSet = new Set(allowed);
    return rows.filter((row) => {
      const ref = refIdOf(row);
      return !ref || allowedSet.has(ref);
    });
  }

  private async accessibleOrgUnitIds(userId: string): Promise<Set<string>> {
    const myUnits = await this.organization.getUnitIdsForUser(userId);
    const accessible = new Set<string>(myUnits);
    for (const unit of myUnits) {
      for (const d of await this.organization.getDescendantIds(unit)) accessible.add(d);
    }
    return accessible;
  }
}
