import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Company } from '../company/company.entity';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { Role } from '../authorization/role.entity';
import { RolePermission } from '../permission/role-permission.entity';
import { ModuleRoleTemplateSeeder } from '../module-role-templates/module-role-template.seeder';
import { MODULE_ROLE_TEMPLATES } from '../module-registry/role-templates';
import { CompanyEntitlementService } from './company-entitlement.service';
import { CompanyPlanAssignment, Plan, PlanModule } from './plan.entity';

export interface CompanyPackageView {
  companyId: string;
  /** `package` = the assigned Plan is enforced; `installation` = no Plan assigned (the installation licence applies unchanged). */
  source: 'package' | 'installation';
  plan: { code: string; name: string; status: string; moduleCodes: string[] } | null;
  /** What the Company can actually use right now (package ∩ installation licence). */
  effectiveModules: string[];
  /** Modules in the Plan that the installation licence does not (or no longer) include. */
  unlicensedPlanModules: string[];
  assignedAt: Date | null;
}

export interface AssignResult {
  package: CompanyPackageView;
  /** Effective-module change caused by this assignment (a downgrade shows up in `removedModules`). */
  addedModules: string[];
  removedModules: string[];
  /** Whether the Company's own database was updated with the new modules' role templates / admin grants. */
  rolesSynced: boolean;
  rolesAdded: number;
  grantsAdded: number;
}

const COMPANY_FORBIDDEN_STATUSES = new Set(['DECOMMISSIONED']);

/**
 * Company Plans / Packages — assigning a Plan to a Company (Super Admin only).
 *
 * Assignment (1) records the Plan on the platform DB, (2) invalidates the
 * Company's cached entitlement so enforcement is immediate, and (3) makes the
 * Company's own database ready for the new modules: it seeds the module role
 * templates and gives the Company `admin` role an editable grant on each module,
 * both idempotent and additive (they never remove anything). Removing a module
 * from a Plan stops access through entitlement; it deliberately does not delete
 * roles or grants the Company may already be using.
 */
@Injectable()
export class CompanyPackageService {
  private readonly logger = new Logger(CompanyPackageService.name);

