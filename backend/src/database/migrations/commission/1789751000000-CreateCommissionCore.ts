import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-071 §5 — Commission Phase 1 core, entirely additive. `commission`
 * is a genuinely new module code, never previously reserved — not a
 * promotion.
 */
export class CreateCommissionCore1789751000000 implements MigrationInterface {
  name = 'CreateCommissionCore1789751000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "commission_policies" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "scope" VARCHAR(16) NOT NULL,
        "scopeRefId" UUID NOT NULL,
        "basis" VARCHAR(20) NOT NULL,
        "rateModel" VARCHAR(16) NOT NULL,
        "flatRate" NUMERIC(8,4),
        "effectiveFrom" TIMESTAMPTZ NOT NULL,
        "effectiveTo" TIMESTAMPTZ,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_commission_policies_scope" CHECK ("scope" IN ('sales_rep', 'customer', 'customer_group')),
        CONSTRAINT "CHK_commission_policies_basis" CHECK ("basis" IN ('gross_sales', 'net_sales', 'collected_amount')),
        CONSTRAINT "CHK_commission_policies_rateModel" CHECK ("rateModel" IN ('flat', 'target_tiered'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_commission_policies_scopeRefId" ON "commission_policies" ("scopeRefId")`);
    // ADR-068 §A — "exactly one ACTIVE policy per (scope, scopeRefId) at a time," the same
    // partial-unique-index pattern already used by attendance_employee_mappings/payroll_compensations.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_commission_policies_active_scope" ON "commission_policies" ("scope", "scopeRefId") WHERE "effectiveTo" IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "commission_tiers" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "policyId" UUID NOT NULL,
        "tierOrder" INT NOT NULL,
        "fromPercent" NUMERIC(5,2) NOT NULL,
        "toPercent" NUMERIC(5,2),
        "rate" NUMERIC(8,4) NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_commission_tiers_policyId" ON "commission_tiers" ("policyId")`);

    await queryRunner.query(`
      CREATE TABLE "commission_approval_batches" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "periodStart" DATE NOT NULL,
        "periodEnd" DATE NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
        "approvalRequestId" UUID,
        "createdByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "decidedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_commission_batches_status" CHECK ("status" IN ('draft', 'submitted', 'approved', 'rejected'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "commission_results" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "employeeId" UUID NOT NULL,
        "customerId" UUID NOT NULL,
        "customerGroupId" UUID,
        "sourceTransactionRefs" JSONB NOT NULL,
        "resolvedPolicyId" UUID NOT NULL,
        "policyScope" VARCHAR(16) NOT NULL,
        "calculationBasis" VARCHAR(20) NOT NULL,
        "targetPeriodId" UUID,
        "targetSnapshot" JSONB,
        "applicableTier" JSONB,
        "rate" NUMERIC(8,4) NOT NULL,
        "calculationInputs" JSONB NOT NULL,
        "calculatedAmount" NUMERIC(14,2) NOT NULL,
        "calculationTimestamp" TIMESTAMPTZ NOT NULL,
        "batchId" UUID,
        "triggerEventKey" VARCHAR(255) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_commission_results_employeeId" ON "commission_results" ("employeeId")`);
    await queryRunner.query(`CREATE INDEX "IDX_commission_results_customerId" ON "commission_results" ("customerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_commission_results_batchId" ON "commission_results" ("batchId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_commission_results_triggerEventKey" ON "commission_results" ("triggerEventKey")`);

    await queryRunner.query(`
      CREATE TABLE "commission_adjustments" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "originalCommissionResultId" UUID NOT NULL,
        "kind" VARCHAR(16) NOT NULL,
        "reason" TEXT NOT NULL,
        "amountDelta" NUMERIC(14,2) NOT NULL,
        "createdByUserId" UUID NOT NULL,
        "approvalRequestId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_commission_adjustments_kind" CHECK ("kind" IN ('adjustment', 'correction', 'recalculation'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_commission_adjustments_originalCommissionResultId" ON "commission_adjustments" ("originalCommissionResultId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "commission_adjustments"`);
    await queryRunner.query(`DROP TABLE "commission_results"`);
    await queryRunner.query(`DROP TABLE "commission_approval_batches"`);
    await queryRunner.query(`DROP TABLE "commission_tiers"`);
    await queryRunner.query(`DROP TABLE "commission_policies"`);
  }
}
