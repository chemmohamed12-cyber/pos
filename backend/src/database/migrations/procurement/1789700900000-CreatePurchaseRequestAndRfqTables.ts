import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `procurement`-tagged (ADR-025). Path B (Controlled Procurement Cycle):
 * Purchase Request → RFQ → Supplier Quotations → Evaluation/Approval →
 * Purchase Order. Adds `sourceRfqId` to `purchase_orders` for
 * traceability when a PO originates from this path (null = Path A).
 */
export class CreatePurchaseRequestAndRfqTables1789700900000 implements MigrationInterface {
  name = 'CreatePurchaseRequestAndRfqTables1789700900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "purchase_orders" ADD COLUMN "sourceRfqId" UUID`);
    await queryRunner.query(`CREATE INDEX "IDX_purchase_orders_source_rfq" ON "purchase_orders" ("sourceRfqId")`);

    await queryRunner.query(`
      CREATE TABLE "purchase_requests" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "prNumber" VARCHAR(32) NOT NULL,
        "warehouseId" UUID NOT NULL,
        "notes" VARCHAR(500),
        "requestedByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_purchase_requests_pr_number" ON "purchase_requests" ("prNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_purchase_requests_warehouse" ON "purchase_requests" ("warehouseId")`);

    await queryRunner.query(`
      CREATE TABLE "purchase_request_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "purchaseRequestId" UUID NOT NULL REFERENCES "purchase_requests"("id") ON DELETE CASCADE,
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "quantity" NUMERIC(18,3) NOT NULL,
        "neededByDate" DATE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_purchase_request_lines_pr" ON "purchase_request_lines" ("purchaseRequestId")`);
    await queryRunner.query(`CREATE INDEX "IDX_purchase_request_lines_product" ON "purchase_request_lines" ("productId")`);

    await queryRunner.query(`
      CREATE TABLE "rfqs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "rfqNumber" VARCHAR(32) NOT NULL,
        "purchaseRequestId" UUID NOT NULL REFERENCES "purchase_requests"("id"),
        "notes" VARCHAR(500),
        "createdByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_rfqs_rfq_number" ON "rfqs" ("rfqNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_rfqs_pr" ON "rfqs" ("purchaseRequestId")`);

    await queryRunner.query(`
      CREATE TABLE "rfq_supplier_invites" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "rfqId" UUID NOT NULL REFERENCES "rfqs"("id") ON DELETE CASCADE,
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id"),
        "invitedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_rfq_supplier_invites_rfq" ON "rfq_supplier_invites" ("rfqId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_rfq_supplier_invites_unique" ON "rfq_supplier_invites" ("rfqId", "supplierId")`);

    await queryRunner.query(`
      CREATE TABLE "supplier_quotations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "quotationNumber" VARCHAR(32) NOT NULL,
        "rfqId" UUID NOT NULL REFERENCES "rfqs"("id"),
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id"),
        "totalAmount" NUMERIC(14,2) NOT NULL,
        "notes" VARCHAR(500),
        "recordedByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_supplier_quotations_number" ON "supplier_quotations" ("quotationNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_quotations_rfq" ON "supplier_quotations" ("rfqId")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_quotations_supplier" ON "supplier_quotations" ("supplierId")`);

    await queryRunner.query(`
      CREATE TABLE "supplier_quotation_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "supplierQuotationId" UUID NOT NULL REFERENCES "supplier_quotations"("id") ON DELETE CASCADE,
        "purchaseRequestLineId" UUID NOT NULL REFERENCES "purchase_request_lines"("id"),
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "quantity" NUMERIC(18,3) NOT NULL,
        "unitCostBase" NUMERIC(18,4) NOT NULL,
        "lineTotalBase" NUMERIC(18,2) NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_quotation_lines_quotation" ON "supplier_quotation_lines" ("supplierQuotationId")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_quotation_lines_pr_line" ON "supplier_quotation_lines" ("purchaseRequestLineId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "supplier_quotation_lines"`);
    await queryRunner.query(`DROP TABLE "supplier_quotations"`);
    await queryRunner.query(`DROP TABLE "rfq_supplier_invites"`);
    await queryRunner.query(`DROP TABLE "rfqs"`);
    await queryRunner.query(`DROP TABLE "purchase_request_lines"`);
    await queryRunner.query(`DROP TABLE "purchase_requests"`);
    await queryRunner.query(`ALTER TABLE "purchase_orders" DROP COLUMN "sourceRfqId"`);
  }
}