  constructor(
    @InjectRepository(Company) private readonly companies: Repository<Company>,
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    @InjectRepository(PlanModule) private readonly planModules: Repository<PlanModule>,
    @InjectRepository(CompanyPlanAssignment) private readonly assignments: Repository<CompanyPlanAssignment>,
    private readonly dataSource: DataSource,
    private readonly connections: CompanyConnectionManagerService,
    private readonly companyEntitlement: CompanyEntitlementService,
    private readonly installation: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  async getForCompany(companyId: string): Promise<CompanyPackageView> {
    await this.requireCompany(companyId);
    const assignment = await this.assignments.findOne({ where: { companyId } });
    const resolved = await this.companyEntitlement.resolve(companyId);
    if (!assignment) {
      return { companyId, source: 'installation', plan: null, effectiveModules: [...resolved.modules].sort(), unlicensedPlanModules: [], assignedAt: null };
    }
    const plan = await this.plans.findOne({ where: { code: assignment.planCode } });
    const moduleCodes = (await this.planModules.find({ where: { planCode: assignment.planCode } })).map((m) => m.moduleCode).sort();
    const lic = this.installation.resolve();
    return {
      companyId,
      source: 'package',
      plan: plan ? { code: plan.code, name: plan.name, status: plan.status, moduleCodes } : null,
      effectiveModules: [...resolved.modules].sort(),
      unlicensedPlanModules: moduleCodes.filter((m) => !(lic.status === 'active' && lic.modules.has(m))),
      assignedAt: assignment.updatedAt,
    };
  }

  async assign(companyId: string, planCode: string, actorUserId: string | null): Promise<AssignResult> {
    const company = await this.requireCompany(companyId);
    if (COMPANY_FORBIDDEN_STATUSES.has(company.status)) {
      throw new ConflictException(`Company is ${company.status}; a package cannot be assigned.`);
    }
    const plan = await this.plans.findOne({ where: { code: planCode } });
    if (!plan) throw new NotFoundException(`Plan not found: ${planCode}`);
    if (plan.status !== 'active') throw new BadRequestException(`Plan "${planCode}" is archived and cannot be assigned.`);
    const moduleCodes = (await this.planModules.find({ where: { planCode } })).map((m) => m.moduleCode).sort();
    if (moduleCodes.length === 0) throw new BadRequestException(`Plan "${planCode}" has no modules.`);

    const previous = await this.assignments.findOne({ where: { companyId } });
    // Effective modules before the change (computed before invalidation, so it reflects what the Company could use).
    const effectiveBefore = [...(await this.companyEntitlement.resolve(companyId)).modules];
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(CompanyPlanAssignment).save({ companyId, planCode, assignedByUserId: actorUserId });
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'company.package.assigned',
          resource: 'company',
          resourceId: companyId,
          result: 'success',
          correlationId: null,
          before: { planCode: previous?.planCode ?? null },
          after: { planCode, moduleCodes },
        },
        manager,
      );
    });
    this.companyEntitlement.invalidate(companyId);

    const sync = await this.syncCompanyRoles(companyId, moduleCodes);
    const view = await this.getForCompany(companyId);
    const addedModules = view.effectiveModules.filter((m) => !effectiveBefore.includes(m)).sort();
    const removedModules = effectiveBefore.filter((m) => !view.effectiveModules.includes(m)).sort();
    return { package: view, addedModules, removedModules, ...sync };
  }

  /** Prepare the Company's own database for these modules. Never throws for an unreachable Company DB: entitlement is already enforced from the platform DB. */
  async syncCompanyRoles(companyId: string, moduleCodes: string[]): Promise<{ rolesSynced: boolean; rolesAdded: number; grantsAdded: number }> {
    let ds: DataSource;
    try {
      ds = await this.connections.getDataSource(companyId);
    } catch (err) {
      this.logger.warn(`Package assigned to ${companyId} but its database is not reachable for role sync: ${(err as Error).message}`);
      return { rolesSynced: false, rolesAdded: 0, grantsAdded: 0 };
    }
    const roleRepo = ds.getRepository(Role);
    const permRepo = ds.getRepository(RolePermission);
    const seeder = new ModuleRoleTemplateSeeder(roleRepo, permRepo);
    let rolesAdded = 0;
    let grantsAdded = 0;
    for (const code of moduleCodes) {
      if (!MODULE_ROLE_TEMPLATES[code]) continue;
      const r = await seeder.seedForModule(code);
      rolesAdded += r.roles;
      grantsAdded += r.grants;
    }
    const admin = await roleRepo.findOne({ where: { key: 'admin' } });
    if (admin) {
      for (const node of moduleCodes) {
        if (!(await permRepo.findOne({ where: { roleId: admin.id, nodeKey: node } }))) {
          await permRepo.save(permRepo.create({ roleId: admin.id, nodeKey: node, access: 'editable' }));
          grantsAdded++;
        }
      }
    }
    return { rolesSynced: true, rolesAdded, grantsAdded };
  }

  /** Re-run the role sync for every Company on a Plan (after the Plan gained modules). */
  async syncPlanCompanies(planCode: string): Promise<void> {
    const moduleCodes = (await this.planModules.find({ where: { planCode } })).map((m) => m.moduleCode);
    for (const a of await this.assignments.find({ where: { planCode } })) {
      await this.syncCompanyRoles(a.companyId, moduleCodes);
    }
  }

  private async requireCompany(companyId: string): Promise<Company> {
    const company = await this.companies.findOne({ where: { id: companyId } });
    if (!company) throw new NotFoundException(`Company not found: ${companyId}`);
    return company;
  }
}
