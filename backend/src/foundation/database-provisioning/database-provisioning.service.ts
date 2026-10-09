import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CompanyRegistryService } from '../company/company-registry.service';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { runMigrationsForDatabase } from '../release-orchestration/company-migration-runner';
import { seedCompanyRoleTemplates, seedCompanyAdminRole, seedCompanyAdministratorRole, CompanyRoleSeedResult } from '../company/company-role-seeding';
import { COMPANY_ADMIN_ROLE_KEY } from '../module-registry/role-templates';
import { applyCompanyAuthorizationSchemaAdjustment } from '../company/company-authorization-schema-adjustment';
import { applyEntitlementManifestToCompany, CompanyEntitlementOptions } from '../company/company-entitlement-provisioning';
import { EntitlementManifest } from '../entitlement/manifest.type';
import { ReleaseHealthCheckService, ReleaseHealthCheckResult } from '../release/release-health-check.service';
import { MembershipService } from '../company/membership.service';
import { Membership } from '../company/membership.entity';
import { UsersService } from '../identity/users.service';
import { provisionUserRoleForMembership } from '../company/membership-role-provisioning';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';

const ADMIN_ROLE_KEY = 'admin';

export interface ProvisionCompanyDatabaseParams {
  companyId: string;
  host: string;
  port: number;
  databaseName: string;
  /** DB role/user for this Company's database — see the class doc comment for why this is packaged into the credential rather than a new DatabaseRegistry column. */
  username: string;
  password: string;
  appRoot: string;
  tags?: readonly string[];
  /**
   * Which module role-template catalogs to seed (Area 6). Resolving what
   * a Company is actually entitled to is Area 7's job, not built yet —
   * so this is caller-supplied, not resolved internally. Defaults to
   * none: provisioning does not guess an entitlement it has no way to
   * know yet.
   */
  roleModuleCodes?: readonly string[];
  /**
   * Area 7 (Edition/Entitlement per Company) — the Company's default
   * signed manifest, explicit provisioning input per the CTO's own
   * registered principle: provisioning consumes a resolved
   * package/entitlement profile, it does not compute one. Optional:
   * `undefined` skips this step entirely (no manifest applied), rather
   * than assuming an implicit default edition on the caller's behalf.
   */
  entitlementManifest?: EntitlementManifest;
  entitlementSignature?: string;
  entitlementOptions?: CompanyEntitlementOptions;
  /**
   * Area 20 (2026-09-24, D1/D3/D7 decisions) — mandatory, gates READY.
   * MUST reference an existing `User` (D1 — this service never creates
   * one); `provision()` fails the whole attempt if it doesn't resolve,
   * exactly like every other stage (D7: no `READY` Company is ever left
   * without an administrator, by construction, not by a follow-up
   * remediation step).
   */
  initialAdminUserId: string;
  /**
   * F3 / D17 — which administrator role a NEW Company is born with. `'admin'` (default for now) is the pre-existing operational administrator;
   * `'company_admin'` is the administration-only system role (users, roles, backups, audit — no operational/critical power). The default stays `'admin'`
   * until the legacy role checks are migrated (F5): ~89 backend call-sites still demand the key `admin` (e.g. Organization writes), so a `company_admin`-only
   * Company would 403 on them. Flip the default when F5 closes (CTO decision recorded in the F3 report).
   */
  administratorRole?: 'admin' | 'company_admin';
}

export interface ProvisionCompanyDatabaseResult {
  registry: DatabaseRegistry;
  migratedNames: string[];
  roleSeedResult: CompanyRoleSeedResult;
  entitlementApplied: boolean;
  initialAdmin: Membership;
  healthCheck: ReleaseHealthCheckResult | null;
  readyMarked: boolean;
}

export class ProvisioningFailedError extends Error {
  constructor(
    public readonly stage: 'migrations' | 'authorization-schema-adjustment' | 'role-seeding' | 'entitlement' | 'initial-admin' | 'health-check',
    message: string,
  ) {
    super(message);
    this.name = 'ProvisioningFailedError';
  }
}

