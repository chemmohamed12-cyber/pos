import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D7 (2026-10-05, CTO) — New Item Request. A request is a `draft` Product plus this record (requester, reason, approval outcome).
 * `productId` is unique: one request per draft item. No FK to `products` (Procurement never owns Commerce's table — the id is
 * validated through the Sales product contract when the request is created).
 */
export class CreateProductItemRequests1789980000000 implements MigrationInterface {
  name = 'CreateProductItemRequests1789980000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "product_item_requests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "productId" uuid NOT NULL,
        "requestedByUserId" uuid NOT NULL,
        "reason" character varying(500) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "approvalRequestId" uuid,
        "decidedByUserId" uuid,
        "decidedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_product_item_requests" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_product_item_requests_status" CHECK ("status" IN ('pending','approved','rejected'))
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_product_item_requests_productId" ON "product_item_requests" ("productId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "product_item_requests"`);
  }
}
