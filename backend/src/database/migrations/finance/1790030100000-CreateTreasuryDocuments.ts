import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T3 (2026-10-20) — additive: Treasury Documents (the business layer above the Treasury ledger) and their invoice allocations. Both tables start empty; no existing
 * row is read, changed or backfilled, and no ledger / journal / balance / number is touched. Historical movements stay exactly as they are (they simply have no
 * document). `down` drops both tables.
 */
export class CreateTreasuryDocuments1790030100000 implements MigrationInterface {
  name = 'CreateTreasuryDocuments1790030100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "treasury_documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "documentNumber" varchar(32) NOT NULL,
        "kind" varchar(24) NOT NULL,
        "subtype" varchar(24),
        "status" varchar(16) NOT NULL DEFAULT 'draft',
        "businessDate" date NOT NULL,
        "amount" numeric(14,2) NOT NULL CHECK ("amount" > 0),
        "treasuryAccountId" uuid NOT NULL,
        "counterTreasuryAccountId" uuid,
        "customerId" uuid,
        "method" varchar(32),
        "reasonCode" varchar(64),
        "reference" varchar(255),
        "purpose" text,
        "unappliedAmount" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("unappliedAmount" >= 0),
        "approvalRequestId" uuid,
        "autoApproved" boolean NOT NULL DEFAULT false,
        "createdByUserId" uuid NOT NULL,
        "submittedAt" timestamptz,
        "approvedAt" timestamptz,
        "approvedByUserId" uuid,
        "rejectionNote" text,
        "executedAt" timestamptz,
        "executedByUserId" uuid,
        "executedTransactionId" uuid,
        "executedPaymentId" uuid,
        "reversedAt" timestamptz,
        "reversedByUserId" uuid,
        "reversalReason" text,
        "cancelReason" text,
        "version" int NOT NULL DEFAULT 1,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_treasury_documents" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_treasury_documents_number" ON "treasury_documents" ("documentNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_documents_kind" ON "treasury_documents" ("kind")`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_documents_status" ON "treasury_documents" ("status")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_treasury_documents_exec_txn" ON "treasury_documents" ("executedTransactionId") WHERE "executedTransactionId" IS NOT NULL`);
    await queryRunner.query(`
      CREATE TABLE "treasury_document_allocations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "documentId" uuid NOT NULL,
        "invoiceId" uuid NOT NULL,
        "amount" numeric(14,2) NOT NULL CHECK ("amount" > 0),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_treasury_document_allocations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_treasury_document_allocations_doc" FOREIGN KEY ("documentId") REFERENCES "treasury_documents"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_treasury_document_allocations_pair" ON "treasury_document_allocations" ("documentId", "invoiceId")`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_document_allocations_doc" ON "treasury_document_allocations" ("documentId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "treasury_document_allocations"`);
    await queryRunner.query(`DROP TABLE "treasury_documents"`);
  }
}
