import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization Foundation F3 (Roles, Templates, Taxonomy). ADDITIVE and idempotent; no role is renamed, no grant is removed, no member loses anything.
 *
 *  1. `roles` gains the role metadata (Blueprint §6): `type` (system | template | custom | legacy), `templateKey` / `templateVersion` (the catalog version the
 *     role was cloned at), `templateIgnoredVersion` ("ignore this update" is remembered), `isActive`, bilingual name/description, `updatedAt`, `createdBy`.
 *     Existing rows are classified from their KEY only: the 20 catalog template keys -> `template`@v1; the pre-template flat keys that business logic
 *     still checks by name and the existing `admin` -> `legacy` (D17: `admin` is kept verbatim and relabelled "Legacy Administrator (Operational)");
 *     everything else -> `custom`. `customized` stays NULL (= not evaluated yet): the role service evaluates a template role's grants against the template the first time it reads it and persists the answer; the role editor keeps it current.
 *  2. Every existing `admin` role receives `core.company.roles.manage` (editable), the node that guards the new role-management surface — the same
 *     behaviour-preserving compatibility grant the F2 members node got: administrators keep exactly the administration they had, plus the new screen.
 *
 * The `core` tag also runs on the control-plane database (ambient `roles`) and is inert there beyond the added columns.
 */
export class RoleMetadataAndRolesManageNode1790005000000 implements MigrationInterface {
  name = 'RoleMetadataAndRolesManageNode1790005000000';

  private readonly templateKeys = [
    'sales.manager', 'sales.rep', 'sales.viewer', 'inventory.manager', 'inventory.operator', 'inventory.viewer', 'logistics.manager', 'logistics.dispatcher',
    'logistics.viewer', 'finance.manager', 'finance.clerk', 'finance.viewer', 'reporting.analyst', 'hr.manager', 'hr.viewer', 'manufacturing.manager',
    'manufacturing.operator', 'manufacturing.viewer', 'accounting.manager', 'accounting.viewer',
  ];
  private readonly legacyKeys = ['admin', 'driver', 'finance', 'inventory_controller', 'sales_manager', 'sales_rep', 'sales_supervisor', 'warehouse_supervisor', 'warehouse_worker'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'roles')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'roles' AND column_name = 'type') THEN
          ALTER TABLE "roles"
            ADD COLUMN "type" VARCHAR(16) NOT NULL DEFAULT 'custom',
            ADD COLUMN "templateKey" VARCHAR(64) NULL,
            ADD COLUMN "templateVersion" INTEGER NULL,
            ADD COLUMN "templateIgnoredVersion" INTEGER NULL,
            ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN "customized" BOOLEAN NULL,
            ADD COLUMN "nameAr" VARCHAR(120) NULL,
            ADD COLUMN "nameEn" VARCHAR(120) NULL,
            ADD COLUMN "descriptionAr" TEXT NULL,
            ADD COLUMN "descriptionEn" TEXT NULL,
            ADD COLUMN "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
            ADD COLUMN "createdBy" UUID NULL;
          ALTER TABLE "roles" ADD CONSTRAINT "CHK_roles_type" CHECK ("type" IN ('system','template','custom','legacy'));
          UPDATE "roles" SET "type" = 'template', "templateKey" = "key", "templateVersion" = 1 WHERE "key" = ANY($1::text[]);
          UPDATE "roles" SET "type" = 'legacy' WHERE "key" = ANY($2::text[]);
          UPDATE "roles" SET "nameEn" = 'Legacy Administrator (Operational)', "nameAr" = 'مدير تشغيلي (قديم)',
                 "descriptionEn" = 'Pre-existing administrator role: manages the Company AND operates every entitled module. Kept unchanged so no one loses access; narrow it deliberately.',
                 "descriptionAr" = 'دور المدير القديم: يدير الشركة ويشغّل كل الوحدات المتاحة. محفوظ كما هو حتى لا يفقد أحد صلاحياته؛ يمكن تضييقه بقرار واعٍ.'
           WHERE "key" = 'admin';
        END IF;
      END $$;
    `.replace('$1::text[]', `ARRAY[${this.templateKeys.map((k) => `'${k}'`).join(',')}]::text[]`).replace('$2::text[]', `ARRAY[${this.legacyKeys.map((k) => `'${k}'`).join(',')}]::text[]`));

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'role_permissions') THEN
          INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
          SELECT r."id", 'core.company.roles.manage', 'editable' FROM "roles" r WHERE r."key" = 'admin'
          ON CONFLICT ("roleId", "nodeKey") DO NOTHING;
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Additive-only (Blueprint §25): the columns are inert for pre-F3 code; the new grant removes nothing.
  }
}
