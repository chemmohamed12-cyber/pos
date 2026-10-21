import { CompanySchemaAdmission, CompanySchemaBehindException, COMPANY_SCHEMA_BEHIND_CODE, SchemaAdmissionMode } from './company-schema-admission';
import { CompanyConnectionManagerService } from './company-connection-manager.service';
import { runOperationalAdmitted } from '../company/company-lifecycle-admission';

/**
 * Company schema admission (1.1.12): the interim-period guard. A release can be live while a Company database is still on an older schema; every acquisition of a Company
 * database must then be refused with ONE stable answer (503 COMPANY_SCHEMA_BEHIND) before any application query runs - never half-served with HTTP 500 and partial writes.
 */
const shipped = () =>
  new Map<string, Set<string>>([
    ['core', new Set(['Core1', 'Core2'])],
    ['sales', new Set(['Sales1', 'Sales2'])],
    ['finance', new Set(['Fin1', 'Fin2'])], // a Company that never had `finance` must not be required to have it
  ]);

function build(executed: string[], mode: SchemaAdmissionMode = 'enforce') {
  let clock = 1_000_000;
  const rows = { current: executed };
  const ds = { query: jest.fn(async () => rows.current.map((name) => ({ name }))) };
  const adm = new CompanySchemaAdmission();
  adm.overrides = { shipped: shipped(), now: () => clock, mode };
  return { adm, ds, rows, tick: (ms: number) => (clock += ms) };
}
const isBehind = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};

describe('CompanySchemaAdmission', () => {
  it('a Company with every migration the build ships for ITS tags is admitted', async () => {
    const { adm, ds } = build(['Core1', 'Core2', 'Sales1', 'Sales2']);
    await expect(adm.assertCurrent('c1', ds as never)).resolves.toBeUndefined();
  });

  it('a Company one migration behind is REFUSED: HTTP 503, stable code, bilingual message, nothing else about the Company', async () => {
    const { adm, ds } = build(['Core1', 'Core2', 'Sales1']);
    const e = (await isBehind(adm.assertCurrent('c1', ds as never))) as CompanySchemaBehindException;
    expect(e).toBeInstanceOf(CompanySchemaBehindException);
    expect(e.getStatus()).toBe(503);
    const body = e.getResponse() as { code: string; message: string };
    expect(body.code).toBe(COMPANY_SCHEMA_BEHIND_CODE);
    expect(body.message).toContain('catch-up');
    expect(body.message).toContain('الإصدارات');
  });

  it('the tag rule is the deploy\'s: a Company that never received a tag is not required to have its migrations; one that has ANY of a tag must have all of it', async () => {
    const { adm, ds, rows } = build(['Core1', 'Core2']); // no sales, no finance at all
    await expect(adm.assertCurrent('c1', ds as never)).resolves.toBeUndefined();
    rows.current = ['Core1', 'Core2', 'Fin1']; // has finance (one of two) -> finance is now required
    adm.invalidate('c1');
    expect(await isBehind(adm.assertCurrent('c1', ds as never))).toBeInstanceOf(CompanySchemaBehindException);
  });

  it('a Company AHEAD of the build (extra migrations it does not know) is admitted: migrations are expand-only, the older build keeps working on it', async () => {
    const { adm, ds } = build(['Core1', 'Core2', 'FromAFutureBuild1999']);
    await expect(adm.assertCurrent('c1', ds as never)).resolves.toBeUndefined();
  });

  it('positive verdicts are cached (one read per TTL, not per request); a refusal is cached only briefly so service resumes within seconds of the catch-up, with no restart', async () => {
    const { adm, ds, rows, tick } = build(['Core1', 'Core2', 'Sales1']); // behind
    expect(await isBehind(adm.assertCurrent('c1', ds as never))).toBeTruthy();
    expect(await isBehind(adm.assertCurrent('c1', ds as never))).toBeTruthy();
    expect(ds.query).toHaveBeenCalledTimes(1); // the refusal itself is cached briefly
    rows.current = ['Core1', 'Core2', 'Sales1', 'Sales2']; // the catch-up completes
    tick(6_000); // > the refusal TTL
    await expect(adm.assertCurrent('c1', ds as never)).resolves.toBeUndefined();
    expect(ds.query).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 50; i++) await adm.assertCurrent('c1', ds as never);
    expect(ds.query).toHaveBeenCalledTimes(2); // admitted verdict cached
    tick(31_000);
    await adm.assertCurrent('c1', ds as never);
    expect(ds.query).toHaveBeenCalledTimes(3);
  });

  it('concurrent requests share ONE read', async () => {
    const { adm, ds } = build(['Core1', 'Core2', 'Sales1', 'Sales2']);
    await Promise.all(Array.from({ length: 20 }, () => adm.assertCurrent('c1', ds as never)));
    expect(ds.query).toHaveBeenCalledTimes(1);
  });

  it('each Company has its own verdict (one behind never blocks another)', async () => {
    const a = build(['Core1', 'Core2', 'Sales1']);
    const b = build(['Core1', 'Core2', 'Sales1', 'Sales2']);
    a.adm.overrides = { ...a.adm.overrides, shipped: shipped() };
    expect(await isBehind(a.adm.assertCurrent('A', a.ds as never))).toBeTruthy();
    await expect(b.adm.assertCurrent('B', b.ds as never)).resolves.toBeUndefined();
  });

  it('report mode logs but admits; off disables the check entirely (no read at all)', async () => {
    const r = build(['Core1'], 'report');
    await expect(r.adm.assertCurrent('c1', r.ds as never)).resolves.toBeUndefined();
    const o = build(['Core1'], 'off');
    await expect(o.adm.assertCurrent('c1', o.ds as never)).resolves.toBeUndefined();
    expect(o.ds.query).not.toHaveBeenCalled();
  });

  it('where the check cannot judge it admits and does NOT cache: a failed read (the real error surfaces from the real query) and a build with no compiled migrations', async () => {
    const { adm, ds, rows } = build(['Core1']);
    ds.query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(adm.assertCurrent('c1', ds as never)).resolves.toBeUndefined();
    expect(await isBehind(adm.assertCurrent('c1', ds as never))).toBeTruthy(); // the very next request judges again (and now sees it is behind)
    void rows;
    const empty = new CompanySchemaAdmission();
    empty.overrides = { shipped: new Map([['core', new Set<string>()]]), mode: 'enforce' };
    const ds2 = { query: jest.fn() };
    await expect(empty.assertCurrent('c1', ds2 as never)).resolves.toBeUndefined();
    expect(ds2.query).not.toHaveBeenCalled();
  });
});

