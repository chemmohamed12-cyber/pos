import { QueryRunner } from 'typeorm';
import { seedTerminologyOwned, TerminologyRow, unseedTerminologyOwned } from './terminology-ownership';

/** In-memory stand-in for the three statements shapes the helper issues (terminology_entries + terminology_seed_ownership). */
class FakeRunner {
  entries = new Map<string, { category: string; ar: string; en: string }>();
  owners = new Map<string, { owner: string; migration: string }>();
  async query(sql: string, p: unknown[] = []): Promise<unknown[]> {
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) return [];
    if (sql.startsWith('INSERT INTO "terminology_entries"')) {
      const [code, category, ar, en] = p as string[];
      if (this.entries.has(code)) return [];
      this.entries.set(code, { category, ar, en });
      return [{ code }];
    }
    if (sql.startsWith('INSERT INTO "terminology_seed_ownership"')) {
      const [code, owner, migration] = p as string[];
      if (!this.owners.has(code)) this.owners.set(code, { owner, migration });
      return [];
    }
    if (sql.startsWith('UPDATE "terminology_entries"')) {
      const [code, ar, en, owner] = p as string[];
      const e = this.entries.get(code);
      if (e && this.owners.get(code)?.owner === owner) Object.assign(e, { ar, en });
      return [];
    }
    if (sql.startsWith('DELETE FROM "terminology_entries"')) {
      const [codes, owner, migration] = p as [string[], string, string];
      for (const c of codes) if (this.owners.get(c)?.owner === owner && this.owners.get(c)?.migration === migration) this.entries.delete(c);
      return [];
    }
    if (sql.startsWith('DELETE FROM "terminology_seed_ownership"')) {
      const [codes, owner, migration] = p as [string[], string, string];
      for (const c of codes) if (this.owners.get(c)?.owner === owner && this.owners.get(c)?.migration === migration) this.owners.delete(c);
      return [];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}
const qr = (f: FakeRunner) => f as unknown as QueryRunner;
const row = (code: string, ar: string, en: string): TerminologyRow => [code, 'field', ar, en];

describe('ownership-aware terminology seeding (D-3)', () => {
  it('inserts absent codes, records ownership, and a rerun changes nothing', async () => {
    const f = new FakeRunner();
    await seedTerminologyOwned(qr(f), 'manufacturing', 'M1', [row('a', 'أ', 'A')], 'update');
    await seedTerminologyOwned(qr(f), 'manufacturing', 'M1', [row('a', 'أ', 'A')], 'update');
    expect(f.entries.get('a')).toEqual({ category: 'field', ar: 'أ', en: 'A' });
    expect(f.owners.get('a')).toEqual({ owner: 'manufacturing', migration: 'M1' });
  });

  it('never overwrites a pre-existing (unowned) code, in either mode', async () => {
    for (const mode of ['preserve', 'update'] as const) {
      const f = new FakeRunner();
      f.entries.set('shared', { category: 'field', ar: 'قديم', en: 'old' });
      await seedTerminologyOwned(qr(f), 'manufacturing', 'M1', [row('shared', 'جديد', 'new')], mode);
      expect(f.entries.get('shared')).toEqual({ category: 'field', ar: 'قديم', en: 'old' });
      expect(f.owners.has('shared')).toBe(false);
    }
  });

  it('never overwrites a code owned by another feature', async () => {
    const f = new FakeRunner();
    await seedTerminologyOwned(qr(f), 'treasury', 'T1', [row('x', 'خزينة', 'Treasury')], 'update');
    await seedTerminologyOwned(qr(f), 'manufacturing', 'M1', [row('x', 'تصنيع', 'Manufacturing')], 'update');
    expect(f.entries.get('x')?.en).toBe('Treasury');
    expect(f.owners.get('x')?.owner).toBe('treasury');
  });

  it('a later stage of the same feature may refresh its own wording (update mode) but not in preserve mode', async () => {
    const f = new FakeRunner();
    await seedTerminologyOwned(qr(f), 'manufacturing', 'M1', [row('k', 'قديم', 'old')], 'update');
    await seedTerminologyOwned(qr(f), 'manufacturing', 'M2', [row('k', 'جديد', 'new')], 'preserve');
    expect(f.entries.get('k')?.en).toBe('old');
    await seedTerminologyOwned(qr(f), 'manufacturing', 'M2', [row('k', 'جديد', 'new')], 'update');
    expect(f.entries.get('k')?.en).toBe('new');
    expect(f.owners.get('k')?.migration).toBe('M1');
  });

  it('down deletes only rows this exact migration created; pre-existing, other-owner and earlier-stage rows survive', async () => {
    const f = new FakeRunner();
    f.entries.set('pre', { category: 'field', ar: 'س', en: 'pre' });
    await seedTerminologyOwned(qr(f), 'treasury', 'T1', [row('t', 'ت', 'T')], 'update');
    await seedTerminologyOwned(qr(f), 'manufacturing', 'M1', [row('early', 'ب', 'E')], 'update');
    const m2 = [row('pre', 'x', 'x'), row('t', 'x', 'x'), row('early', 'ب2', 'E2'), row('own', 'م', 'M')];
    await seedTerminologyOwned(qr(f), 'manufacturing', 'M2', m2, 'update');
    await unseedTerminologyOwned(qr(f), 'manufacturing', 'M2', m2);
    expect([...f.entries.keys()].sort()).toEqual(['early', 'pre', 't']);
    expect(f.owners.has('own')).toBe(false);
    expect(f.owners.get('early')?.migration).toBe('M1');
  });

  it('down on a database seeded before the ownership table existed deletes nothing', async () => {
    const f = new FakeRunner();
    f.entries.set('legacy', { category: 'field', ar: 'ل', en: 'legacy' });
    await unseedTerminologyOwned(qr(f), 'manufacturing', 'M1', [row('legacy', 'ل', 'legacy')]);
    expect(f.entries.has('legacy')).toBe(true);
  });
});
