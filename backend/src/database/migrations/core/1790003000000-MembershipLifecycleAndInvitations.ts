import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization Foundation F2 (Company Users, invitations, multi-role). ADDITIVE and idempotent:
 *
 *  1. `user_company_memberships` gains the membership lifecycle (`status`, `joinedAt`, `invitedBy`, `lastAccessAt`, `authzVersion`).
 *     Every existing row becomes `status='active'` (nothing loses access) with `joinedAt` backfilled from `createdAt`, exactly once
 *     (only when the column is first created, so a re-run never overwrites a real join date). `roleKey` is KEPT as the read-only
 *     compatibility mirror of the Company DB's `user_roles` (the Company database is the authority).
 *  2. `company_invitations` — Company-owned invitations (control plane). Only the SHA-256 of the one-time token is stored. No identity and no
 *     membership exists until acceptance, so an invitation can never reveal or create an identity for an unknown e-mail.
 *  3. `membership_operations` gains `previousRoleKeys` / `targetRoleKeys` (jsonb) so the role-SET saga is recorded in the same durable ledger.
 *
 * The `core` tag also runs on Company databases (schema parity, like the existing membership tables); the new objects are inert there.
 */
export class MembershipLifecycleAndInvitations1790003000000 implements MigrationInterface {
  name = 'MembershipLifecycleAndInvitations1790003000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_company_memberships')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_company_memberships' AND column_name = 'joinedAt') THEN
          ALTER TABLE "user_company_memberships"
            ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'active',
            ADD COLUMN "joinedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
            ADD COLUMN "invitedBy" UUID NULL,
            ADD COLUMN "lastAccessAt" TIMESTAMPTZ NULL,
            ADD COLUMN "authzVersion" INTEGER NOT NULL DEFAULT 1;
          UPDATE "user_company_memberships" SET "joinedAt" = "createdAt";
          ALTER TABLE "user_company_memberships"
            ADD CONSTRAINT "CHK_user_company_memberships_status" CHECK ("status" IN ('invited','active','suspended','removed'));
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'membership_operations') THEN
          ALTER TABLE "membership_operations" ADD COLUMN IF NOT EXISTS "previousRoleKeys" JSONB NULL;
          ALTER TABLE "membership_operations" ADD COLUMN IF NOT EXISTS "targetRoleKeys" JSONB NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "company_invitations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" UUID NOT NULL,
        "email" VARCHAR(255) NOT NULL,
        "fullName" VARCHAR(255) NULL,
        "roleKeys" JSONB NOT NULL DEFAULT '[]',
        "tokenHash" CHAR(64) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
        "invitedBy" UUID NOT NULL,
        "deliveryMode" VARCHAR(16) NOT NULL DEFAULT 'manual',
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "acceptedAt" TIMESTAMPTZ NULL,
        "acceptedUserId" UUID NULL,
        "revokedAt" TIMESTAMPTZ NULL,
        CONSTRAINT "CHK_company_invitations_status" CHECK ("status" IN ('pending','accepted','revoked','expired'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_company_invitations_tokenHash" ON "company_invitations" ("tokenHash")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_company_invitations_company_status" ON "company_invitations" ("companyId", "status")`);
    // One live invitation per (Company, e-mail): a re-invite supersedes the previous one (the service revokes it first).
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_company_invitations_pending_email" ON "company_invitations" ("companyId", "email") WHERE "status" = 'pending'`);
  }

  public async down(): Promise<void> {
    // Intentionally a no-op: dropping the lifecycle columns / invitations would destroy invitation and join-date history. Additive-only
    // (Blueprint §25): rollback = stop using the columns; they are inert for the pre-F2 code (defaults keep every row active).
  }
}