/**
 * Multi-Company Phase 3 V7, Area 4 (Database Provisioning) + Area 20
 * (2026-09-24, Initial Admin Provisioning — D1/D3/D7 decisions). Literal
 * sequence: Create Company (Area 2, already done by the caller before
 * this runs) → Provision Database (Area 3's `DatabaseRegistryService`)
 * → Apply baseline schema / run foundation migrations (Area 16's
 * `runMigrationsForDatabase` — the existing single-database pipeline,
 * unmodified) → seed the Company's role catalog (Area 6's
 * `seedCompanyRoleTemplates` + §3.1's `seedCompanyAdminRole`, satisfying
 * Area 6's own invariant that role seeding must complete before Company
 * membership can become active) → Create initial admin → Health check
 * (the existing `ReleaseHealthCheckService`, unmodified, pointed at the
 * Company's own connection) → Mark READY (Area 2).
 *
 * "Create initial admin" (D7: mandatory, gates READY) grants
 * `initialAdminUserId` — an EXISTING User (D1; this service never
 * creates one) — the `admin` role in this Company, both the Platform-DB
 * `Membership` row and the Company-DB `UserRole` grant. Any failure here
 * fails the whole provisioning attempt, exactly like migrations/
 * role-seeding/entitlement — there is no such thing as a `READY` Company
 * with no administrator.
 *
 * Credential shape: Area 3's `DatabaseRegistryService.register()` takes
 * one opaque plaintext string, encrypted as-is — deliberately generic
 * (Area 3's own entity doc comment: "its internal shape ... is left to
 * the caller"). This service is that caller, and defines the shape as
 * `JSON.stringify({ username, password })`, because connecting to the
 * provisioned database needs a username V7's literal DatabaseRegistry
 * schema (`companyId → {host, port, database name, status}`) has no
 * column for. This is Area 4's own implementation decision within the
 * space Area 3 deliberately left open — not a new column, not a change
 * to Area 3's schema.
 *
 * Package/Entitlement input (CTO architectural refinement, registered
 * 2026-09-22): "Company Provisioning must consume the Company's
 * effective Package/Entitlement profile as an explicit provisioning
 * input, while Package Engine, Company Engine, Entitlement Engine,
 * Permission Engine, and UI Capability Resolution remain separate
 * responsibilities." `tags` (which migrations run) and `roleModuleCodes`
 * (which role templates seed) are exactly that seam — both already
 * caller-supplied, never resolved internally. This service consumes a
 * resolved package/entitlement profile; it does not compute one, and
 * does not fuse Package Engine and Company Engine into one mechanism.
 * The actual resolution (Package → Entitlement → Company Capability) is
 * Area 7's job, not built yet.
 */
@Injectable()
export class DatabaseProvisioningService {
  private readonly logger = new Logger(DatabaseProvisioningService.name);

  constructor(
    private readonly companyRegistry: CompanyRegistryService,
    private readonly databaseRegistry: DatabaseRegistryService,
    private readonly memberships: MembershipService,
    private readonly users: UsersService,
  ) {}

  /** Throws `NotFoundException` when the initial administrator does not exist. Lets a caller refuse BEFORE it allocates a database or creates a Company row. */
  async assertInitialAdminExists(userId: string): Promise<void> {
    await this.users.findById(userId);
  }

