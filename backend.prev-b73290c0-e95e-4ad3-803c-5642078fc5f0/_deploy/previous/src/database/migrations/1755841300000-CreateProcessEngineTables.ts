import { MigrationInterface, QueryRunner } from 'typeorm';

/** Process Engine — Stage 2 build-order item 18. */
export class CreateProcessEngineTables1755841300000 implements MigrationInterface {
  name = 'CreateProcessEngineTables1755841300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "process_instances" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "definitionKey" VARCHAR(128) NOT NULL,
        "entityType" VARCHAR(64) NOT NULL,
        "entityId" VARCHAR(255) NOT NULL,
        "currentState" VARCHAR(64) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_process_instances_unique" ON "process_instances" ("definitionKey", "entityType", "entityId")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_process_instances_entityId" ON "process_instances" ("entityId")`);

    await queryRunner.query(`
      CREATE TABLE "process_transition_records" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "processInstanceId" UUID NOT NULL REFERENCES "process_instances"("id") ON DELETE CASCADE,
        "fromState" VARCHAR(64) NOT NULL,
        "toState" VARCHAR(64) NOT NULL,
        "action" VARCHAR(64) NOT NULL,
        "actorUserId" UUID,
        "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_process_transition_records_instanceId" ON "process_transition_records" ("processInstanceId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "process_transition_records"`);
    await queryRunner.query(`DROP TABLE "process_instances"`);
  }
}
