import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Compatibility shim, not an extension install. Four later migrations
 * (CreateTreasuryTables, AddTreasuryAccountTypeHierarchy,
 * AddReturnsEngineCustomerReturns, AddCustomerFinancialCore) call
 * `uuid_generate_v4()`, which normally comes from the `uuid-ossp`
 * extension — but nothing in this repository ever ran
 * `CREATE EXTENSION "uuid-ossp"` (a latent defect, unrelated to the
 * pgcrypto/hosting issue, that simply hadn't been reached yet). Since
 * `uuid-ossp` is equally unavailable on Namecheap Shared Stellar Plus
 * hosting (same missing-contrib-package cause as pgcrypto — see
 * PRODUCTION_DEPLOYMENT_GUIDE.md "UUID generation strategy"), this
 * defines `uuid_generate_v4()` as a thin SQL wrapper over the
 * PostgreSQL-core-native `gen_random_uuid()` (v13+, no extension). Both
 * produce a random (v4-format) UUID — functionally interchangeable for
 * every use in this codebase (primary key defaults only, never a
 * specific-version UUID requirement). This lets the four existing
 * migrations run completely unedited.
 */
export class UuidGenerateV4Compatibility1755840150000 implements MigrationInterface {
  name = 'UuidGenerateV4Compatibility1755840150000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION uuid_generate_v4()
      RETURNS uuid
      AS $$
        SELECT gen_random_uuid();
      $$
      LANGUAGE sql VOLATILE;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS uuid_generate_v4()`);
  }
}
