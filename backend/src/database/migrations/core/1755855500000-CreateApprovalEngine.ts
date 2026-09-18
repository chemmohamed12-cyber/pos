import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FA-01 — Generic Approval / Maker-Checker Foundation.
 * `architecture/APPROVAL_ENGINE_CONTRACT.md`, ADR-033,
 * `planning/foundation-approval-engine/FA-01_APPROVAL_ENGINE_BLUEPRINT.md`.
 *
 * `core` tag (ADR-025) — same as `CreateConfigurationEngine` /
 * `CreateEntitlement` / `CreateLimitEngine`: the Approval Engine is
 * Platform-Core, not a business module, so its tables are `core`, not a
 * new migration tag.
 *
 * Creates the 4 contract entities. Grants `admin` 'editable' at
 * `core.approval` so `core.approval.view` / `core.approval.manage`
 * resolve via the Permission Engine's ancestor-chain walk — same pattern
 * as `core.config` / `core.limit`. (`core.*` is a grandfathered node
 * prefix, ADR-024 §3.3 — no manifest entry needed; a Read-Before-Write
 * correction to the Blueprint §11.4's `system.approval.*`, since only
 * `system.release.*` — not all `system.*` — is grandfathered.)
 *
 * Purely additive; no existing table altered. `down()` drops all 4.
 */
export class CreateApprovalEngine1755855500000 implements MigrationInterface {
  name = 'CreateApprovalEngine1755855500000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['perm.core.approval', 'permission', 'الموافقات', 'Approvals'],
    ['nav.approvals', 'nav', 'الموافقات', 'Approvals'],
    ['field.request_type', 'field', 'نوع الطلب', 'Request Type'],
    ['field.min_approvers', 'field', 'الحد الأدنى للموافقين', 'Minimum Approvers'],
    ['field.required_permission_node', 'field', 'صلاحية المُراجِع المطلوبة', 'Required Checker Permission'],
    ['field.value_threshold', 'field', 'حد القيمة', 'Value Threshold'],
    ['field.approval_decision', 'field', 'القرار', 'Decision'],
    ['value.approval_decision.approved', 'field', 'موافقة', 'Approved'],
    ['value.approval_decision.rejected', 'field', 'رفض', 'Rejected'],
    ['action.approval_matrix_add', 'action', 'إضافة قاعدة موافقة', 'Add Approval Rule'],
    ['action.approval_matrix_edit', 'action', 'تعديل قاعدة موافقة', 'Edit Approval Rule'],
    ['action.approval_withdraw', 'action', 'سحب الطلب', 'Withdraw Request'],
    ['action.approval_escalate', 'action', 'تصعيد الطلب', 'Escalate Request'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "approval_request_types" (
        "requestTypeCode" VARCHAR(128) PRIMARY KEY,
        "titleCode" VARCHAR(128) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "approval_matrix_rules" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "requestTypeCode" VARCHAR(128) NOT NULL,
        "minApprovers" INT NOT NULL DEFAULT 1,
        "requiredPermissionNode" VARCHAR(255) NOT NULL,
        "valueThreshold" NUMERIC(20,4),
        "orgUnitId" UUID,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_approval_matrix_rules_min_approvers" CHECK ("minApprovers" >= 1)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_approval_matrix_rules_type_active" ON "approval_matrix_rules" ("requestTypeCode", "isActive")`,
    );

    await queryRunner.query(`
      CREATE TABLE "approval_requests" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "requestTypeCode" VARCHAR(128) NOT NULL,
        "resourceType" VARCHAR(64) NOT NULL,
        "resourceId" VARCHAR(64) NOT NULL,
        "requestedAction" VARCHAR(64) NOT NULL,
        "payload" JSONB NOT NULL,
        "makerUserId" UUID NOT NULL,
        "processInstanceId" UUID,
        "resolvedMinApprovers" INT NOT NULL,
        "resolvedRequiredNode" VARCHAR(255) NOT NULL,
        "orgUnitId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "decidedAt" TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_approval_requests_type" ON "approval_requests" ("requestTypeCode")`);
    await queryRunner.query(`CREATE INDEX "IDX_approval_requests_maker" ON "approval_requests" ("makerUserId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_approval_requests_resource" ON "approval_requests" ("resourceType", "resourceId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "approval_decisions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "approvalRequestId" UUID NOT NULL,
        "approverUserId" UUID NOT NULL,
        "decision" VARCHAR(8) NOT NULL,
        "note" VARCHAR(512),
        "decidedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_approval_decisions_decision" CHECK ("decision" IN ('approved','rejected'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_approval_decisions_request_approver" ON "approval_decisions" ("approvalRequestId", "approverUserId")`,
    );

    await queryRunner.query(`
      INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
      SELECT "id", 'core.approval', 'editable' FROM "roles" WHERE "key" = 'admin'
      ON CONFLICT DO NOTHING
    `);

    for (const [code, category, ar, en] of this.terminology) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.terminology.map(([code]) => code)]);
    await queryRunner.query(
      `DELETE FROM "role_permissions" WHERE "nodeKey" = 'core.approval' AND "roleId" = (SELECT "id" FROM "roles" WHERE "key" = 'admin')`,
    );
    await queryRunner.query(`DROP TABLE "approval_decisions"`);
    await queryRunner.query(`DROP TABLE "approval_requests"`);
    await queryRunner.query(`DROP TABLE "approval_matrix_rules"`);
    await queryRunner.query(`DROP TABLE "approval_request_types"`);
  }
}
