import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Treasury / Financial Core — Order → Deposit → Finance Approval →
 * Treasury Transaction → Ledger → Account Balance. `treasury_accounts`
 * holds no balance column on purpose: balance is always `SUM` over
 * `treasury_transactions`, the same ledger-not-a-field discipline
 * Warehouse already uses for stock (`stock_movements` → on-hand).
 */
export class CreateTreasuryTables1755848000000 implements MigrationInterface {
  name = 'CreateTreasuryTables1755848000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "treasury_accounts" (
        "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "type" VARCHAR(16) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_treasury_accounts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_treasury_accounts_code" ON "treasury_accounts" ("code")`);

    await queryRunner.query(`
      CREATE TABLE "treasury_transactions" (
        "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "transactionNumber" VARCHAR(32) NOT NULL,
        "type" VARCHAR(16) NOT NULL,
        "treasuryAccountId" UUID NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL,
        "customerId" UUID,
        "salesOrderId" UUID,
        "depositId" UUID,
        "transferGroupId" UUID,
        "reference" VARCHAR(255),
        "reason" VARCHAR(255),
        "movementDate" TIMESTAMPTZ NOT NULL,
        "createdByUserId" UUID NOT NULL,
        "reversalOfTransactionId" UUID,
        "status" VARCHAR(16) NOT NULL DEFAULT 'posted',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_treasury_transactions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_treasury_transactions_number" ON "treasury_transactions" ("transactionNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_transactions_accountId" ON "treasury_transactions" ("treasuryAccountId")`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_transactions_customerId" ON "treasury_transactions" ("customerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_transactions_salesOrderId" ON "treasury_transactions" ("salesOrderId")`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_transactions_depositId" ON "treasury_transactions" ("depositId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "treasury_transactions"`);
    await queryRunner.query(`DROP TABLE "treasury_accounts"`);
  }
}
