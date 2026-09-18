import { MigrationInterface, QueryRunner } from 'typeorm';

/** Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — descriptive unit label for the Inventory Grid. */
export class AddProductUnit1755847500000 implements MigrationInterface {
  name = 'AddProductUnit1755847500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "products" ADD COLUMN "unit" VARCHAR(32)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "unit"`);
  }
}
