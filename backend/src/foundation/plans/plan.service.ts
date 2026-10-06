import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { EntitlementService } from '../entitlement/entitlement.service';
import { AuditService } from '../audit/audit.service';
import { CompanyEntitlementService } from './company-entitlement.service';
import { CompanyPlanAssignment, Plan, PlanModule, PlanStatus } from './plan.entity';

export interface ModuleCatalogEntry {
  code: string;
  titleCode: string;
  dependsOn: string[];
  /** Transitive hard dependencies (a module pulls these in automatically). */
  closure: string[];
  /** True if the installation's own licence includes it; only licensed modules can go into a Plan. */
  licensed: boolean;
}

export interface PlanView {
  code: string;
  name: string;
  description: string | null;
  status: PlanStatus;
  moduleCodes: string[];
  companyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePlanInput {
  code: string;
  name: string;
  description?: string | null;
  moduleCodes: string[];
}

export interface UpdatePlanInput {
  name?: string;
  description?: string | null;
  moduleCodes?: string[];
  status?: PlanStatus;
}

export const PLAN_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,62}$/;

/**
 * Company Plans / Packages — the Plan catalog (platform level, Super Admin only).
 *
 * A Plan is a set of modules. Two rules are enforced when one is saved:
 *  1. DEPENDENCY CLOSURE (F-MOD-2): choosing a module also includes everything it
 *     hard-depends on. The graph is cyclic today (sales/inventory/finance/accounting
 *     all pull each other in), so a "sales only" Plan genuinely cannot exist — the
 *     server expands and stores the closed set rather than rejecting the request.
 *  2. LICENCE CEILING: every module in the (closed) set must be licensed by the
 *     installation. A Plan can never sell what the installation does not own.
 */
@Injectable()
export class PlanService {
  constructor(
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    @InjectRepository(PlanModule) private readonly planModules: Repository<PlanModule>,
    @InjectRepository(CompanyPlanAssignment) private readonly assignments: Repository<CompanyPlanAssignment>,
    private readonly dataSource: DataSource,
    private readonly installation: EntitlementService,
    private readonly companyEntitlement: CompanyEntitlementService,
    private readonly audit: AuditService,
  ) {}

  /** Every authored module with its dependencies and whether the installation licence includes it. */
  moduleCatalog(): ModuleCatalogEntry[] {
    const licensed = this.installation.resolve();
    return MODULE_REGISTRY.authoredModuleCodes().map((code) => ({
      code,
      titleCode: MODULE_REGISTRY.manifest(code)?.title_code ?? `module.${code}`,
      dependsOn: [...MODULE_REGISTRY.dependenciesOf(code)],
      closure: [...MODULE_REGISTRY.dependencyClosureOf(code)],
      licensed: licensed.status === 'active' && licensed.modules.has(code),
    }));
  }

  /** The closed module set for a request, plus the modules the closure added. Throws on unknown or unlicensed modules. */
  closeAndValidate(requested: string[]): { moduleCodes: string[]; added: string[] } {
    const authored = new Set<string>(MODULE_REGISTRY.authoredModuleCodes());
    const unique = [...new Set(requested.map((m) => m.trim()).filter(Boolean))];
    if (unique.length === 0) throw new BadRequestException('A Plan must include at least one module.');
    const unknown = unique.filter((m) => !authored.has(m));
    if (unknown.length) throw new BadRequestException(`Unknown module code(s): ${unknown.join(', ')}.`);

    const closed = new Set(unique);
    for (const m of unique) for (const dep of MODULE_REGISTRY.dependencyClosureOf(m as never)) closed.add(dep);

    const licensed = this.installation.resolve();
    const unlicensed = [...closed].filter((m) => !(licensed.status === 'active' && licensed.modules.has(m)));
    if (unlicensed.length) {
      throw new UnprocessableEntityException(
        `The installation licence does not include: ${unlicensed.sort().join(', ')}. A Plan can only contain licensed modules (including the modules they depend on).`,
      );
    }
    return { moduleCodes: [...closed].sort(), added: [...closed].filter((m) => !unique.includes(m)).sort() };
  }

  async list(): Promise<PlanView[]> {
    const plans = await this.plans.find({ order: { name: 'ASC' } });
    return this.toViews(plans);
  }

  async get(code: string): Promise<PlanView> {
    const plan = await this.plans.findOne({ where: { code } });
    if (!plan) throw new NotFoundException(`Plan not found: ${code}`);
    return (await this.toViews([plan]))[0];
  }

