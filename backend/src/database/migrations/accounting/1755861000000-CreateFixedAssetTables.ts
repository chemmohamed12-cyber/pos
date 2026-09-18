import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F12 — Fixed Assets (ADR-045, CTO-approved 2026-09-12). Purely additive — 5 new tables, no change to
 * any existing table. `fixed_asset` itself needs no migration (`GLAccount.controlFunction` is already
 * `varchar(24)`, the `ControlFunction` union gains the value in code only).
 *
 * `UQ_..._acquisition_journal` (nullable-unique) and `UQ_..._asset_period` are the two binding
 * architecture invariants ADR-045 D2/D7 (Mandatory Correction #3) require at the DATABASE level, not
 * application logic alone — the same discipline this track has followed since F02's own CHECK
 * constraints.
 */
export class CreateFixedAssetTables1755861000000 implements MigrationInterface {
  name = 'CreateFixedAssetTables1755861000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_fixed_asset_category_account_mappings" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "categoryDimensionValueId" UUID NOT NULL,
        "defaultCostAccountId" UUID NOT NULL,
        "defaultAccumulatedDepreciationAccountId" UUID NOT NULL,
        "defaultDepreciationExpenseAccountId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_accounting_fixed_asset_category_mappings_category" ON "accounting_fixed_asset_category_account_mappings" ("categoryDimensionValueId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "accounting_fixed_assets" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(160) NOT NULL,
        "categoryDimensionValueId" UUID,
        "acquisitionDate" DATE NOT NULL,
        "cost" NUMERIC(20,4) NOT NULL,
        "salvageValue" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "usefulLifeMonths" INT NOT NULL,
        "depreciationMethod" VARCHAR(24) NOT NULL,
        "depreciableBase" NUMERIC(20,4) NOT NULL,
        "costAccountId" UUID NOT NULL,
        "accumulatedDepreciationAccountId" UUID NOT NULL,
        "depreciationExpenseAccountId" UUID NOT NULL,
        "orgUnitId" UUID,
        "acquisitionJournalEntryId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_accounting_fixed_assets_salvage_le_cost" CHECK ("salvageValue" <= "cost"),
        CONSTRAINT "CHK_accounting_fixed_assets_useful_life_positive" CHECK ("usefulLifeMonths" > 0),
        CONSTRAINT "CHK_accounting_fixed_assets_depreciation_method" CHECK ("depreciationMethod" IN ('straight_line'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_accounting_fixed_assets_code" ON "accounting_fixed_assets" ("code")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_fixed_assets_cost_account" ON "accounting_fixed_assets" ("costAccountId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_accounting_fixed_assets_accum_dep_account" ON "accounting_fixed_assets" ("accumulatedDepreciationAccountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_accounting_fixed_assets_dep_expense_account" ON "accounting_fixed_assets" ("depreciationExpenseAccountId")`,
    );
    // ADR-045 D7, Mandatory Correction #3 — the SAME JournalEntry can never fund two different assets.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_accounting_fixed_assets_acquisition_journal" ON "accounting_fixed_assets" ("acquisitionJournalEntryId") WHERE "acquisitionJournalEntryId" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "accounting_depreciation_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "depreciationPeriod" VARCHAR(7) NOT NULL,
        "businessDate" DATE NOT NULL,
        "createdBy" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_depreciation_runs_period" ON "accounting_depreciation_runs" ("depreciationPeriod")`);

    await queryRunner.query(`
      CREATE TABLE "accounting_depreciation_run_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "depreciationRunId" UUID NOT NULL,
        "fixedAssetId" UUID NOT NULL,
        "depreciationPeriod" VARCHAR(7) NOT NULL,
        "openingNetBookValue" NUMERIC(20,4) NOT NULL,
        "depreciableBase" NUMERIC(20,4) NOT NULL,
        "calculatedAmount" NUMERIC(20,4) NOT NULL,
        "resultingAccumulatedDepreciation" NUMERIC(20,4) NOT NULL,
        "resultingNetBookValue" NUMERIC(20,4) NOT NULL,
        "journalEntryId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_depreciation_run_lines_run" ON "accounting_depreciation_run_lines" ("depreciationRunId")`);
    // ADR-045 D2 — THE binding idempotency invariant: one posted charge per (asset, period), ever.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_accounting_depreciation_run_lines_asset_period" ON "accounting_depreciation_run_lines" ("fixedAssetId", "depreciationPeriod")`,
    );

    await queryRunner.query(`
      CREATE TABLE "accounting_fixed_asset_disposals" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "fixedAssetId" UUID NOT NULL,
        "disposalDate" DATE NOT NULL,
        "proceeds" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "proceedsAccountId" UUID,
        "gainLossAmount" NUMERIC(20,4),
        "approvalRequestId" UUID,
        "journalEntryId" UUID,
        "createdBy" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_accounting_fixed_asset_disposals_proceeds_account" CHECK ("proceeds" = 0 OR "proceedsAccountId" IS NOT NULL)
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_fixed_asset_disposals_asset" ON "accounting_fixed_asset_disposals" ("fixedAssetId")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_accounting_fixed_asset_disposals_approval_request" ON "accounting_fixed_asset_disposals" ("approvalRequestId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_fixed_asset_disposals"`);
    await queryRunner.query(`DROP TABLE "accounting_depreciation_run_lines"`);
    await queryRunner.query(`DROP TABLE "accounting_depreciation_runs"`);
    await queryRunner.query(`DROP TABLE "accounting_fixed_assets"`);
    await queryRunner.query(`DROP TABLE "accounting_fixed_asset_category_account_mappings"`);
  }
}
