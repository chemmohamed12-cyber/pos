import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F01 — Financial Foundation (ADR-032). `accounting`'s foundation tables —
 * all owned exclusively by `accounting` (zero cross-module reference in
 * either direction), so no `to_regclass` guard is needed here (same
 * reasoning as `hr`'s `CreateHrTables` migration). Purely additive; does
 * not touch `treasury`/`customer-finance` (`finance`) in any way.
 */
export class CreateAccountingTables1755854400000 implements MigrationInterface {
  name = 'CreateAccountingTables1755854400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_currencies" (
        "code" VARCHAR(3) PRIMARY KEY,
        "name" VARCHAR(64) NOT NULL,
        "symbol" VARCHAR(8) NOT NULL,
        "decimalPlaces" INT NOT NULL DEFAULT 2,
        "roundingMode" VARCHAR(16) NOT NULL DEFAULT 'half_up',
        "roundingIncrement" NUMERIC(18,8),
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "isBaseCurrency" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // "exactly one base currency" — a partial unique index catches any
    // future bypass of the service-layer check (belt-and-suspenders).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_currencies_one_base" ON "accounting_currencies" ("isBaseCurrency") WHERE "isBaseCurrency" = true`,
    );

    await queryRunner.query(`
      CREATE TABLE "accounting_exchange_rates" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "currencyCode" VARCHAR(3) NOT NULL,
        "rateDate" DATE NOT NULL,
        "rate" NUMERIC(18,8) NOT NULL,
        "rateSource" VARCHAR(16) NOT NULL DEFAULT 'manual',
        "createdByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_exchange_rates_currency_date" ON "accounting_exchange_rates" ("currencyCode", "rateDate")`);

    await queryRunner.query(`
      CREATE TABLE "accounting_fiscal_years" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(16) NOT NULL,
        "startDate" DATE NOT NULL,
        "endDate" DATE NOT NULL,
        "orgUnitId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_accounting_fiscal_years_code" ON "accounting_fiscal_years" ("code")`);

    await queryRunner.query(`
      CREATE TABLE "accounting_fiscal_periods" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fiscalYearId" UUID NOT NULL,
        "code" VARCHAR(16) NOT NULL,
        "startDate" DATE NOT NULL,
        "endDate" DATE NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_fiscal_periods_fiscalYearId" ON "accounting_fiscal_periods" ("fiscalYearId")`);

    await queryRunner.query(`
      CREATE TABLE "accounting_tax_codes" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(128) NOT NULL,
        "rate" NUMERIC(6,3) NOT NULL,
        "isInclusive" BOOLEAN NOT NULL DEFAULT false,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "accountMappingRef" VARCHAR(64),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_accounting_tax_codes_code" ON "accounting_tax_codes" ("code")`);

    await queryRunner.query(`
      CREATE TABLE "accounting_financial_dimension_types" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(128) NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_financial_dimension_types_code" ON "accounting_financial_dimension_types" ("code")`,
    );

    await queryRunner.query(`
      CREATE TABLE "accounting_financial_dimension_values" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "dimensionTypeId" UUID NOT NULL,
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(128) NOT NULL,
        "orgUnitId" UUID,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_financial_dimension_values_type_code" ON "accounting_financial_dimension_values" ("dimensionTypeId", "code")`,
    );

    await queryRunner.query(`
      CREATE TABLE "accounting_processed_events" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "eventType" VARCHAR(128) NOT NULL,
        "eventIdempotencyKey" VARCHAR(255) NOT NULL,
        "processedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "resultSummary" JSONB
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_processed_events_type_key" ON "accounting_processed_events" ("eventType", "eventIdempotencyKey")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_processed_events"`);
    await queryRunner.query(`DROP TABLE "accounting_financial_dimension_values"`);
    await queryRunner.query(`DROP TABLE "accounting_financial_dimension_types"`);
    await queryRunner.query(`DROP TABLE "accounting_tax_codes"`);
    await queryRunner.query(`DROP TABLE "accounting_fiscal_periods"`);
    await queryRunner.query(`DROP TABLE "accounting_fiscal_years"`);
    await queryRunner.query(`DROP TABLE "accounting_exchange_rates"`);
    await queryRunner.query(`DROP TABLE "accounting_currencies"`);
  }
}
