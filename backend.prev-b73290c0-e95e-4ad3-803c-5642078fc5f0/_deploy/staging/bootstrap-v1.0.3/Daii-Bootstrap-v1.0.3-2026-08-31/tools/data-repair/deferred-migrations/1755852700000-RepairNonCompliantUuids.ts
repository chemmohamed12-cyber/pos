import { MigrationInterface, QueryRunner } from 'typeorm';
import { runUuidRfc4122Repair } from '../uuid-repair.core';

/**
 * UUID Primary-Key Repair (CTO directive, post-v1.0.2 hotfix cycle) — the
 * deliberately-deferred follow-up to
 * `1755852500000-FixGenRandomUuidRfc4122Compliance.ts`, which fixed id
 * GENERATION going forward but explicitly left already-existing
 * non-compliant ids untouched.
 *
 * DEFERRED — this file lives in `tools/data-repair/deferred-migrations/`,
 * OUTSIDE the `[0-9]*`-anchored migration glob, so `migration:run` does NOT
 * pick it up. Two ways to run the repair:
 *
 *  1. **Recommended — Controlled Data Repair via the Release Center**
 *     (`POST /release/data-repairs...`, or `DataRepairService`): takes a
 *     mandatory verified pre-repair backup, produces a reviewable
 *     `old -> new` mapping, runs `runUuidRfc4122Repair` in one transaction,
 *     then a full integrity verification — all recorded as a
 *     `data_repair_run` evidence row. See `DATA_REPAIR_RUNBOOK.md`.
 *
 *  2. **Migration path** — move THIS file to `src/database/migrations/`,
 *     rebuild, take a `pg_dump` backup by hand, then `npm run migration:run`.
 *     The import path (`../uuid-repair.core`) already assumes that
 *     reactivated location (`src/database/migrations/` -> `src/database/`).
 *
 * The entire repair algorithm (deferred-FK-constraint technique, DB-enforced
 * + soft/hidden + polymorphic + shared-PK reference updates, RAISE NOTICE
 * logging) lives in `src/database/uuid-repair.core.ts` so this migration and
 * `DataRepairService` can never diverge. See that file's header for the
 * full safety model.
 *
 * `down()` is not a real rollback — primary keys were rewritten in place.
 * Restore from the pre-operation `pg_dump` backup (ADR-020 §6,
 * roll-forward-only).
 */
export class RepairNonCompliantUuids1755852700000 implements MigrationInterface {
  name = 'RepairNonCompliantUuids1755852700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { totalRepaired } = await runUuidRfc4122Repair(queryRunner);
    await queryRunner.query(
      `DO $$ BEGIN RAISE NOTICE 'RepairNonCompliantUuids1755852700000: % row(s) repaired', ${totalRepaired}; END $$;`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'RepairNonCompliantUuids has no automated rollback — primary keys were rewritten in place. ' +
        'Restore from the pg_dump / Release Center backup taken immediately before this repair ran ' +
        "(see DATA_REPAIR_RUNBOOK.md), per ADR-020 §6's roll-forward-only philosophy.",
    );
  }
}
