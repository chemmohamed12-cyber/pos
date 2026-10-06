import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { FixedAssetService } from '../application/fixed-asset.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
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

/**
 * D8 (2026-10-05, CTO: keep the manual-JE + link-acquisition architecture, complete the UI workflow) — real PostgreSQL, Company A
 * with Company B as the witness. The UI links an EXISTING posted journal entry to a `pending_acquisition` asset; this proves the
 * read-only candidate lookup that feeds it (a posted entry with a debit on the asset's cost account for EXACTLY its cost, not
 * already linked to another asset), that it creates/posts nothing, and that linking still re-validates and activates the asset.
 */
describe('D8 — fixed-asset acquisition-journal candidates (manual JE + link) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let assets: FixedAssetService;
  let journals: JournalEntryService;
  let maker: string;
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const acc: Record<Key, { cost: string; accum: string; expense: string; offset: string; other: string }> = {
    A: { cost: '', accum: '', expense: '', offset: '', other: '' },
    B: { cost: '', accum: '', expense: '', offset: '', other: '' },
  };
  const mgr = async (k: Key) => (await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId)).manager;

  async function seed(k: Key, companyId: string) {
    const ds = await h.connections.getDataSource(companyId);
    const ids = { cost: randomUUID(), accum: randomUUID(), expense: randomUUID(), offset: randomUUID(), other: randomUUID() };
    acc[k] = ids;
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","isContra","controlFunction") VALUES
       ($1,'1210','Equipment','asset','debit',true,true,true,false,'fixed_asset'),
       ($2,'1219','Accumulated Depreciation','asset','credit',true,true,true,true,'fixed_asset'),
       ($3,'5800','Depreciation Expense','expense','debit',true,true,true,false,NULL),
       ($4,'2190','Acquisition Offset','liability','credit',true,true,true,false,NULL),
       ($5,'1290','Other Asset','asset','debit',true,true,true,false,NULL)`,
      [ids.cost, ids.accum, ids.expense, ids.offset, ids.other],
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
    h = await setUpTwoCompanyHarness({ namePrefix: 'd8_fixed_asset_link', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    ambient = await createAmbientDataSource(h);
    await seed('A', h.companyAId);
    await seed('B', h.companyBId);

    const inert = {} as never;
    const audit = new AuditService(ambient);
    const numbering = new NumberingService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const cfg = { get: () => undefined } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(ambient, audit);
    const glAccounts = new GLAccountService(ambient, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(ambient, process, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(ambient, audit);
    journals = new JournalEntryService(ambient, glAccounts, fiscalPeriods, currencies, audit, events, numbering, process, cfg, dimensions);
    assets = new FixedAssetService(ambient, glAccounts, process, audit);
    maker = (await h.createUserWithAdminRoleIn('FA Maker', h.companyAId)).id;
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('D8 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const base = { name: 'Press', acquisitionDate: '2026-01-15', cost: '12000', usefulLifeMonths: 12 };
  const createAsset = (k: Key, code: string, m: Awaited<ReturnType<typeof mgr>>, cost = '12000') =>
    assets.createAsset({ ...base, code, cost, costAccountId: acc[k].cost, accumulatedDepreciationAccountId: acc[k].accum, depreciationExpenseAccountId: acc[k].expense }, maker, m);
  async function manualJournal(k: Key, m: Awaited<ReturnType<typeof mgr>>, debitAccount: string, amount: string, post: boolean, description: string) {
    const entry = await journals.createEntry(
      { sourceType: 'MANUAL', businessDate: today, description, transactionCurrencyCode: 'EGP', lines: [{ accountId: debitAccount, debit: amount }, { accountId: acc[k].offset, credit: amount }] },
      maker,
      m,
    );
    if (post) await journals.postEntry(entry.id, maker, {}, m);
    return entry.id;
  }

  let jeOk = '';
  let assetA = '';
  let assetA2 = '';

  it('1. CANDIDATES = POSTED entries with a debit on the asset\'s cost account for EXACTLY its cost; drafts, other amounts and other accounts are excluded; nothing is created', async () => {
    const mA = await mgr('A');
    assetA = (await createAsset('A', 'FA-D8-1', mA)).id;
    jeOk = await manualJournal('A', mA, acc.A.cost, '12000', true, 'Press purchase');
    await manualJournal('A', mA, acc.A.cost, '12000', false, 'draft only'); // not posted
    await manualJournal('A', mA, acc.A.cost, '11000', true, 'wrong amount');
    await manualJournal('A', mA, acc.A.other, '12000', true, 'wrong account');

    const countBefore = Number((await mA.query(`SELECT count(*) AS n FROM accounting_journal_entries`))[0].n);
    const candidates = await assets.listAcquisitionCandidates(assetA, mA);
    expect(candidates.map((c) => [c.journalEntryId, c.debit])).toEqual([[jeOk, '12000.0000']]);
    expect(candidates[0].description).toBe('Press purchase');
    expect(Number((await mA.query(`SELECT count(*) AS n FROM accounting_journal_entries`))[0].n)).toBe(countBefore); // read-only
    expect((await assets.getAsset(assetA, mA)).lifecycleState).toBe('pending_acquisition'); // still pending
  });

  it('2. LINK activates the asset (rules re-validated at link time); the linked entry is then no longer a candidate for another asset, and linking it again is rejected', async () => {
    const mA = await mgr('A');
    assetA2 = (await createAsset('A', 'FA-D8-2', mA)).id; // same cost, same account
    expect((await assets.listAcquisitionCandidates(assetA2, mA)).map((c) => c.journalEntryId)).toEqual([jeOk]);

    const linked = await assets.linkAcquisitionJournalEntry(assetA, jeOk, maker, mA);
    expect(linked.lifecycleState).toBe('active');
    expect(linked.acquisitionJournalEntryId).toBe(jeOk);

    expect(await assets.listAcquisitionCandidates(assetA2, mA)).toEqual([]); // already someone's acquisition
    await expect(assets.linkAcquisitionJournalEntry(assetA2, jeOk, maker, mA)).rejects.toBeInstanceOf(ConflictException);
    expect(await assets.listAcquisitionCandidates(assetA, mA)).toEqual([]); // an active asset has no candidates
  });

  it('3. ISOLATION: Company B sees only its own entries/assets; A\'s asset id is unknown to B; the other Company\'s DataSource is never requested', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    const assetB = (await createAsset('B', 'FA-D8-B', mB, '600')).id;
    const jeB = await manualJournal('B', mB, acc.B.cost, '600', true, 'B purchase');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await assets.listAcquisitionCandidates(assetA2, mA);
    });
    expect((await assets.listAcquisitionCandidates(assetB, mB)).map((c) => c.journalEntryId)).toEqual([jeB]);
    await expect(assets.listAcquisitionCandidates(assetA2, mB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(assets.linkAcquisitionJournalEntry(assetB, jeOk, maker, mB)).rejects.toBeInstanceOf(NotFoundException); // A's journal is unknown to B
  });
});