  async create(input: CreatePlanInput, actorUserId: string | null): Promise<{ plan: PlanView; addedByDependency: string[] }> {
    const code = input.code.trim().toLowerCase();
    if (!PLAN_CODE_PATTERN.test(code)) {
      throw new BadRequestException('Plan code must be 2–63 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.');
    }
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Plan name is required.');
    if (await this.plans.findOne({ where: { code } })) throw new ConflictException(`A Plan with code "${code}" already exists.`);
    const { moduleCodes, added } = this.closeAndValidate(input.moduleCodes);

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(Plan).save({ code, name, description: input.description?.trim() || null, status: 'active' as PlanStatus });
      await manager.getRepository(PlanModule).save(moduleCodes.map((moduleCode) => ({ planCode: code, moduleCode })));
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'plan.created', resource: 'plan', resourceId: code, result: 'success', correlationId: null, after: { name, moduleCodes } },
        manager,
      );
    });
    return { plan: await this.get(code), addedByDependency: added };
  }

  async update(
    code: string,
    input: UpdatePlanInput,
    actorUserId: string | null,
  ): Promise<{ plan: PlanView; addedByDependency: string[]; affectedCompanyIds: string[]; addedModules: string[]; removedModules: string[] }> {
    const existing = await this.plans.findOne({ where: { code } });
    if (!existing) throw new NotFoundException(`Plan not found: ${code}`);
    if (input.name !== undefined && !input.name.trim()) throw new BadRequestException('Plan name cannot be empty.');
    if (input.status !== undefined && input.status !== 'active' && input.status !== 'archived') throw new BadRequestException('Plan status must be "active" or "archived".');

    const before = await this.get(code);
    let moduleCodes: string[] | null = null;
    let added: string[] = [];
    if (input.moduleCodes) {
      const closed = this.closeAndValidate(input.moduleCodes);
      moduleCodes = closed.moduleCodes;
      added = closed.added;
    }
    const modulesChanged = moduleCodes !== null && moduleCodes.join(',') !== [...before.moduleCodes].sort().join(',');

    await this.dataSource.transaction(async (manager) => {
      const planRepo = manager.getRepository(Plan);
      if (input.name !== undefined) existing.name = input.name.trim();
      if (input.description !== undefined) existing.description = input.description?.trim() || null;
      if (input.status !== undefined) existing.status = input.status;
      await planRepo.save(existing);
      if (moduleCodes && modulesChanged) {
        const moduleRepo = manager.getRepository(PlanModule);
        await moduleRepo.delete({ planCode: code });
        await moduleRepo.save(moduleCodes.map((moduleCode) => ({ planCode: code, moduleCode })));
      }
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'plan.updated',
          resource: 'plan',
          resourceId: code,
          result: 'success',
          correlationId: null,
          before: { name: before.name, status: before.status, moduleCodes: before.moduleCodes },
          after: { name: existing.name, status: existing.status, moduleCodes: moduleCodes ?? before.moduleCodes },
        },
        manager,
      );
    });

    // Every Company on this Plan is affected the moment its modules change.
    const affected = modulesChanged ? (await this.assignments.find({ where: { planCode: code } })).map((a) => a.companyId) : [];
    if (modulesChanged) this.companyEntitlement.invalidate();
    // What every Company on this Plan gains / loses immediately (entitlement is enforced per request; nothing is deleted).
    const nowModules = moduleCodes ?? before.moduleCodes;
    const addedModules = nowModules.filter((m) => !before.moduleCodes.includes(m)).sort();
    const removedModules = before.moduleCodes.filter((m) => !nowModules.includes(m)).sort();
    return { plan: await this.get(code), addedByDependency: added, affectedCompanyIds: affected, addedModules, removedModules };
  }

  private async toViews(plans: Plan[]): Promise<PlanView[]> {
    if (plans.length === 0) return [];
    const codes = plans.map((p) => p.code);
    const modules = await this.planModules.find({ where: { planCode: In(codes) } });
    const assigned = await this.assignments.find({ where: { planCode: In(codes) } });
    return plans.map((p) => ({
      code: p.code,
      name: p.name,
      description: p.description,
      status: p.status,
      moduleCodes: modules.filter((m) => m.planCode === p.code).map((m) => m.moduleCode).sort(),
      companyCount: assigned.filter((a) => a.planCode === p.code).length,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }
}
