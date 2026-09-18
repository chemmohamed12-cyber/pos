import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-051 (Month-End Closing / Black Box, Phase 1). Append-only registry of
 * Ed25519 public keys used to sign Closing Snapshot manifests. No `DELETE`
 * or `UPDATE` grant is exercised anywhere in application code against this
 * table — rows are inserted once and never modified, matching
 * `audit_records`' own append-only discipline. Purely additive.
 */
export class CreateClosingSnapshotSigningKeyTable1789701300000 implements MigrationInterface {
  name = 'CreateClosingSnapshotSigningKeyTable1789701300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_closing_snapshot_signing_keys" (
        "kid" VARCHAR(64) PRIMARY KEY,
        "publicKey" VARCHAR(256) NOT NULL,
        "validFrom" TIMESTAMPTZ NOT NULL,
        "validUntil" TIMESTAMPTZ,
        "createdByUserId" UUID NOT NULL,
        "reason" VARCHAR(256) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_closing_snapshot_signing_keys"`);
  }
}
