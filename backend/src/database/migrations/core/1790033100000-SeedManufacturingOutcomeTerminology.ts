import { MigrationInterface, QueryRunner } from 'typeorm';

// <terminology-ownership:begin> (identical in every seed migration; guarded by terminology-ownership.spec.ts - migrations must stay self-contained)
type TerminologyRow = readonly [code: string, category: string, ar: string, en: string];
type TerminologySeedMode = 'preserve' | 'update';

const TABLE = 'terminology_seed_ownership';

async function ensureTable(q: QueryRunner): Promise<void> {
  await q.query(
    `CREATE TABLE IF NOT EXISTS "${TABLE}" ("code" VARCHAR(128) PRIMARY KEY, "owner" VARCHAR(64) NOT NULL, "migration" VARCHAR(160) NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
}

async function seedTerminologyOwned(q: QueryRunner, owner: string, migration: string, rows: readonly TerminologyRow[], mode: TerminologySeedMode): Promise<void> {
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

async function unseedTerminologyOwned(q: QueryRunner, owner: string, migration: string, rows: readonly TerminologyRow[]): Promise<void> {
  await ensureTable(q);
  const codes = rows.map(([code]) => code);
  await q.query(
    `DELETE FROM "terminology_entries" WHERE "code" IN (SELECT "code" FROM "${TABLE}" WHERE "owner" = $2 AND "migration" = $3 AND "code" = ANY($1))`,
    [codes, owner, migration],
  );
  await q.query(`DELETE FROM "${TABLE}" WHERE "owner" = $2 AND "migration" = $3 AND "code" = ANY($1)`, [codes, owner, migration]);
}
// <terminology-ownership:end>


/** Manufacturing Engine S1 (2026-10-24) - movement-type labels for scrap / recovery. Data only; ON CONFLICT DO NOTHING; `down` removes exactly these rows. */
export class SeedManufacturingOutcomeTerminology1790033100000 implements MigrationInterface {
  name = 'SeedManufacturingOutcomeTerminology1790033100000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['movement_type.work_order_scrap', 'movement_type', 'هالك أمر تشغيل', 'Work order scrap'],
    ['movement_type.work_order_recovery', 'movement_type', 'استرداد خامة من هالك', 'Work order material recovery'],
    ['nav.manufacturing_processes', 'field', 'تعريفات العمليات', 'Process definitions'],
    ['policy.manufacturing_scrap_loss_account_code.label', 'field', 'حساب خسارة هالك التصنيع', 'Manufacturing scrap loss account'],
    ['policy.manufacturing_scrap_loss_account_code.help', 'panel', 'الطرف المدين عند تسجيل هالك أمر تشغيل (دائن: الإنتاج تحت التشغيل). عادةً حساب مصروف.', 'Debit side when work-order scrap is recognised (credit: WIP). Typically an expense account.'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await seedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows, 'preserve');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await unseedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows);
  }
}
