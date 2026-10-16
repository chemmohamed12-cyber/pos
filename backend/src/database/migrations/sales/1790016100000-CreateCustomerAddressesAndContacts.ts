import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer profile (master-data gap matrix §5.3, M5) — `customer_addresses` and `customer_contacts`, the same shape as the supplier tables
 * plus `isBilling` / `isShipping` on addresses. New tables only: the legacy single `address` / `governorate` on `customers` stays and
 * remains what is shown until the user adds addresses (D-MD6, no backfill). The FK is RESTRICT (customers are never deleted; a profile row
 * must not silently vanish with its customer). One default address and one primary contact per customer are enforced by partial unique
 * indexes, so the rule holds even under concurrent writes. `down` drops both tables.
 */
export class CreateCustomerAddressesAndContacts1790016100000 implements MigrationInterface {
  name = 'CreateCustomerAddressesAndContacts1790016100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "customer_addresses" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "customerId" UUID NOT NULL REFERENCES "customers"("id"),
        "label" VARCHAR(128),
        "addressLine" VARCHAR(500) NOT NULL,
        "city" VARCHAR(128),
        "governorate" VARCHAR(128),
        "isDefault" BOOLEAN NOT NULL DEFAULT false,
        "isBilling" BOOLEAN NOT NULL DEFAULT false,
        "isShipping" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_customer_addresses_customer" ON "customer_addresses" ("customerId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_customer_addresses_default" ON "customer_addresses" ("customerId") WHERE "isDefault"`);

    await queryRunner.query(`
      CREATE TABLE "customer_contacts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "customerId" UUID NOT NULL REFERENCES "customers"("id"),
        "name" VARCHAR(255) NOT NULL,
        "title" VARCHAR(128),
        "phone" VARCHAR(32),
        "email" VARCHAR(255),
        "isPrimary" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_customer_contacts_customer" ON "customer_contacts" ("customerId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_customer_contacts_primary" ON "customer_contacts" ("customerId") WHERE "isPrimary"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_contacts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_addresses"`);
  }
}
