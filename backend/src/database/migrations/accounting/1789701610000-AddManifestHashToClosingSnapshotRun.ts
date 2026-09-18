import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-051 §11 (Month-End Closing / Black Box, Phase 5). Small follow-up to
 * `CreateClosingSnapshotRunTable` (already executed) rather than editing
 * and reverting it — this project's migrations are forward-only, never
 * auto-synced. Stores the full signed manifest's own hash directly, so
 * chaining a future reclose's `previousManifestHash` never needs to
 * re-read a file.
 */
export class AddManifestHashToClosingSnapshotRun1789701610000 implements MigrationInterface {
  name = 'AddManifestHashToClosingSnapshotRun1789701610000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounting_closing_snapshot_runs" ADD COLUMN "manifestHash" VARCHAR(128)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounting_closing_snapshot_runs" DROP COLUMN "manifestHash"`);
  }
}
