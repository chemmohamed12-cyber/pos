import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manufacturing Engine S3 (2026-10-24, decision D-ME-3) — the versioned PROCESS DEFINITION. Additive only: six new tables, nothing existing changes meaning (the flat BOM and the
 * one-routing-per-product master data stay as the "Basic Profile"). A process version is the definition layer of the general engine:
 *   - operation types   : configurable catalogue (code, names, kind) — industries add their own; the engine only knows the `kind`;
 *   - versions          : one output product, numbered versions, at most ONE active per product (partial unique index), draft -> active -> retired;
 *   - operations        : the nodes of the process graph (type, optional work center, optional / repeatable flags);
 *   - edges             : predecessor links (sequence, parallel branches and joins are all just edges of a DAG);
 *   - inputs            : materials consumed per operation, with alternates (same `alternateGroup` = one of them is chosen at run time);
 *   - outputs           : what an operation yields per planned unit — good / co_product / by_product, intermediate or final, with an allocation weight for sharing the pooled cost.
 * Quantities are integers in the item's base unit (S2). No cost element, rate or hours exist anywhere in these tables (ADR-060 D2/D3 stay as ratified).
 */
export class CreateProcessDefinition1790033300000 implements MigrationInterface {
  name = 'CreateProcessDefinition1790033300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mfg_operation_types" (
        "code" VARCHAR(32) PRIMARY KEY,
        "nameAr" VARCHAR(120) NOT NULL,
        "nameEn" VARCHAR(120) NOT NULL,
        "kind" VARCHAR(16) NOT NULL,
        "active" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_mfg_operation_types_kind" CHECK ("kind" IN ('transform','assembly','packing','quality','disassembly','rework','other'))
      )
    `);
    await queryRunner.query(`
      INSERT INTO "mfg_operation_types" ("code","nameAr","nameEn","kind") VALUES
        ('transform','تشغيل / تحويل','Transform','transform'),
        ('assembly','تجميع','Assembly','assembly'),
        ('packing','تعبئة وتغليف','Packing','packing'),
        ('quality','فحص جودة','Quality inspection','quality'),
        ('disassembly','تفكيك','Disassembly','disassembly'),
        ('rework','إعادة تشغيل','Rework','rework')
      ON CONFLICT ("code") DO NOTHING
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mfg_process_versions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "productId" UUID NOT NULL,
        "versionNo" INT NOT NULL,
        "status" VARCHAR(12) NOT NULL DEFAULT 'draft',
        "name" VARCHAR(255) NOT NULL,
        "note" VARCHAR(500),
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "activatedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_mfg_process_versions_status" CHECK ("status" IN ('draft','active','retired'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mfg_process_versions_product_no" ON "mfg_process_versions" ("productId","versionNo")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mfg_process_versions_one_active" ON "mfg_process_versions" ("productId") WHERE "status" = 'active'`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mfg_process_operations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "versionId" UUID NOT NULL,
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "operationTypeCode" VARCHAR(32) NOT NULL,
        "workCenterId" UUID,
        "sequenceNo" INT NOT NULL DEFAULT 0,
        "optional" BOOLEAN NOT NULL DEFAULT false,
        "maxRuns" INT NOT NULL DEFAULT 1,
        CONSTRAINT "CHK_mfg_process_operations_runs" CHECK ("maxRuns" >= 1 AND "maxRuns" <= 50)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mfg_process_operations_code" ON "mfg_process_operations" ("versionId","code")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mfg_process_edges" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "versionId" UUID NOT NULL,
        "fromOperationId" UUID NOT NULL,
        "toOperationId" UUID NOT NULL,
        CONSTRAINT "CHK_mfg_process_edges_not_self" CHECK ("fromOperationId" <> "toOperationId")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mfg_process_edges_pair" ON "mfg_process_edges" ("versionId","fromOperationId","toOperationId")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mfg_process_inputs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "versionId" UUID NOT NULL,
        "operationId" UUID NOT NULL,
        "componentProductId" UUID NOT NULL,
        "quantityPerUnit" INT NOT NULL,
        "alternateGroup" VARCHAR(32),
        CONSTRAINT "CHK_mfg_process_inputs_qty" CHECK ("quantityPerUnit" >= 1)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mfg_process_inputs_version" ON "mfg_process_inputs" ("versionId")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mfg_process_outputs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "versionId" UUID NOT NULL,
        "operationId" UUID NOT NULL,
        "productId" UUID NOT NULL,
        "quantityPerUnit" INT NOT NULL,
        "role" VARCHAR(12) NOT NULL,
        "intermediate" BOOLEAN NOT NULL DEFAULT false,
        "allocationWeight" INT NOT NULL DEFAULT 1,
        CONSTRAINT "CHK_mfg_process_outputs_qty" CHECK ("quantityPerUnit" >= 1),
        CONSTRAINT "CHK_mfg_process_outputs_role" CHECK ("role" IN ('good','co_product','by_product')),
        CONSTRAINT "CHK_mfg_process_outputs_weight" CHECK ("allocationWeight" >= 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mfg_process_outputs_version" ON "mfg_process_outputs" ("versionId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const t of ['mfg_process_outputs', 'mfg_process_inputs', 'mfg_process_edges', 'mfg_process_operations', 'mfg_process_versions', 'mfg_operation_types']) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${t}"`);
    }
  }
}
