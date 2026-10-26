import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { OrgUnitLifecycle1790021000000 } from '../../database/migrations/core/1790021000000-OrgUnitLifecycle';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';

/**
 * Integration finding (CTO 2026-10-26, tracked as DEF-ORG-FK-DOWN): after the org-engine migration `OrgUnitLifecycle1790021000000` is reverted, the `org_units` parent foreign key is NOT
 * back to its original `ON DELETE CASCADE` - it stays `ON DELETE RESTRICT` (renamed `FK_org_units_parent`). This is DELIBERATE (the migration's own comment: re-introducing cascade deletion of
 * a referenced subtree would be the unsafe direction). The invariant this spec pins, on a real database:
 *  - after UP: a parent that has children cannot be deleted (RESTRICT), a leaf can;
 *  - after DOWN: the status/archivedAt columns and the single-root index are gone, but the deletion protection is STILL there (never weakened back to CASCADE);
 *  - UP again is idempotent (no second constraint, same definition) and a no-op run changes nothing;
 *  - the only schema difference between "before UP" and "after DOWN" is that one constraint (documented, accepted exception in the rollback rehearsal).
 */
describe('org_units parent FK — rollback keeps the deletion protection (DEF-ORG-FK-DOWN) — real-Postgres', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ds: DataSource;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'org_fk_down', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'] });
    ds = await h.connections.getDataSource(h.companyAId);
  });
  afterAll(async () => h.teardown());

  const qr = () => ({ query: (sql: string, p?: unknown[]) => ds.query(sql, p) }) as never;
  const fks = async () =>
    (await ds.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'org_units'::regclass AND contype = 'f' AND confrelid = 'org_units'::regclass`)) as Array<{ conname: string; def: string }>;
  const cols = async () => ((await ds.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'org_units' ORDER BY 1`)) as Array<{ column_name: string }>).map((r) => r.column_name);
  const parentDeleteRefused = async (): Promise<boolean> => {
    const parent = randomUUID();
    const leaf = randomUUID();
    await ds.query(`INSERT INTO org_units (id, type, name) VALUES ($1,'company',$2)`, [parent, `P-${parent.slice(0, 6)}`]);
    await ds.query(`INSERT INTO org_units (id, type, name, "parentId") VALUES ($1,'branch',$2,$3)`, [leaf, `L-${leaf.slice(0, 6)}`, parent]);
    let refused = false;
    try {
      await ds.query(`DELETE FROM org_units WHERE id = $1`, [parent]);
    } catch (e) {
      refused = /foreign key|violates/i.test(e instanceof Error ? e.message : String(e));
    }
    const leafDeleted = (await ds.query(`DELETE FROM org_units WHERE id = $1 RETURNING id`, [leaf])).length > 0;
    await ds.query(`DELETE FROM org_units WHERE id = $1`, [parent]).catch(() => undefined);
    return refused && leafDeleted;
  };

  it('R1 UP state: RESTRICT, one FK, parent-with-children delete refused, leaf delete works', async () => {
    const f = await fks();
    expect(f).toHaveLength(1);
    expect(f[0].def).toMatch(/ON DELETE RESTRICT/);
    expect(await parentDeleteRefused()).toBe(true);
    expect(await cols()).toEqual(expect.arrayContaining(['status', 'archivedAt']));
  });

  it('R2 DOWN: the added columns and the single-root index are removed, the deletion protection is NOT weakened (still RESTRICT)', async () => {
    await new OrgUnitLifecycle1790021000000().down(qr());
    expect(await cols()).not.toEqual(expect.arrayContaining(['status']));
    expect(await cols()).not.toEqual(expect.arrayContaining(['archivedAt']));
    expect((await ds.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'IDX_org_units_single_root'`)).length).toBe(0);
    const f = await fks();
    expect(f).toHaveLength(1);
    expect(f[0].def).toMatch(/ON DELETE RESTRICT/);
    expect(f[0].def).not.toMatch(/CASCADE/);
    expect(await parentDeleteRefused()).toBe(true);
  });

  it('R3 UP again is idempotent: one FK with the same definition, columns back; running it a second time (no-op) changes nothing', async () => {
    await new OrgUnitLifecycle1790021000000().up(qr());
    const first = { fks: await fks(), cols: await cols() };
    expect(first.fks).toHaveLength(1);
    expect(first.fks[0].def).toMatch(/ON DELETE RESTRICT/);
    expect(first.cols).toEqual(expect.arrayContaining(['status', 'archivedAt']));
    await new OrgUnitLifecycle1790021000000().up(qr());
    expect({ fks: await fks(), cols: await cols() }).toEqual(first);
    expect(await parentDeleteRefused()).toBe(true);
  });
});
