import { MigrationInterface, QueryRunner } from 'typeorm';

/** File / Media Abstraction — Stage 2 build-order item 19. */
export class CreateMediaAssets1755841400000 implements MigrationInterface {
  name = 'CreateMediaAssets1755841400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "media_assets" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "storageKey" VARCHAR(512) NOT NULL,
        "originalFilename" VARCHAR(255) NOT NULL,
        "contentType" VARCHAR(128) NOT NULL,
        "sizeBytes" INT NOT NULL,
        "uploadedByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_media_assets_uploadedByUserId" ON "media_assets" ("uploadedByUserId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "media_assets"`);
  }
}
