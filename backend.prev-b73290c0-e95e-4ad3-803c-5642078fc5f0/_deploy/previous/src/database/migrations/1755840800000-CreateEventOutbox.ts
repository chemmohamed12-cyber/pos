import { MigrationInterface, QueryRunner } from 'typeorm';

/** Events — Stage 2 build-order item 12. */
export class CreateEventOutbox1755840800000 implements MigrationInterface {
  name = 'CreateEventOutbox1755840800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "event_outbox" (
        "id" SERIAL PRIMARY KEY,
        "topic" VARCHAR(128) NOT NULL,
        "payload" JSONB NOT NULL,
        "schemaVersion" INT NOT NULL DEFAULT 1,
        "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
        "attempts" INT NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "dispatchedAt" TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_event_outbox_status" ON "event_outbox" ("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_event_outbox_topic" ON "event_outbox" ("topic")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "event_outbox"`);
  }
}