  async provision(params: ProvisionCompanyDatabaseParams): Promise<ProvisionCompanyDatabaseResult> {
    const company = await this.companyRegistry.findById(params.companyId);
    if (!company) {
      throw new Error(`Company not found: ${params.companyId}`);
    }

    // Retry/resume (proof point 6): if a registry row already exists for
    // this Company (a prior attempt), reuse it — updated to THIS call's
    // connection target, rather than silently proceeding on a stale value
    // from a prior failed attempt — instead of erroring on the unique
    // companyId constraint or creating a duplicate.
    let registry = await this.databaseRegistry.findByCompanyId(params.companyId);
    if (!registry) {
      registry = await this.databaseRegistry.register(
        { companyId: params.companyId, host: params.host, port: params.port, databaseName: params.databaseName, status: 'PROVISIONING' },
        JSON.stringify({ username: params.username, password: params.password }),
      );
    } else {
      registry = await this.databaseRegistry.updateConnection(registry.id, { host: params.host, port: params.port, databaseName: params.databaseName });
    }

    const databaseConfig = { host: params.host, port: params.port, username: params.username, password: params.password, database: params.databaseName };

    // Migrations (proof point 3 — invokes the existing pipeline, unmodified).
    const migrationResult = await runMigrationsForDatabase(params.appRoot, databaseConfig, params.tags);
    if (!migrationResult.success) {
      // Proof point 5: failure leaves a recoverable/quarantinable state —
      // FAILED is distinguishable from PROVISIONING/READY, and does not
      // touch the Company's own status (still PROVISIONING there).
      await this.databaseRegistry.markStatus(registry.id, 'FAILED');
      throw new ProvisioningFailedError('migrations', migrationResult.error ?? 'unknown migration failure');
    }

    // Company-specific authorization schema adjustment (ADR-073, CTO
    // Decision: Option D, 2026-09-25) — Company DB only, runs strictly
    // after Area 16's unmodified migration pipeline, before any grant is
    // attempted. See `company-authorization-schema-adjustment.ts` for the
    // full rationale.
    try {
      await applyCompanyAuthorizationSchemaAdjustment(databaseConfig);
    } catch (err) {
      await this.databaseRegistry.markStatus(registry.id, 'FAILED');
      throw new ProvisioningFailedError('authorization-schema-adjustment', err instanceof Error ? err.message : String(err));
    }

    // Role catalog seeding (Area 6) — must complete before Company
    // membership becomes active, per Area 6's own explicit invariant.
    // `seedCompanyAdminRole` (§3.1, 2026-09-24) runs in the same stage —
    // the 'admin' Role the initial-admin step below grants must exist in
    // this Company's own database first, exactly the same "role catalog
    // before membership" ordering Area 6 already established.
    let roleSeedResult: CompanyRoleSeedResult;
    try {
      roleSeedResult = await seedCompanyRoleTemplates(databaseConfig, params.roleModuleCodes ?? []);
      if (params.administratorRole === 'company_admin') await seedCompanyAdministratorRole(databaseConfig);
      else await seedCompanyAdminRole(databaseConfig, params.roleModuleCodes ?? []);
    } catch (err) {
      await this.databaseRegistry.markStatus(registry.id, 'FAILED');
      throw new ProvisioningFailedError('role-seeding', err instanceof Error ? err.message : String(err));
    }

    // Entitlement (Area 7) — optional, explicit provisioning input; skipped entirely if not supplied.
    let entitlementApplied = false;
    if (params.entitlementManifest && params.entitlementSignature && params.entitlementOptions) {
      try {
        await applyEntitlementManifestToCompany(databaseConfig, params.entitlementManifest, params.entitlementSignature, params.entitlementOptions);
        entitlementApplied = true;
      } catch (err) {
        await this.databaseRegistry.markStatus(registry.id, 'FAILED');
        throw new ProvisioningFailedError('entitlement', err instanceof Error ? err.message : String(err));
      }
    }

    // Create initial admin (Area 20, 2026-09-24, D1/D3/D7 decisions) —
    // mandatory, gates READY. D1: `initialAdminUserId` must already exist
    // (`UsersService.findById` throws `NotFoundException` otherwise).
    // Retry-safe like every other stage: reuses an existing Membership
    // row instead of erroring on the unique (userId, companyId) index if
    // a prior attempt already got this far (same "Retry/resume" pattern
    // as the registry reuse above). Opens its OWN ephemeral connection
    // against `databaseConfig` — the same established pattern every other
    // stage in this method already uses — rather than
    // `CompanyMembershipProvisioningService`/`CompanyConnectionManagerService`,
    // which require the registry to already be `'ACTIVE'` (not true yet
    // at this point in the sequence).
    const adminRoleKey = params.administratorRole === 'company_admin' ? COMPANY_ADMIN_ROLE_KEY : ADMIN_ROLE_KEY;
    let initialAdmin: Membership;
    try {
      await this.users.findById(params.initialAdminUserId);
      initialAdmin =
        (await this.memberships.findByUserAndCompany(params.initialAdminUserId, params.companyId)) ??
        (await this.memberships.create({ userId: params.initialAdminUserId, companyId: params.companyId, roleKey: adminRoleKey }));

      // `entities` must be listed explicitly — this is a one-off raw DataSource (the Company
      // isn't pooled via CompanyConnectionManagerService yet at provisioning time), not
      // AppModule's TypeOrmModule.forRoot, which registers entities automatically. Real cause
      // of a 2026-09-25 Real-Postgres finding (Area 4 verification): `provisionUserRoleForMembership`
      // needs `Role`/`UserRole` repositories, which cannot resolve metadata without this.
      const adminDataSource = new DataSource({ type: 'postgres', ...databaseConfig, synchronize: false, logging: false, entities: [Role, UserRole] });
      try {
        await adminDataSource.initialize();
        await provisionUserRoleForMembership(adminDataSource, params.initialAdminUserId, adminRoleKey);
      } finally {
        if (adminDataSource.isInitialized) {
          await adminDataSource.destroy();
        }
      }
    } catch (err) {
      await this.databaseRegistry.markStatus(registry.id, 'FAILED');
      throw new ProvisioningFailedError('initial-admin', err instanceof Error ? err.message : String(err));
    }

    // Health check (reuses ReleaseHealthCheckService unmodified against the Company's own connection).
    const healthCheckDataSource = new DataSource({ type: 'postgres', ...databaseConfig, synchronize: false, logging: false });
    let healthCheck: ReleaseHealthCheckResult;
    try {
      await healthCheckDataSource.initialize();
      healthCheck = await new ReleaseHealthCheckService(healthCheckDataSource).check();
    } catch (err) {
      // A health check that cannot even run is a failed stage like any other: FAILED (resumable), never left looking like an attempt still in progress.
      await this.databaseRegistry.markStatus(registry.id, 'FAILED');
      throw new ProvisioningFailedError('health-check', err instanceof Error ? err.message : String(err));
    } finally {
      if (healthCheckDataSource.isInitialized) {
        await healthCheckDataSource.destroy();
      }
    }

    if (!healthCheck.ok) {
      await this.databaseRegistry.markStatus(registry.id, 'FAILED');
      throw new ProvisioningFailedError('health-check', JSON.stringify(healthCheck.detail));
    }

    await this.databaseRegistry.markStatus(registry.id, 'ACTIVE');
    await this.companyRegistry.transitionTo(params.companyId, 'READY');

    return { registry, migratedNames: migrationResult.ranMigrationNames, roleSeedResult, entitlementApplied, initialAdmin, healthCheck, readyMarked: true };
  }
}