describe('CompanyConnectionManagerService x schema admission', () => {
  const registry = { id: 'r1', host: 'h', port: 1, databaseName: 'db', status: 'ACTIVE' };
  function manager(admissionImpl: (id: string) => Promise<void>) {
    const dataSource = { isInitialized: true, initialize: jest.fn(), destroy: jest.fn() };
    const registryService = { findByCompanyId: jest.fn(async () => registry), getDecryptedCredential: jest.fn(async () => JSON.stringify({ username: 'u', password: 'p' })), findAllActive: jest.fn() };
    const admission = { assertCurrent: jest.fn(async (id: string) => admissionImpl(id)) };
    const m = new CompanyConnectionManagerService(registryService as never, admission as never);
    // put a live connection into the cache without opening a real one
    (m as unknown as { cache: Map<string, unknown> }).cache.set('c1', { dataSource, fingerprint: 'h:1:db' });
    return { m, admission, dataSource };
  }

  it('every acquisition - including a cached connection - goes through the admission first', async () => {
    const { m, admission, dataSource } = manager(async () => undefined);
    expect(await m.getDataSource('c1')).toBe(dataSource);
    expect(await m.getDataSource('c1')).toBe(dataSource);
    expect(admission.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it('a Company behind the build never hands out its DataSource', async () => {
    const { m } = manager(async () => {
      throw new CompanySchemaBehindException();
    });
    await expect(m.getDataSource('c1')).rejects.toBeInstanceOf(CompanySchemaBehindException);
  });

  it('LA-1 Layer 2: a READY Company that is behind is DEFERRED like a non-READY one (admitted:false, reason COMPANY_SCHEMA_BEHIND), the work never runs', async () => {
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      query: jest.fn(async () => [{ status: 'READY' }]),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      isTransactionActive: true,
    };
    const platform = { createQueryRunner: () => queryRunner };
    const connections = {
      getDataSource: jest.fn(async () => {
        throw new CompanySchemaBehindException();
      }),
    };
    const work = jest.fn();
    const r = await runOperationalAdmitted(platform as never, connections as never, 'c1', work);
    expect(r).toEqual({ admitted: false, reason: COMPANY_SCHEMA_BEHIND_CODE, status: 'READY' });
    expect(work).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });
});
