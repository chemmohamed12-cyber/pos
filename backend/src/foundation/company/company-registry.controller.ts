import { PlatformGuard, RequirePlatform } from '../platform/platform.guard';
import { BadRequestException, Body, Controller, Get, HttpStatus, NotFoundException, Param, Post, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { DaiiException } from '../error-contract/daii-exception';
import { EntitlementService } from '../entitlement/entitlement.service';
import { Logger } from '@nestjs/common';
import { allocateCompanyDatabase, CompanyDatabaseAllocationError, serializeAllocation } from './company-database-allocator';
import { ArrayNotEmpty, IsArray, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { RequireRole } from '../authorization/require-role.decorator';
import { CompanyRegistryService, InvalidCompanyTransitionError } from './company-registry.service';
import { CompanyActivationService } from './company-activation.service';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseProvisioningService, ProvisioningFailedError } from '../database-provisioning/database-provisioning.service';
import { AppConfigService } from '../configuration/app-config.service';
import { INSTALLATION_SINGLETON_ID } from '../entitlement/installation.entity';
import { Company } from './company.entity';

class CreateCompanyDto {
  @IsString()
  @MinLength(1)
  name!: string;

  /** D1 (Area 20): must reference an EXISTING User — this endpoint never creates one. */
  @IsUUID()
  initialAdminUserId!: string;

  /**
   * Migration tags to run in the new Company's own database. Omitted =
   * `runMigrationsForDatabase`'s own existing default (auto-discover every
   * tag under `src/database/migrations/`) — not a new default invented
   * here, the pre-existing behavior when `tags` is left `undefined`.
   */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  tags?: string[];

  /**
   * Module role-template catalogs to seed (Area 6). Omitted =
   * `DatabaseProvisioningService`'s own existing default (`[]` — "does not
   * guess an entitlement it has no way to know yet", per that service's
   * own doc comment). Not overridden with a different default here.
   */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  roleModuleCodes?: string[];
}

interface CompanyView {
  id: string;
  name: string;
  status: Company['status'];
  createdAt: Date;
  /** Null until a `DatabaseRegistry` row exists for this Company (i.e. before `DatabaseProvisioningService.provision()` has run at all). */
  databaseStatus: string | null;
}

/**
 * Multi-Company Control Plane — P0 (2026-09-27, CTO-authorized: "P0
 * Multi-Company Control-Plane HTTP Surface"). Exposes the EXISTING,
 * already-built, already-real-PG-verified `CompanyRegistryService` /
 * `CompanyActivationService` / `DatabaseProvisioningService` (Multi-Company
 * Phase 3 V7, Areas 2/4/19/20) through a real HTTP surface — this file adds
 * no new business logic, no new state machine, no new provisioning steps.
 *
 * Authorization: the SAME Installation-Administrator boundary this
 * codebase already established for exactly this kind of control-plane
 * operation — `installation-membership.controller.ts`'s own precedent
 * (`JwtAuthGuard` + `RolesGuard` + `@RequireRole('admin')`, never
 * `CompanyContextGuard` — a platform admin is trusted to name any Company
 * explicitly, for control-plane purposes, exactly as that controller's own
 * doc comment states). Not a new authorization axis.
 *
 * Installation Bootstrap (P0.1): resolved, not built here. The singleton
 * `Installation` row (`INSTALLATION_SINGLETON_ID`) this Company's
 * `installationId` FK requires is already created by the EXISTING
 * `POST /admin/entitlement/apply` (`EntitlementController`/
 * `EntitlementService.applyManifest`) — "the endpoint P6's deploy step
 * calls to apply a freshly-issued signed manifest." That IS the approved
 * bootstrap mechanism; this controller does not create an Installation row
 * itself, silently or otherwise — `POST /installation/companies` will
 * correctly fail with a clear error if no Installation row exists yet
 * (the real DB-level FK, not a guessed error path).
 */
@Controller('installation/companies')
@UseGuards(JwtAuthGuard, PlatformGuard)
export class CompanyRegistryController {
  private readonly logger = new Logger(CompanyRegistryController.name);

  constructor(
    private readonly companyRegistry: CompanyRegistryService,
    private readonly companyActivation: CompanyActivationService,
    private readonly databaseRegistry: DatabaseRegistryService,
    private readonly databaseProvisioning: DatabaseProvisioningService,
    private readonly config: AppConfigService,
    private readonly entitlement: EntitlementService,
  ) {}

  @RequirePlatform('platform.company.view')
  @Get()
  async list() {
    const companies = await this.companyRegistry.listVisible(INSTALLATION_SINGLETON_ID);
    const views = await Promise.all(companies.map((c) => this.toView(c)));
    return { success: true, data: views };
  }

  @RequirePlatform('platform.company.view')
  @Get(':id')
  async get(@Param('id') id: string) {
    const company = await this.companyRegistry.findById(id);
    if (!company) throw new NotFoundException(`Company not found: ${id}`);
    return { success: true, data: await this.toView(company) };
  }

  /**
   * Synchronous — see `docs/decisions/P0-MULTI-COMPANY-CONTROL-PLANE-API.md`
   * for why. Runs `CompanyRegistryService.provision()` (create, status
   * `PROVISIONING`) then immediately `DatabaseProvisioningService.provision()`
   * (the existing, unmodified, already-verified pipeline) in the same
   * request. On any provisioning-stage failure, the Company row itself is
   * NOT transitioned to a failure status by the existing service (a
   * pre-existing asymmetry — see the same doc) — its `DatabaseRegistry`
   * row IS marked `FAILED`, and `databaseStatus` in the response reflects
   * that even though `status` still reads `PROVISIONING`. Not corrected
   * here — that would be changing existing, already-verified service
   * behavior, out of this endpoint's scope.
   */
  @RequirePlatform('platform.company.create', 'editable')
  @Post()
  async create(@Body() dto: CreateCompanyDto) {
    // A Company's `installationId` is a foreign key to the platform installation row. Refuse BEFORE anything is created, with the real reason — the raw foreign-key
    // violation used to reach the operator as "An unexpected error occurred" (post-incident review of release 1.1.4).
    if (!(await this.entitlement.isInstallationInitialized())) {
      throw new DaiiException(
        'INSTALLATION_NOT_INITIALIZED',
        'The platform installation is not initialised, so a Company cannot be created yet. With ENTITLEMENT_MODE=unlicensed-full it is initialised automatically when the application starts; with ENTITLEMENT_MODE=enforced a signed entitlement manifest must be applied first (POST /api/admin/entitlement/apply).',
        HttpStatus.CONFLICT,
      );
    }
    // Create the PHYSICAL database FIRST. `companies.status` has no edge out of PROVISIONING except READY, so a Company row inserted before a failure here could never
    // be marked failed and would stay behind as an orphan PROVISIONING record. If the database user cannot reach the maintenance database or lacks CREATEDB (typical of a
    // shared PostgreSQL host), nothing has been created yet and the operator gets the real reason instead of "An unexpected error occurred".
    // The initial administrator must exist BEFORE anything is allocated or created: failing here later would leave a PROVISIONING Company and a consumed database.
    await this.assertInitialAdmin(dto.initialAdminUserId);
    const cfg = this.config.companyDatabase;
    const app = { host: this.config.database.host, port: this.config.database.port, username: this.config.database.username, password: this.config.database.password };
    // Serialised so two concurrent creations cannot claim the same pooled database. The Company row follows the allocation, in the same critical section.
    return serializeAllocation(async () => {
      let allocated: { databaseName: string; origin: 'created' | 'pooled' };
      try {
        allocated = await allocateCompanyDatabase(cfg, app, () => this.databaseRegistry.usedDatabaseNames());
      } catch (err) {
        if (err instanceof CompanyDatabaseAllocationError) {
          this.logger.error(`Company database allocation failed (${err.code}): ${err.detail}`);
          throw new UnprocessableEntityException({ message: err.message, code: err.code, stage: cfg.mode === 'pool' ? 'claim-database' : 'create-database', detail: err.detail });
        }
        throw err;
      }
      return this.createCompanyOn(dto, allocated.databaseName);
    });
  }

  /**
   * Resume provisioning of a Company whose earlier attempt failed AFTER its database was allocated (migration / role-seeding fault). It reuses the SAME database and the
   * SAME Company row — no new allocation, no duplicate Company — through the provisioning service's existing retry/resume path.
   */
  @RequirePlatform('platform.company.create', 'editable')
  @Post(':id/retry-provisioning')
  async retryProvisioning(@Param('id') id: string, @Body() dto: CreateCompanyDto) {
    const company = await this.companyRegistry.findById(id);
    if (!company) throw new NotFoundException(`Company not found: ${id}`);
    if (company.status !== 'PROVISIONING') {
      throw new UnprocessableEntityException({ message: `Company is ${company.status}, only a PROVISIONING Company can be retried.`, code: 'COMPANY_NOT_RETRYABLE' });
    }
    const registry = await this.databaseRegistry.findByCompanyId(id);
    if (!registry) {
      throw new UnprocessableEntityException({ message: 'No database was ever allocated to this Company, so there is nothing to resume. Create the Company again.', code: 'COMPANY_NOT_RETRYABLE' });
    }
    await this.assertInitialAdmin(dto.initialAdminUserId);
    return this.createCompanyOn(dto, registry.databaseName, company);
  }

  private async assertInitialAdmin(userId: string): Promise<void> {
    try {
      await this.databaseProvisioning.assertInitialAdminExists(userId);
    } catch (err) {
      if (err instanceof NotFoundException) throw new BadRequestException(`initialAdminUserId does not reference an existing User: ${userId}`);
      throw err;
    }
  }

  private async createCompanyOn(dto: CreateCompanyDto, databaseName: string, existing?: Company) {
    const company = existing ?? (await this.companyRegistry.provision(INSTALLATION_SINGLETON_ID, dto.name));

    try {
      // `DatabaseProvisioningService.provision()` runs migrations against
      // `databaseName` — it does NOT create the physical Postgres database
      // itself (confirmed directly: neither the service nor
      // `runMigrationsForDatabase` issues a `CREATE DATABASE`). Every
      // existing real-PG caller (`database-provisioning.service.spec.ts`,
      // `two-company-real-pg-harness.ts`) creates it first — this is that
      // same, already-established step, not a new one invented here.
      const result = await this.databaseProvisioning.provision({
        companyId: company.id,
        host: this.config.database.host,
        port: this.config.database.port,
        databaseName,
        username: this.config.database.username,
        password: this.config.database.password,
        appRoot: this.config.releaseExecution.appRoot,
        tags: dto.tags,
        roleModuleCodes: dto.roleModuleCodes ?? [],
        initialAdminUserId: dto.initialAdminUserId,
      });
      const ready = await this.companyRegistry.findById(company.id);
      return {
        success: true,
        data: {
          company: await this.toView(ready!),
          migratedTags: result.migratedNames,
          roleSeedResult: result.roleSeedResult,
          entitlementApplied: result.entitlementApplied,
          initialAdminMembershipId: result.initialAdmin.id,
        },
      };
    } catch (err) {
      if (err instanceof ProvisioningFailedError) {
        throw new UnprocessableEntityException({
          message: `Company provisioning failed at stage "${err.stage}".`,
          stage: err.stage,
          detail: err.message,
          companyId: company.id,
        });
      }
      if (err instanceof Error && /not found/i.test(err.message) && /user/i.test(err.message)) {
        throw new BadRequestException(`initialAdminUserId does not reference an existing User: ${dto.initialAdminUserId}`);
      }
      throw err;
    }
  }

  @RequirePlatform('platform.company.suspend', 'editable')
  @Post(':id/suspend')
  async suspend(@Param('id') id: string) {
    return { success: true, data: await this.transition(id, () => this.companyActivation.suspend(id)) };
  }

  @RequirePlatform('platform.company.reactivate', 'editable')
  @Post(':id/reactivate')
  async reactivate(@Param('id') id: string) {
    return { success: true, data: await this.transition(id, () => this.companyActivation.reactivate(id)) };
  }

  @RequirePlatform('platform.company.decommission', 'editable')
  @Post(':id/decommission')
  async decommission(@Param('id') id: string) {
    return { success: true, data: await this.transition(id, () => this.companyActivation.decommission(id)) };
  }

  private async transition(id: string, fn: () => Promise<Company>): Promise<CompanyView> {
    try {
      const company = await fn();
      return this.toView(company);
    } catch (err) {
      if (err instanceof InvalidCompanyTransitionError) {
        throw new UnprocessableEntityException(err.message);
      }
      if (err instanceof Error && /not found/i.test(err.message)) {
        throw new NotFoundException(`Company not found: ${id}`);
      }
      throw err;
    }
  }

  private async toView(company: Company): Promise<CompanyView> {
    const registry = await this.databaseRegistry.findByCompanyId(company.id);
    return {
      id: company.id,
      name: company.name,
      status: company.status,
      createdAt: company.createdAt,
      databaseStatus: registry?.status ?? null,
    };
  }
}
