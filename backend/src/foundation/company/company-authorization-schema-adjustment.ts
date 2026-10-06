import { DataSource } from 'typeorm';
import { DatabaseConfig } from '../configuration/app-config.service';

/**
 * Multi-Company Phase 3 V7 (2026-09-25, ADR-073 — CTO Decision: Approve
 * Candidate Option D). `user_roles.userId` in a Company's own database is a
 * Platform User identity REFERENCE, not a locally-owned identity — the
 * same posture Area 6 already established for `user_company_memberships.userId`
 * in the Platform DB (`CreateUserCompanyMemberships.ts` — no local FK, by
 * design, "staying within Area 6's own literal scope"). The single-database
 * migration pipeline Area 16 reuses unmodified for Company databases
 * (`runMigrationsForDatabase`) still creates `user_roles.userId REFERENCES
 * users(id)` — correct for the platform database that migration was
 * originally written for, structurally unsatisfiable for a Company
 * database, which never holds a `User` row (Model B: Platform DB is the
 * sole User identity authority; a Company database never gets a User
 * mirror/stub).
 *
 * Runs strictly AFTER Area 16's unmodified migration pipeline completes,
 * as a narrow, Company-DB-only, idempotent correction — no migration file
 * is touched, no migration tag changes, Area 16's migration runner is
 * untouched. Only ever called with a Company's own already-resolved
 * `DatabaseConfig` (never the ambient/platform config, never a
 * client-supplied `companyId` selecting a database directly) — the caller
 * (`DatabaseProvisioningService.provision`) is the only call site.
 *
 * Integrity is NOT weakened by removing this constraint: every real
 * caller into `provisionUserRoleForMembership`
 * (`DatabaseProvisioningService.provision`,
 * `CompanyMembershipProvisioningService.grantMembership`/
 * `changeMembershipRole`, and `MembershipReconciliationScheduler`'s replay,
 * which only replays an already-validated `Membership` row) already
 * validates the target `userId` against the Platform DB's own `User` via
 * `UsersService.findById` BEFORE any Company-DB write is attempted — the
 * Company-DB FK was a redundant, structurally-impossible duplicate of a
 * check already correctly performed where User identity actually lives,
 * not the only guarantee (ADR-073 §7.4).
 *
 * Area 21 extension (2026-10-05 — flagged for CTO ratification, same principle as Option D): ADR-073 §1 enumerated the
 * `core` tables only, and only `user_roles` was live then. Operational tables created by the domain migrations
 * (`sales_orders.salesRepUserId`, `customer_assignments`, `deposits`, `sales_rep_profiles`, the returns/delivery tables, ...)
 * carry the same `REFERENCES "users"(id)` and are now written through Company connections as the Area 21 retrofit closes —
 * so they hit the identical structurally-unsatisfiable constraint. Every foreign key that references `users(id)` is therefore
 * dropped in a Company database (found dynamically from the catalog, so a future migration cannot reintroduce the gap). Only
 * ever applied to a Company database; the platform database keeps all of them.
 */
export async function applyCompanyAuthorizationSchemaAdjustment(database: DatabaseConfig): Promise<void> {
  const dataSource = new DataSource({ type: 'postgres', ...database, synchronize: false, logging: false });
  await dataSource.initialize();
  try {
    await dataSource.query('ALTER TABLE "user_roles" DROP CONSTRAINT IF EXISTS "user_roles_userId_fkey"');
    const rows: Array<{ table_name: string; constraint_name: string }> = await dataSource.query(
      `SELECT cl.relname AS table_name, c.conname AS constraint_name
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
        WHERE c.contype = 'f' AND c.confrelid = to_regclass('public.users') AND ns.nspname = 'public'`,
    );
    for (const r of rows) {
      await dataSource.query(`ALTER TABLE "${r.table_name}" DROP CONSTRAINT IF EXISTS "${r.constraint_name}"`);
    }
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}
