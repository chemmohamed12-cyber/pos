import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization Foundation F4 — support access as a time-boxed membership. ADDITIVE and idempotent: `user_company_memberships` gains `kind`
 * (`member` | `support`), `expiresAt`, `reason`, `grantedBy`. Every existing row stays `kind='member'`, no expiry (nothing loses access). A `support` membership
 * is the platform user's explicit, reason-required, time-boxed entry into ONE Company with a limited role; the access guards treat an expired row exactly like a
 * missing one, so there is no standing back door.
 */
export class SupportAccessMemberships1790007000000 implements MigrationInterface {
  name = 'SupportAccessMemberships1790007000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_company_memberships')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_company_memberships' AND column_name = 'kind') THEN
          ALTER TABLE "user_company_memberships"
            ADD COLUMN "kind" VARCHAR(16) NOT NULL DEFAULT 'member',
            ADD COLUMN "expiresAt" TIMESTAMPTZ NULL,
            ADD COLUMN "reason" TEXT NULL,
            ADD COLUMN "grantedBy" UUID NULL;
          ALTER TABLE "user_company_memberships" ADD CONSTRAINT "CHK_user_company_memberships_kind" CHECK ("kind" IN ('member','support'));
          ALTER TABLE "user_company_memberships" ADD CONSTRAINT "CHK_user_company_memberships_support_expiry" CHECK ("kind" = 'member' OR ("expiresAt" IS NOT NULL AND "reason" IS NOT NULL));
          CREATE INDEX "IDX_user_company_memberships_support_expiry" ON "user_company_memberships" ("expiresAt") WHERE "kind" = 'support';
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Additive-only (Blueprint §25): inert for pre-F4 code; defaults keep every row a normal member.
  }
}
