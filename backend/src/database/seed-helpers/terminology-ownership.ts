import { QueryRunner } from 'typeorm';

/**
 * Ownership-aware terminology seeding (CTO decision D-3, 2026-10-26).
 *
 * A seed migration must neither overwrite terminology that belongs to another feature nor delete, on `down`, a row it did not create.
 * `terminology_seed_ownership` records which feature ("owner") first created a code and in which migration; it is created on first use
 * (`IF NOT EXISTS`) in the same database that holds `terminology_entries`.
 *
 *  - up, code absent            -> insert the row and record (code, owner, migration).
 *  - up, code present, owned by this owner and `update` mode -> refresh ar/en (a later stage of the same feature may correct its own wording).
 *  - up, code present otherwise -> left untouched (pre-existing, shared, or another feature's): never overwritten.
 *  - down                        -> delete a row only when this exact migration created it (owner + migration match) and remove its ownership record.
 *    Rows created before this helper existed have no ownership record and are therefore never deleted by `down`. The bookkeeping table is dropped when its last record is removed.
 */
export type TerminologyRow = readonly [code: string, category: string, ar: string, en: string];
export type TerminologySeedMode = 'preserve' | 'update';

const TABLE = 'terminology_seed_ownership';

async function ensureTable(q: QueryRunner): Promise<void> {
  await q.query(
    `CREATE TABLE IF NOT EXISTS "${TABLE}" ("code" VARCHAR(128) PRIMARY KEY, "owner" VARCHAR(64) NOT NULL, "migration" VARCHAR(160) NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
}

export async function seedTerminologyOwned(q: QueryRunner, owner: string, migration: string, rows: readonly TerminologyRow[], mode: TerminologySeedMode): Promise<void> {
  await ensureTable(q);
  for (const [code, category, ar, en] of rows) {
    const inserted: Array<{ code: string }> = await q.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING RETURNING "code"`,
      [code, category, ar, en],
    );
    if (inserted.length > 0) {
      await q.query(`INSERT INTO "${TABLE}" ("code", "owner", "migration") VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`, [code, owner, migration]);
      continue;
    }
    if (mode === 'update') {
      await q.query(
        `UPDATE "terminology_entries" SET "ar" = $2, "en" = $3 WHERE "code" = $1 AND EXISTS (SELECT 1 FROM "${TABLE}" o WHERE o."code" = $1 AND o."owner" = $4)`,
        [code, ar, en, owner],
      );
    }
  }
}

export async function unseedTerminologyOwned(q: QueryRunner, owner: string, migration: string, rows: readonly TerminologyRow[]): Promise<void> {
  await ensureTable(q);
  const codes = rows.map(([code]) => code);
  await q.query(
    `DELETE FROM "terminology_entries" WHERE "code" IN (SELECT "code" FROM "${TABLE}" WHERE "owner" = $2 AND "migration" = $3 AND "code" = ANY($1))`,
    [codes, owner, migration],
  );
  await q.query(`DELETE FROM "${TABLE}" WHERE "owner" = $2 AND "migration" = $3 AND "code" = ANY($1)`, [codes, owner, migration]);
  // once the last ownership record is gone the bookkeeping table is removed too, so a full rollback leaves no schema residue (it is re-created on demand by the next seed)
  await q.query(`DO $$ BEGIN IF to_regclass('"${TABLE}"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "${TABLE}") THEN DROP TABLE "${TABLE}"; END IF; END $$`);
}
