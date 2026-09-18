import { MigrationInterface, QueryRunner } from 'typeorm';

/** Localization — Stage 2 build-order item 16 (paired with Terminology). */
export class CreateUserLocalePreferences1755841100000 implements MigrationInterface {
  name = 'CreateUserLocalePreferences1755841100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_locale_preferences" (
        "userId" UUID PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
        "language" VARCHAR(2) NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_locale_preferences"`);
  }
}
