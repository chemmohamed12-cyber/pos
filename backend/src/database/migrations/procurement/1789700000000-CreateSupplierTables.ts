import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `procurement`-tagged (ADR-025 migration-partition convention), the
 * first migration of the new Procurement domain (ADR-048 — promoted from
 * reserved to built). Supplier is the aggregate root: Contacts/Addresses/
 * BankAccounts are child tables, never denormalized onto Supplier itself.
 *
 * No currency/legal-entity column anywhere here — the Foundation-gate
 * audit (ADR-048) confirmed no Legal Entity concept exists and every
 * operational subledger this eventually posts against hardcodes 'EGP';
 * `orgUnitId` follows the proven nullable-scope convention from
 * `treasury_accounts`/`journal_entries` (ADR-031) instead of inventing a
 * new one.
 */
export class CreateSupplierTables1789700000000 implements MigrationInterface {
  name = 'CreateSupplierTables1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "suppliers" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "legalName" VARCHAR(255) NOT NULL,
        "tradingName" VARCHAR(255),
        "supplierType" VARCHAR(16) NOT NULL DEFAULT 'company',
        "taxRegistrationNumber" VARCHAR(64),
        "vatRegistrationNumber" VARCHAR(64),
        "commercialRegistrationNumber" VARCHAR(64),
        "paymentTermsDays" INT NOT NULL DEFAULT 0,
        "creditLimitBase" NUMERIC(18,2),
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "orgUnitId" UUID,
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_suppliers_type" CHECK ("supplierType" IN ('company','individual')),
        CONSTRAINT "CHK_suppliers_status" CHECK ("status" IN ('active','inactive'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_suppliers_code" ON "suppliers" ("code")`);
    await queryRunner.query(`CREATE INDEX "IDX_suppliers_org_unit" ON "suppliers" ("orgUnitId")`);

    await queryRunner.query(`
      CREATE TABLE "supplier_contacts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
        "name" VARCHAR(255) NOT NULL,
        "title" VARCHAR(128),
        "phone" VARCHAR(32),
        "email" VARCHAR(255),
        "isPrimary" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_contacts_supplier" ON "supplier_contacts" ("supplierId")`);

    await queryRunner.query(`
      CREATE TABLE "supplier_addresses" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
        "label" VARCHAR(128),
        "addressLine" VARCHAR(500) NOT NULL,
        "city" VARCHAR(128),
        "governorate" VARCHAR(128),
        "isDefault" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_addresses_supplier" ON "supplier_addresses" ("supplierId")`);

    await queryRunner.query(`
      CREATE TABLE "supplier_bank_accounts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
        "bankName" VARCHAR(255) NOT NULL,
        "accountNumber" VARCHAR(64) NOT NULL,
        "iban" VARCHAR(64),
        "swift" VARCHAR(16),
        "isPrimary" BOOLEAN NOT NULL DEFAULT false,
        "approvalStatus" VARCHAR(16) NOT NULL DEFAULT 'pending',
        "approvalRequestId" UUID,
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_supplier_bank_accounts_approval_status" CHECK ("approvalStatus" IN ('pending','approved','rejected'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_bank_accounts_supplier" ON "supplier_bank_accounts" ("supplierId")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_bank_accounts_approval_request" ON "supplier_bank_accounts" ("approvalRequestId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "supplier_bank_accounts"`);
    await queryRunner.query(`DROP TABLE "supplier_addresses"`);
    await queryRunner.query(`DROP TABLE "supplier_contacts"`);
    await queryRunner.query(`DROP TABLE "suppliers"`);
  }
}
