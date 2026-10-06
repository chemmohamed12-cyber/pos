import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CompanyEntitlementResolver } from '../module-registry/entitlement-resolver.token';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { EntitlementService } from '../entitlement/entitlement.service';
import { CompanyPlanAssignment, PlanModule } from './plan.entity';

export interface CompanyResolvedEntitlement {
  companyId: string;
  /** `package` = an assigned Plan is enforced; `installation` = no Plan assigned, the installation's own entitlement applies. */
  source: 'package' | 'installation';
  planCode: string | null;
  status: 'active' | 'suspended' | 'expired';
  modules: ReadonlySet<string>;
  features: ReadonlySet<string>;
}

interface CacheEntry {
  value: CompanyResolvedEntitlement;
  expiresAt: number;
}

/** Safety net only: every write path in this process invalidates exactly; the TTL bounds staleness across processes. */
const CACHE_TTL_MS = 15_000;

/**
 * Company Plans / Packages — the per-Company runtime resolver.
 *
 *   effective(Company) = assigned package  ∩  installation licence
 *
 * - The installation's signed entitlement (`EntitlementService`) stays the
 *   CEILING: a Plan can never make a Company able to use a module the
 *   installation itself is not licensed for, and an expired/suspended
 *   installation licence yields nothing for every Company.
 * - A Company with NO assigned package resolves to the installation's own
 *   entitlement unchanged (backward compatible for every Company that existed
 *   before this feature). Once a package is assigned it is enforced.
 * - The cache is keyed by `companyId` only and has no process-global "current
 *   Company"; a lookup can never silently resolve to another Company's value.
 *   Callers must pass a Membership-validated Company id.
 */
@Injectable()
export class CompanyEntitlementService implements CompanyEntitlementResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(CompanyPlanAssignment) private readonly assignments: Repository<CompanyPlanAssignment>,
    @InjectRepository(PlanModule) private readonly planModules: Repository<PlanModule>,
    private readonly installation: EntitlementService,
  ) {}

  async resolve(companyId: string): Promise<CompanyResolvedEntitlement> {
    const now = Date.now();
    const hit = this.cache.get(companyId);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = await this.compute(companyId);
    this.cache.set(companyId, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  }

  /** Drop one Company (after assigning/changing its package) or, with no argument, every Company (after a Plan's modules change). */
  invalidate(companyId?: string): void {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }

  async isModuleEntitled(companyId: string, moduleCode: string): Promise<boolean> {
    if (moduleCode === 'core') return true;
    const r = await this.resolve(companyId);
    return r.status === 'active' && r.modules.has(moduleCode);
  }

  async isFeatureEntitled(companyId: string, featureCode: string): Promise<boolean> {
    const r = await this.resolve(companyId);
    if (r.status !== 'active') return false;
    // Same rule as the installation resolver: a non-toggleable (structural) feature follows its module.
    const moduleCode = featureCode.split('.')[0];
    const meta = MODULE_REGISTRY.manifest(moduleCode as never);
    const featureMeta = meta?.feature_codes.find((f) => f.code === featureCode);
    if (featureMeta && !featureMeta.toggleable) return r.modules.has(moduleCode);
    return r.features.has(featureCode);
  }

  private async compute(companyId: string): Promise<CompanyResolvedEntitlement> {
    const inst = this.installation.resolve();
    const assignment = await this.assignments.findOne({ where: { companyId } });
    if (!assignment) {
      return { companyId, source: 'installation', planCode: null, status: inst.status, modules: inst.modules, features: inst.features };
    }

    const rows = await this.planModules.find({ where: { planCode: assignment.planCode } });
    const modules = new Set<string>();
    if (inst.status === 'active') {
      for (const row of rows) if (inst.modules.has(row.moduleCode)) modules.add(row.moduleCode);
    }
    // Features: whatever the installation licence enables, restricted to the package's modules.
    const features = new Set<string>();
    for (const f of inst.features) if (modules.has(f.split('.')[0])) features.add(f);
    return { companyId, source: 'package', planCode: assignment.planCode, status: inst.status, modules, features };
  }
}
