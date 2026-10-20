import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T5 (2026-10-21) — additive: bank statements (header, lines, confirmed matches) and cash custody sessions. Four empty tables; nothing existing is read, changed or backfilled.
 * The unique partial index on `bank_statement_matches` makes "one movement, one active bank match" a database rule; the unique partial index on `cash_sessions` allows one
 * open session per account. `down` drops the four tables.
 */
export class CreateBankStatementsAndCashSessions1790030300000 implements MigrationInterface {
  name = 'CreateBankStatementsAndCashSessions1790030300000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "bank_statements" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "systemNumber" varchar(32) NOT NULL,
        "statementNumber" varchar(128),
        "treasuryAccountId" uuid NOT NULL,
        "periodStart" date NOT NULL,
        "periodEnd" date NOT NULL,
        "openingBalance" numeric(14,2) NOT NULL,
        "closingBalance" numeric(14,2) NOT NULL,
        "fileHash" varchar(64) NOT NULL,
        "sourceName" varchar(255),
        "status" varchar(16) NOT NULL DEFAULT 'imported',
        "lineCount" int NOT NULL,
        "importedByUserId" uuid NOT NULL,
        "importedAt" timestamptz NOT NULL DEFAULT now(),
        "reconciledAt" timestamptz,
        "reconciledByUserId" uuid,
        "reconciliationDifference" numeric(14,2),
        "version" int NOT NULL DEFAULT 1,
        CONSTRAINT "PK_bank_statements" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_bank_statements_period" CHECK ("periodStart" <= "periodEnd")
      )`);
    await q.query(`CREATE UNIQUE INDEX "IDX_bank_statements_number" ON "bank_statements" ("systemNumber")`);
    await q.query(`CREATE UNIQUE INDEX "IDX_bank_statements_account_hash" ON "bank_statements" ("treasuryAccountId", "fileHash")`);
    await q.query(`CREATE INDEX "IDX_bank_statements_account" ON "bank_statements" ("treasuryAccountId")`);
    await q.query(`
      CREATE TABLE "bank_statement_lines" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "statementId" uuid NOT NULL,
        "lineNumber" int NOT NULL,
        "valueDate" date NOT NULL,
        "description" text,
        "reference" varchar(255),
        "amount" numeric(14,2) NOT NULL CHECK ("amount" <> 0),
        "fingerprint" varchar(40) NOT NULL,
        "possibleDuplicate" boolean NOT NULL DEFAULT false,
        "status" varchar(16) NOT NULL DEFAULT 'unmatched',
        "suggestion" jsonb,
        "version" int NOT NULL DEFAULT 1,
        CONSTRAINT "PK_bank_statement_lines" PRIMARY KEY ("id"),
        CONSTRAINT "FK_bank_statement_lines_statement" FOREIGN KEY ("statementId") REFERENCES "bank_statements"("id") ON DELETE CASCADE
      )`);
    await q.query(`CREATE UNIQUE INDEX "UQ_bank_statement_lines_no" ON "bank_statement_lines" ("statementId", "lineNumber")`);
    await q.query(`CREATE INDEX "IDX_bank_statement_lines_statement" ON "bank_statement_lines" ("statementId")`);
    await q.query(`CREATE INDEX "IDX_bank_statement_lines_fp" ON "bank_statement_lines" ("fingerprint")`);
    await q.query(`
      CREATE TABLE "bank_statement_matches" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "lineId" uuid NOT NULL,
        "treasuryTransactionId" uuid NOT NULL,
        "method" varchar(24) NOT NULL,
        "matchedByUserId" uuid NOT NULL,
        "matchedAt" timestamptz NOT NULL DEFAULT now(),
        "unmatchedAt" timestamptz,
        "unmatchedByUserId" uuid,
        "unmatchReason" text,
        CONSTRAINT "PK_bank_statement_matches" PRIMARY KEY ("id"),
        CONSTRAINT "FK_bank_statement_matches_line" FOREIGN KEY ("lineId") REFERENCES "bank_statement_lines"("id")
      )`);
    await q.query(`CREATE INDEX "IDX_bank_statement_matches_line" ON "bank_statement_matches" ("lineId")`);
    await q.query(`CREATE INDEX "IDX_bank_statement_matches_txn" ON "bank_statement_matches" ("treasuryTransactionId")`);
    await q.query(`CREATE UNIQUE INDEX "UQ_bank_statement_matches_active_txn" ON "bank_statement_matches" ("treasuryTransactionId") WHERE "unmatchedAt" IS NULL`);
    await q.query(`
      CREATE TABLE "cash_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sessionNumber" varchar(32) NOT NULL,
        "treasuryAccountId" uuid NOT NULL,
        "custodianUserId" uuid NOT NULL,
        "status" varchar(12) NOT NULL DEFAULT 'open',
        "openedAt" timestamptz NOT NULL DEFAULT now(),
        "openedByUserId" uuid NOT NULL,
        "openingBalance" numeric(14,2) NOT NULL,
        "note" text,
        "closedAt" timestamptz,
        "closedByUserId" uuid,
        "expectedBalance" numeric(14,2),
        "countedAmount" numeric(14,2),
        "variance" numeric(14,2),
        "varianceReason" text,
        "varianceDocumentId" uuid,
        "reopenedAt" timestamptz,
        "reopenedByUserId" uuid,
        "reopenReason" text,
        "version" int NOT NULL DEFAULT 1,
        CONSTRAINT "PK_cash_sessions" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE UNIQUE INDEX "IDX_cash_sessions_number" ON "cash_sessions" ("sessionNumber")`);
    await q.query(`CREATE INDEX "IDX_cash_sessions_account" ON "cash_sessions" ("treasuryAccountId")`);
    await q.query(`CREATE UNIQUE INDEX "UQ_cash_sessions_one_open" ON "cash_sessions" ("treasuryAccountId") WHERE "status" = 'open'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "cash_sessions"`);
    await q.query(`DROP TABLE "bank_statement_matches"`);
    await q.query(`DROP TABLE "bank_statement_lines"`);
    await q.query(`DROP TABLE "bank_statements"`);
  }
}
