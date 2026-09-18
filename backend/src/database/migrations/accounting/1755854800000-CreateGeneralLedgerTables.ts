import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F03 — General Ledger + Financial Event Engine (ADR-035). Four new tables
 * owned exclusively by `accounting` — zero cross-module reference in
 * either direction (same reasoning as F01/F02, and `hr`'s
 * `CreateHrTables`). Purely additive; touches nothing outside
 * `accounting`, does not alter any F01/F02 table.
 *
 * Following the established `accounting` migration convention (F01/F02):
 * app-level referential integrity + indexes, no FK constraints.
 */
export class CreateGeneralLedgerTables1755854800000 implements MigrationInterface {
  name = 'CreateGeneralLedgerTables1755854800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_financial_events" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "eventType" VARCHAR(64) NOT NULL,
        "sourceDomain" VARCHAR(32) NOT NULL,
        "sourceEntityType" VARCHAR(64) NOT NULL,
        "sourceEntityId" VARCHAR(64) NOT NULL,
        "idempotencyKey" VARCHAR(255) NOT NULL,
        "businessDate" DATE NOT NULL,
        "orgUnitId" UUID,
        "transactionCurrencyCode" VARCHAR(3) NOT NULL,
        "payload" JSONB NOT NULL,
        "payloadVersion" INT NOT NULL DEFAULT 1,
        "status" VARCHAR(16) NOT NULL DEFAULT 'RECEIVED',
        "journalEntryId" UUID,
        "rejectionReason" VARCHAR(512),
        "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "processedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_accounting_financial_events_status"
          CHECK ("status" IN ('RECEIVED','MAPPED','POSTED','REJECTED','IGNORED'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_financial_events_idempotency_key" ON "accounting_financial_events" ("idempotencyKey")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_accounting_financial_events_event_type" ON "accounting_financial_events" ("eventType")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_financial_events_status" ON "accounting_financial_events" ("status")`);

    await queryRunner.query(`
      CREATE TABLE "accounting_journal_entries" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "entryNumber" VARCHAR(32),
        "businessDate" DATE NOT NULL,
        "postingDate" DATE,
        "description" VARCHAR(512),
        "sourceType" VARCHAR(16) NOT NULL,
        "financialEventId" UUID,
        "reversalOfEntryId" UUID,
        "transactionCurrencyCode" VARCHAR(3) NOT NULL,
        "functionalCurrencyCode" VARCHAR(3) NOT NULL,
        "totalDebitTransaction" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "totalCreditTransaction" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "totalDebitBase" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "totalCreditBase" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "orgUnitId" UUID,
        "createdBy" UUID NOT NULL,
        "postedBy" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "postedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_accounting_journal_entries_source_type"
          CHECK ("sourceType" IN ('FINANCIAL_EVENT','MANUAL','REVERSAL','OPENING')),
        CONSTRAINT "CHK_accounting_journal_entries_reversal_link"
          CHECK (("sourceType" = 'REVERSAL') = ("reversalOfEntryId" IS NOT NULL)),
        CONSTRAINT "CHK_accounting_journal_entries_financial_event_link"
          CHECK (("sourceType" = 'FINANCIAL_EVENT') = ("financialEventId" IS NOT NULL))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_journal_entries_entry_number" ON "accounting_journal_entries" ("entryNumber") WHERE "entryNumber" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_journal_entries_one_reversal" ON "accounting_journal_entries" ("reversalOfEntryId") WHERE "reversalOfEntryId" IS NOT NULL`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_accounting_journal_entries_business_date" ON "accounting_journal_entries" ("businessDate")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_journal_entries_source_type" ON "accounting_journal_entries" ("sourceType")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_journal_entries_financial_event" ON "accounting_journal_entries" ("financialEventId")`);

    await queryRunner.query(`
      CREATE TABLE "accounting_journal_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "journalEntryId" UUID NOT NULL,
        "lineNumber" INT NOT NULL,
        "accountId" UUID NOT NULL,
        "description" VARCHAR(512),
        "debitTransaction" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "creditTransaction" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "debitBase" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "creditBase" NUMERIC(20,4) NOT NULL DEFAULT 0,
        "exchangeRateUsed" NUMERIC(18,8) NOT NULL DEFAULT 1,
        "exchangeRateDate" DATE NOT NULL,
        "orgUnitId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_accounting_journal_lines_amounts_non_negative"
          CHECK ("debitTransaction" >= 0 AND "creditTransaction" >= 0 AND "debitBase" >= 0 AND "creditBase" >= 0),
        CONSTRAINT "CHK_accounting_journal_lines_xor_transaction"
          CHECK (("debitTransaction" > 0 AND "creditTransaction" = 0) OR ("creditTransaction" > 0 AND "debitTransaction" = 0)),
        CONSTRAINT "CHK_accounting_journal_lines_xor_base"
          CHECK (("debitBase" > 0 AND "creditBase" = 0) OR ("creditBase" > 0 AND "debitBase" = 0))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_journal_lines_entry_line" ON "accounting_journal_lines" ("journalEntryId", "lineNumber")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_accounting_journal_lines_entry" ON "accounting_journal_lines" ("journalEntryId")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounting_journal_lines_account" ON "accounting_journal_lines" ("accountId")`);

    await queryRunner.query(`
      CREATE TABLE "accounting_journal_line_dimensions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "journalLineId" UUID NOT NULL,
        "dimensionTypeId" UUID NOT NULL,
        "dimensionValueId" UUID NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounting_journal_line_dimensions_line_type" ON "accounting_journal_line_dimensions" ("journalLineId", "dimensionTypeId")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_accounting_journal_line_dimensions_line" ON "accounting_journal_line_dimensions" ("journalLineId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounting_journal_line_dimensions"`);
    await queryRunner.query(`DROP TABLE "accounting_journal_lines"`);
    await queryRunner.query(`DROP TABLE "accounting_journal_entries"`);
    await queryRunner.query(`DROP TABLE "accounting_financial_events"`);
  }
}
