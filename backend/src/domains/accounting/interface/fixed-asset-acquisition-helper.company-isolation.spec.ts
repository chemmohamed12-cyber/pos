import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { FixedAssetService } from '../application/fixed-asset.service';
import { FixedAssetAcquisitionService } from '../application/fixed-asset-acquisition.service';
import { DepreciationService } from '../application/depreciation.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

const KEY = 'accounting.fixed_asset_acquisition_clearing_account_code';

/**
 * D8 Acquisition-Journal Helper (2026-10-06, CTO Option C — Acquisition Clearing). Real PostgreSQL, Company A with Company B as the witness.
 * One action on a pending asset: Dr asset cost / Cr the CONFIGURED Fixed Asset Acquisition Clearing account (never AP, never Bank, never a
 * default), posted through the Event Engine and linked, in one transaction; rejected before any mutation when the account is not usable.
 */
describe('D8 acquisition-journal helper — Dr cost / Cr Acquisition Clearing, fail-closed — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let assets: FixedAssetService;
  let acquisitions: FixedAssetAcquisitionService;
  let depreciation: DepreciationService;
  let maker = '';
  const config: Record<string, string> = {};
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const acc: Record<Key, Record<string, string>> = { A: {}, B: {} };
  const mgr = async (k: Key) => (await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId)).manager;

  async function seed(k: Key, companyId: string) {
    const ds = await h.connections.getDataSource(companyId);
    const ids: Record<string, string> = { cost: randomUUID(), accum: randomUUID(), expense: randomUUID(), clearing: randomUUID(), header: randomUUID(), inactive: randomUUID(), ap: randomUUID(), bank: randomUUID() };
    acc[k] = ids;
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","isContra","controlFunction") VALUES
       ($1,'1210','Equipment','asset','debit',true,true,true,false,'fixed_asset'),
       ($2,'1219','Accumulated Depreciation','asset','credit',true,true,true,true,'fixed_asset'),
       ($3,'5800','Depreciation Expense','expense','debit',true,true,true,false,NULL),
       ($4,'2950','Fixed Asset Acquisition Clearing','liability','credit',true,true,true,false,NULL),
       ($5,'2900','Clearing Header','liability','credit',false,true,true,false,NULL),
       ($6,'2951','Inactive Clearing','liability','credit',true,true,false,false,NULL),
       ($7,'2101','Accounts Payable','liability','credit',true,false,true,false,'ap'),
       ($8,'1102','Bank','asset','debit',true,false,true,false,'bank')`,
      [ids.cost, ids.accum, ids.expense, ids.clearing, ids.header, ids.inactive, ids.ap, ids.bank],
    );
    const fy = randomUUID();
    const fp = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
    await new NumberingService(ambient).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'd8_acq_helper', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    ambient = await createAmbientDataSource(h);
    await seed('A', h.companyAId);
    await seed('B', h.companyBId);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const numbering = new NumberingService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const cfg = { get: (k: string) => config[k] } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(ambient, audit);
    const glAccounts = new GLAccountService(ambient, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(ambient, process, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(ambient, audit);
    const journals = new JournalEntryService(ambient, glAccounts, fiscalPeriods, currencies, audit, events, numbering, process, cfg, dimensions);
    const registry = new FinancialEventHandlerRegistry();
    const financialEvents = new FinancialEventService(ambient, currencies, journals, audit, events, registry, cfg);
    financialEvents.onModuleInit();
    assets = new FixedAssetService(ambient, glAccounts, process, audit);
    acquisitions = new FixedAssetAcquisitionService(ambient, assets, financialEvents, registry, audit);
    acquisitions.onModuleInit();
    depreciation = new DepreciationService(ambient, currencies, financialEvents, registry, process, audit);
    await depreciation.onModuleInit();
    maker = (await h.createUserWithAdminRoleIn('D8 Maker', h.companyAId)).id;
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('D8 helper teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const newAsset = async (k: Key, code: string, cost = '12000', acquisitionDate = `${year}-01-15`) =>
    (await assets.createAsset({ code, name: code, acquisitionDate, cost, usefulLifeMonths: 12, costAccountId: acc[k].cost, accumulatedDepreciationAccountId: acc[k].accum, depreciationExpenseAccountId: acc[k].expense }, maker, await mgr(k))).id;
  const counts = async (k: Key) => {
    const m = await mgr(k);
    const n = async (t: string) => Number((await m.query(`SELECT count(*) AS n FROM "${t}"`))[0].n);
    return [await n('accounting_journal_entries'), await n('accounting_financial_events')];
  };
  const net = async (k: Key, accountId: string) =>
    Number((await (await mgr(k)).query(`SELECT COALESCE(SUM("debitBase" - "creditBase"), 0) AS t FROM accounting_journal_lines WHERE "accountId" = $1`, [accountId]))[0].t);
  const stateOf = async (k: Key, id: string) => (await assets.getAsset(id, await mgr(k))).lifecycleState;

  let assetA = '';

  it('1. FAIL CLOSED before any mutation: clearing account unset / unknown / header / inactive / control (AP) → rejected naming the config key; no journal, no event, the asset stays pending', async () => {
    assetA = await newAsset('A', 'FA-H-1');
    const mA = await mgr('A');
    const before = await counts('A');
    for (const [value, reason] of [['', 'unset'], ['9999', 'not_found'], ['2900', 'not_postable'], ['2951', 'inactive'], ['2101', 'is_control_account']] as const) {
      config[KEY] = value;
      await expect(acquisitions.createAcquisitionJournal(assetA, maker, mA)).rejects.toThrow(new RegExp(`\\(${reason}\\).*${KEY}`));
    }
    expect(await counts('A')).toEqual(before);
    expect(await stateOf('A', assetA)).toBe('pending_acquisition');
  });

  it('2. HAPPY PATH (Option C): Dr asset cost 12000 / Cr Acquisition Clearing 12000, balanced, posted + linked → the asset is ACTIVE; neither AP nor Bank is touched; the GL reads back exactly', async () => {
    config[KEY] = '2950';
    const mA = await mgr('A');
    const r = await acquisitions.createAcquisitionJournal(assetA, maker, mA);
    expect(r.asset.lifecycleState).toBe('active');
    expect(r.asset.acquisitionJournalEntryId).toBe(r.journalEntryId);
    const lines = (await mA.query(`SELECT "accountId", "debitBase" AS d, "creditBase" AS c FROM accounting_journal_lines WHERE "journalEntryId" = $1`, [r.journalEntryId])) as Array<{ accountId: string; d: string; c: string }>;
    expect(lines.map((l) => [l.accountId, Number(l.d), Number(l.c)]).sort()).toEqual([[acc.A.cost, 12000, 0], [acc.A.clearing, 0, 12000]].sort());
    expect(lines.reduce((s, l) => s + Number(l.d) - Number(l.c), 0)).toBe(0);
    expect(await net('A', acc.A.cost)).toBeCloseTo(12000, 2);
    expect(await net('A', acc.A.clearing)).toBeCloseTo(-12000, 2);
    expect(await net('A', acc.A.ap)).toBe(0);
    expect(await net('A', acc.A.bank)).toBe(0);
    const ev = await mA.query(`SELECT status, "eventType" FROM accounting_financial_events WHERE "sourceEntityId" = $1`, [assetA]);
    expect(ev).toEqual([{ status: 'POSTED', eventType: 'accounting.fixed_asset.acquisition.requested' }]);
  });

  it('3. NOT REPEATABLE: a second call is refused (asset no longer pending) and creates nothing; the asset is a normal active asset — a depreciation run charges it', async () => {
    const mA = await mgr('A');
    const before = await counts('A');
    await expect(acquisitions.createAcquisitionJournal(assetA, maker, mA)).rejects.toBeInstanceOf(ConflictException);
    expect(await counts('A')).toEqual(before);
    const run = await depreciation.runDepreciation(`${year}-03`, maker, undefined, mA);
    expect(run.lines.map((l) => l.calculatedAmount.slice(0, 7))).toEqual(['1000.00']);
  });

  it('4. POSTING FAILURE rolls everything back: an asset acquired in a date with no open fiscal period is rejected with the engine\'s reason — no journal, no event row, the asset stays pending', async () => {
    const old = await newAsset('A', 'FA-H-OLD', '500', '2019-03-01');
    const mA = await mgr('A');
    const before = await counts('A');
    await expect(acquisitions.createAcquisitionJournal(old, maker, mA)).rejects.toThrow(/could not be posted \(REJECTED.*Nothing was created/);
    expect(await counts('A')).toEqual(before);
    expect(await stateOf('A', old)).toBe('pending_acquisition');
  });

  it('5. ISOLATION: Company B\'s helper posts only in B against B\'s own chart; A is untouched by B; B\'s DataSource is never requested for A\'s calls; the Platform DB holds no accounting tables', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    const aBefore = await counts('A');
    const assetB = await newAsset('B', 'FA-H-B', '700');
    expect(await counts('B')).toEqual([0, 0]);
    const rB = await acquisitions.createAcquisitionJournal(assetB, maker, mB);
    expect(rB.asset.lifecycleState).toBe('active');
    expect(await net('B', acc.B.cost)).toBeCloseTo(700, 2);
    expect(await net('B', acc.B.clearing)).toBeCloseTo(-700, 2);
    expect(await counts('A')).toEqual(aBefore);
    expect(await net('A', acc.A.cost)).toBeCloseTo(12000, 2); // still only A's own asset
    const a2 = await newAsset('A', 'FA-H-2', '300');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await acquisitions.createAcquisitionJournal(a2, maker, mA);
    });
    expect(await net('B', acc.B.cost)).toBeCloseTo(700, 2); // A's second acquisition never reached B
    const platform = await ambient.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('accounting_fixed_assets','accounting_journal_lines')`);
    expect(platform).toEqual([]);
  });
});
