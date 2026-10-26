import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CompanyScopedRequest } from '../company/company-context.guard';
import { AccessScopeService } from './access-scope.service';

export interface ResolveBranchOptions {
  /** A branch the client asked for (a PROPOSAL — validated here, never trusted). */
  requested?: string | null;
  /** The business process needs an organizational reference. Enforced only when the Company has active branches (CTO D-4). */
  required?: boolean;
  /** A Company WITHOUT active branches keeps the pre-engine behaviour: any existing active unit may still be named (legacy flat trees). Ignored once branches exist. */
  legacyUnitWhenBranchless?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Org engine Stage 3 — the ONE server-side place that turns "which branch is this record for?" into a validated org-unit id (CTO D-6). It reuses the existing
 * scope infrastructure (`AccessScopeService`: memberships + explicit grants, descendants, the Company administrator's unrestricted reach) — no parallel authorization.
 *
 * Rules, in order:
 *   1. a requested branch must exist in THIS Company's database (a foreign id is simply unknown: 404), be an ACTIVE unit of type `branch`, and be inside the
 *      caller's scope (404 outside it — anti-enumeration, ADR-005). An unrestricted caller is not exempt from the existence / type / active checks.
 *   2. nothing requested + the Company has NO active branches -> `null` (branchless Companies behave exactly as before; legacy `NULL` semantics unchanged).
 *   3. nothing requested + branches exist + `required`: a caller who can reach exactly ONE branch gets it (documented single-branch rule); otherwise the request is
 *      refused with a clear message — an unrestricted administrator must still choose, there is never a silent default branch.
 *   4. nothing requested, not required -> `null`.
 */
@Injectable()
export class OrgContextService {
  constructor(private readonly scopes: AccessScopeService) {}

  async resolveBranch(req: CompanyScopedRequest, opts: ResolveBranchOptions = {}): Promise<string | null> {
    if (!req.user || !req.companyContext) throw new NotFoundException();
    const manager = req.companyContext.dataSource.manager;
    const scope = await this.scopes.forRequest(req);
    const requested = opts.requested ? String(opts.requested) : null;

    if (requested) {
      if (!UUID.test(requested)) throw new BadRequestException('The selected branch is not valid. / الفرع المحدد غير صالح.');
      const unit = (await manager.query(`SELECT "id","type","status" FROM "org_units" WHERE "id" = $1`, [requested]))[0] as { id: string; type: string; status: string } | undefined;
      if (!unit) throw new NotFoundException();
      this.scopes.assertUnit(scope, unit.id);
      if (unit.type !== 'branch') {
        const anyBranch = opts.legacyUnitWhenBranchless ? (await manager.query(`SELECT 1 FROM "org_units" WHERE "type" = 'branch' AND "status" = 'active' LIMIT 1`)).length > 0 : true;
        if (anyBranch) throw new BadRequestException('The selected unit is not a branch. / الوحدة المحددة ليست فرعاً.');
      }
      if (unit.status !== 'active') throw new BadRequestException('The selected branch is archived. / الفرع المحدد مؤرشف.');
      return unit.id;
    }

    const branches = (await manager.query(`SELECT "id" FROM "org_units" WHERE "type" = 'branch' AND "status" = 'active' ORDER BY "createdAt"`)) as Array<{ id: string }>;
    if (branches.length === 0 || !opts.required) return null;
    const reachable = branches.filter((b) => scope.unrestricted || scope.unitIds.has(b.id));
    if (reachable.length === 1) return reachable[0].id;
    throw new BadRequestException(
      reachable.length === 0
        ? 'No branch is available to you — ask an administrator to assign you to a branch. / لا يوجد فرع متاح لك — اطلب من المسؤول ربطك بفرع.'
        : 'Select the branch. / يجب اختيار الفرع.',
    );
  }

  /** Rows the caller may see: a record with no org link is visible to everyone (legacy NULL semantics, D-5); otherwise its unit must be inside the caller's scope. */
  async filterVisible<T extends { orgUnitId?: string | null }>(req: CompanyScopedRequest, rows: T[]): Promise<T[]> {
    const scope = await this.scopes.forRequest(req);
    return scope.unrestricted ? rows : rows.filter((r) => this.scopes.allowsUnit(scope, r.orgUnitId));
  }

  /** 404 when the record's org unit is outside the caller's scope (anti-enumeration); a record with no org link is not a scope matter. */
  async assertVisible(req: CompanyScopedRequest, orgUnitId: string | null | undefined): Promise<void> {
    this.scopes.assertUnit(await this.scopes.forRequest(req), orgUnitId);
  }

  /** Validated branch for a write that fixes the org context of a NEW record whose parent already has one: the parent's branch wins, a conflicting request is refused. */
  inheritBranch(parentBranchId: string | null | undefined, requested: string | null | undefined): string | null {
    if (parentBranchId && requested && requested !== parentBranchId) {
      throw new BadRequestException('The branch must match the parent document. / يجب أن يطابق الفرع المستند الأصلي.');
    }
    return parentBranchId ?? null;
  }

  /** Companion for services that already hold a validated id and only need the unit's display name (e.g. the legacy text mirror). */
  async branchName(orgUnitId: string, manager: EntityManager): Promise<string | null> {
    const row = (await manager.query(`SELECT "name" FROM "org_units" WHERE "id" = $1`, [orgUnitId]))[0] as { name: string } | undefined;
    return row?.name ?? null;
  }
}
