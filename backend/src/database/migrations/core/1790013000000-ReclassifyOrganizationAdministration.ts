import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO ruling B1 (2026-10-08, Option B) — Organization administration leaves the workflow namespace: the former workflow capability
 * `wf.core.organization.manage` becomes the Company ADMINISTRATION node `core.company.organization.manage` (the node the Organization write routes, the
 * navigation item and scope administration now require).
 *
 * Reclassification, not a new authority: every role that holds the old node receives the new node at the SAME access level, then the old rows are removed —
 * so no user gains or loses the ability (checked per role), and no role keeps a workflow node that no rule reads any more. `company_admin` therefore ends with
 * no `wf.*` node at all. Idempotent (re-running finds nothing to move). Inverse: `down()` moves the grants back (Blueprint §25: documented inverse).
 */
export class ReclassifyOrganizationAdministration1790013000000 implements MigrationInterface {
  name = 'ReclassifyOrganizationAdministration1790013000000';

  private async hasRolePermissions(queryRunner: QueryRunner): Promise<boolean> {
    return (await queryRunner.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'role_permissions'`)).length > 0;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasRolePermissions(queryRunner))) return;
    await this.move(queryRunner, 'wf.core.organization.manage', 'core.company.organization.manage');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasRolePermissions(queryRunner))) return;
    await this.move(queryRunner, 'core.company.organization.manage', 'wf.core.organization.manage');
  }

  /** Every holder of `from` gets `to` at the same access (an existing `to` grant keeps the higher of the two), then `from` is removed. */
  private async move(queryRunner: QueryRunner, from: string, to: string): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
       SELECT rp."roleId", $2, rp."access" FROM "role_permissions" rp WHERE rp."nodeKey" = $1
       ON CONFLICT ("roleId", "nodeKey") DO UPDATE SET "access" = CASE
         WHEN 'editable' IN ("role_permissions"."access", EXCLUDED."access") THEN 'editable'
         WHEN 'read-only' IN ("role_permissions"."access", EXCLUDED."access") THEN 'read-only'
         ELSE "role_permissions"."access" END`,
      [from, to],
    );
    await queryRunner.query(`DELETE FROM "role_permissions" WHERE "nodeKey" = $1`, [from]);
  }
}
