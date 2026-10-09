import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO Decision 3 (2026-10-07) + CTO ruling B1 (2026-10-08, Option B) — the Company administration role (`company_admin`) manages Organization and, through it,
 * Scopes, through the Company ADMINISTRATION node `core.company.organization.manage` (never a workflow `wf.*` node). Additive and idempotent: grants that node
 * to an EXISTING `company_admin` role (new Companies receive it when the role is seeded). A database without the role is untouched.
 * (Before ruling B1 this migration granted `wf.core.organization.manage`; it was never released. Databases that ran that version are reclassified by
 * `1790013000000-ReclassifyOrganizationAdministration`.)
 */
export class CompanyAdminOrganizationNode1790012000000 implements MigrationInterface {
  name = 'CompanyAdminOrganizationNode1790012000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasTables = await queryRunner.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'role_permissions'`);
    if (!hasTables.length) return;
    await queryRunner.query(
      `INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
       SELECT r."id", 'core.company.organization.manage', 'editable' FROM "roles" r WHERE r."key" = 'company_admin'
       ON CONFLICT ("roleId", "nodeKey") DO NOTHING`,
    );
  }

  public async down(): Promise<void> {
    // additive-only (Blueprint §25)
  }
}
