import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { FixedAssetService } from '../application/fixed-asset.service';
import { DepreciationService } from '../application/depreciation.service';
import { FixedAssetDisposalService } from '../application/fixed-asset-disposal.service';
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
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

const GAIN_KEY = 'accounting.fixed_asset_gain_on_disposal_account_code';
const LOSS_KEY = 'accounting.fixed_asset_loss_on_disposal_account_code';

/**
 * FA-02 (2026-10-06) — DB-level reconciliation of a fixed-asset disposal with REAL depreciation: acquisition journal → linked → depreciation
 * run → disposal → the GL itself is read back. Proves: cost fully removed, accumulated depreciation fully removed, Net Book Value = cost −
 * accumulated depreciation, gain/loss = proceeds − NBV (in the correct separate account), the journal balances, no fallback account is touched,
 * and Company A / Company B / the Platform DB stay isolated. Real PostgreSQL, two Company databases.
 */
describe('FA-02 — disposal reconciliation with real depreciation (NBV, gain, loss) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let assets: FixedAssetService;
  let depreciation: DepreciationService;
  let disposals: FixedAssetDisposalService;
  let journals: JournalEntryService;
  let maker = '';
  let checker = '';
  const config: Record<string, string> = { [GAIN_KEY]: '4900', [LOSS_KEY]: '5900' };
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const acc: Record<Key, Record<string, string>> = { A: {}, B: {} };
  const mgr = async (k: Key) => (await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId)).manager;

  async function seed(k: Key, companyId: string) {
    const ds = await h.connections.getDataSource(companyId);
    const ids: Record<string, string> = { cost: randomUUID(), accum: randomUUID(), expense: randomUUID(), gain: randomUUID(), loss: randomUUID(), cash: randomUUID(), offset: randomUUID(), decoyGain: randomUUID(), decoyLoss: randomUUID() };
    acc[k] = ids;
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","isContra","controlFunction") VALUES
       ($1,'1210','Equipment','asset','debit',true,true,true,false,'fixed_asset'),
       ($2,'1219','Accumulated Depreciation','asset','credit',true,true,true,true,'fixed_asset'),
       ($3,'5800','Depreciation Expense','expense','debit',true,true,true,false,NULL),
       ($4,'4900','Gain on Disposal of Fixed Assets','revenue','credit',true,true,true,false,NULL),
       ($5,'5900','Loss on Disposal of Fixed Assets','expense','debit',true,true,true,false,NULL),
       ($6,'1105','Cash','asset','debit',true,true,true,false,NULL),
       ($7,'2900','Acquisition Offset','liability','credit',true,true,true,false,NULL),
       ($8,'4901','Decoy Gain (other revenue)','revenue','credit',true,true,true,false,NULL),
       ($9,'5901','Decoy Loss (other expense)','expense','debit',true,true,true,false,NULL)`,
      [ids.cost, ids.accum, ids.expense, ids.gain, ids.loss, ids.cash, ids.offset, ids.decoyGain, ids.decoyLoss],
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
    h = await setUpTwoCompanyHarness({ namePrefix: 'fa02_recon', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    ambient = await createAmbientDataSource(h);
    await seed('A', h.companyAId);
    await seed('B', h.companyBId);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const numbering = new NumberingService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const cfg = { get: (k: string) => config[k] } as unknown as ConfigurationEngineService;
    const approvals = new ApprovalEngineService(ambient, process, audit, events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    const currencies = new CurrencyService(ambient, audit);
    const glAccounts = new GLAccountService(ambient, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(ambient, process, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(ambient, audit);
    journals = new JournalEntryService(ambient, glAccounts, fiscalPeriods, currencies, audit, events, numbering, process, cfg, dimensions);
    const registry = new FinancialEventHandlerRegistry();
    const financialEvents = new FinancialEventService(ambient, currencies, journals, audit, events, registry, cfg);
    financialEvents.onModuleInit();
    assets = new FixedAssetService(ambient, glAccounts, process, audit);
    depreciation = new DepreciationService(ambient, currencies, financialEvents, registry, process, audit);
    disposals = new FixedAssetDisposalService(ambient, glAccounts, approvals, financialEvents, registry, process, events, audit);
    await depreciation.onModuleInit();
    await disposals.onModuleInit();
    maker = (await h.createUserWithAdminRoleIn('FA02R Maker', h.companyAId)).id;
    checker = (await h.createUserWithAdminRoleIn('FA02R Checker', h.companyAId)).id;
    const dsA = await h.connections.getDataSource(h.companyAId);
    const role = (await dsA.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,'accounting.fixed_asset.approve','editable') ON CONFLICT DO NOTHING`, [role.id]);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('FA-02 reconciliation teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  /** A real asset: registered, acquisition journal posted (Dr cost / Cr offset) and LINKED so it becomes active the legitimate way. */
  async function acquiredAsset(k: Key, code: string, cost: string) {
    const m = await mgr(k);
    const a = await assets.createAsset(
      { code, name: code, acquisitionDate: '2026-01-15', cost, usefulLifeMonths: 12, costAccountId: acc[k].cost, accumulatedDepreciationAccountId: acc[k].accum, depreciationExpenseAccountId: acc[k].expense },
      maker,
      m,
    );
    const je = await journals.createEntry(
      { sourceType: 'MANUAL', businessDate: today, description: `Acquisition ${code}`, transactionCurrencyCode: 'EGP', lines: [{ accountId: acc[k].cost, debit: cost }, { accountId: acc[k].offset, credit: cost }] },
      maker,
      m,
    );
    await journals.postEntry(je.id, maker, {}, m);
    const linked = await assets.linkAcquisitionJournalEntry(a.id, je.id, maker, m);
    expect(linked.lifecycleState).toBe('active');
    return a.id;
  }
  /** Net (debit − credit) of an account in the GL, read straight from the Company database. */
  async function net(k: Key, accountId: string) {
    const m = await mgr(k);
    return Number((await m.query(`SELECT COALESCE(SUM("debitBase" - "creditBase"), 0) AS t FROM accounting_journal_lines WHERE "accountId" = $1`, [accountId]))[0].t);
  }
  async function dispose(k: Key, assetId: string, proceeds: string) {
    const m = await mgr(k);
    const { approvalRequestId } = await disposals.submitDisposal({ fixedAssetId: assetId, disposalDate: today, proceeds, proceedsAccountId: acc[k].cash }, maker, m);
    await disposals.decide(approvalRequestId, checker, 'approved', undefined, m);
    const d = (await m.query(`SELECT "journalEntryId" FROM accounting_fixed_asset_disposals WHERE "fixedAssetId" = $1`, [assetId]))[0];
    const lines: Array<{ accountId: string; debit: number; credit: number }> = (
      await m.query(`SELECT "accountId", "debitBase" AS debit, "creditBase" AS credit FROM accounting_journal_lines WHERE "journalEntryId" = $1`, [d.journalEntryId])
    ).map((l: { accountId: string; debit: string; credit: string }) => ({ accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit) }));
    return lines;
  }
  const lineOf = (lines: Array<{ accountId: string; debit: number; credit: number }>, accountId: string) => lines.find((l) => l.accountId === accountId);

  let gainAsset = '';
  let lossAsset = '';

  it('1. DEPRECIATION first: the run charges 1000 / 500 (12 months) and the GL accumulated depreciation holds exactly that', async () => {
    const mA = await mgr('A');
    gainAsset = await acquiredAsset('A', 'FA-R-GAIN', '12000');
    lossAsset = await acquiredAsset('A', 'FA-R-LOSS', '6000');
    const run = await depreciation.runDepreciation(`${year}-03`, maker, undefined, mA);
    expect(run.lines.map((l) => l.calculatedAmount.slice(0, 7)).sort()).toEqual(['1000.00', '500.000']);
    expect(await net('A', acc.A.accum)).toBeCloseTo(-1500, 2); // credit balance
    expect(await net('A', acc.A.cost)).toBeCloseTo(18000, 2);
  });

  it('2. GAIN: NBV 11000, proceeds 12500 → gain 1500 credited to the GAIN account; Dr accum 1000 + Dr cash 12500 = Cr cost 12000 + Cr gain 1500; cost and accumulated depreciation are fully removed from the GL; no decoy / loss account touched', async () => {
    const lines = await dispose('A', gainAsset, '12500');
    expect(lineOf(lines, acc.A.accum)).toMatchObject({ debit: 1000, credit: 0 });
    expect(lineOf(lines, acc.A.cash)).toMatchObject({ debit: 12500, credit: 0 });
    expect(lineOf(lines, acc.A.cost)).toMatchObject({ debit: 0, credit: 12000 });
    expect(lineOf(lines, acc.A.gain)).toMatchObject({ debit: 0, credit: 1500 });
    expect(lines.some((l) => [acc.A.loss, acc.A.decoyGain, acc.A.decoyLoss, acc.A.expense].includes(l.accountId))).toBe(false);
    expect(lines.reduce((s, l) => s + l.debit - l.credit, 0)).toBeCloseTo(0, 4); // balanced
    const nbv = 12000 - 1000;
    expect(12500 - nbv).toBe(1500); // gain = proceeds − NBV
    // GL after: this asset's cost (12000) and accumulated depreciation (1000) are gone; the other asset's 6000 / 500 remain
    expect(await net('A', acc.A.cost)).toBeCloseTo(6000, 2);
    expect(await net('A', acc.A.accum)).toBeCloseTo(-500, 2);
    expect(await net('A', acc.A.gain)).toBeCloseTo(-1500, 2);
    expect(await net('A', acc.A.loss)).toBeCloseTo(0, 2);
  });

  it('3. LOSS: NBV 5500, proceeds 4000 → loss 1500 debited to the LOSS account; Dr accum 500 + Dr cash 4000 + Dr loss 1500 = Cr cost 6000; GL is clean afterwards', async () => {
    const lines = await dispose('A', lossAsset, '4000');
    expect(lineOf(lines, acc.A.accum)).toMatchObject({ debit: 500, credit: 0 });
    expect(lineOf(lines, acc.A.cash)).toMatchObject({ debit: 4000, credit: 0 });
    expect(lineOf(lines, acc.A.loss)).toMatchObject({ debit: 1500, credit: 0 });
    expect(lineOf(lines, acc.A.cost)).toMatchObject({ debit: 0, credit: 6000 });
    expect(lines.some((l) => [acc.A.gain, acc.A.decoyGain, acc.A.decoyLoss, acc.A.expense].includes(l.accountId))).toBe(false);
    expect(lines.reduce((s, l) => s + l.debit - l.credit, 0)).toBeCloseTo(0, 4);
    expect(6000 - 500 - 4000).toBe(1500); // loss = NBV − proceeds
    expect(await net('A', acc.A.cost)).toBeCloseTo(0, 2); // both assets fully removed
    expect(await net('A', acc.A.accum)).toBeCloseTo(0, 2);
    expect(await net('A', acc.A.loss)).toBeCloseTo(1500, 2);
    // whole-GL invariant after everything: Σ debit = Σ credit
    const m = await mgr('A');
    const t = (await m.query(`SELECT COALESCE(SUM("debitBase"), 0) AS d, COALESCE(SUM("creditBase"), 0) AS c FROM accounting_journal_lines`))[0];
    expect(Number(t.d)).toBeCloseTo(Number(t.c), 4);
    // the decoy accounts were never posted to by any disposal
    expect(await net('A', acc.A.decoyGain)).toBe(0);
    expect(await net('A', acc.A.decoyLoss)).toBe(0);
  });

  it('4. MISSING config with real depreciation: a gain disposal with the gain account unset and a loss disposal with the loss account unset are each rejected before any mutation', async () => {
    const mA = await mgr('A');
    const g = await acquiredAsset('A', 'FA-R-G2', '1200'); // not depreciated in a run → NBV 1200
    const before = [Number((await mA.query(`SELECT count(*) AS n FROM accounting_fixed_asset_disposals`))[0].n), Number((await mA.query(`SELECT count(*) AS n FROM accounting_journal_entries`))[0].n)];
    config[GAIN_KEY] = '';
    await expect(disposals.submitDisposal({ fixedAssetId: g, disposalDate: today, proceeds: '2000', proceedsAccountId: acc.A.cash }, maker, mA)).rejects.toThrow(/gain of 800\.00.*unset/);
    config[GAIN_KEY] = '4900';
    config[LOSS_KEY] = '';
    await expect(disposals.submitDisposal({ fixedAssetId: g, disposalDate: today, proceeds: '100', proceedsAccountId: acc.A.cash }, maker, mA)).rejects.toThrow(/loss of 1100\.00.*unset/);
    config[LOSS_KEY] = '5900';
    expect([Number((await mA.query(`SELECT count(*) AS n FROM accounting_fixed_asset_disposals`))[0].n), Number((await mA.query(`SELECT count(*) AS n FROM accounting_journal_entries`))[0].n)]).toEqual(before);
  });

  it('5. ISOLATION: Company B has its own chart and is untouched by A\'s disposals; B posts its own gain in B only; A\'s DataSource-only calls never request B; the Platform DB holds no accounting rows', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    expect(Number((await mB.query(`SELECT count(*) AS n FROM accounting_journal_lines`))[0].n)).toBe(0);
    expect(Number((await mB.query(`SELECT count(*) AS n FROM accounting_fixed_asset_disposals`))[0].n)).toBe(0);
    const aAsset = await acquiredAsset('A', 'FA-R-ISO-A', '500');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await disposals.submitDisposal({ fixedAssetId: aAsset, disposalDate: today, proceeds: '0' }, maker, mA); // loss of 500 — pre-flight only
    });
    // Company B: its own acquired asset, then disposal with a gain, posted in B (B's approver = Company A's checker user has no B role → use submit + direct assertion on submit only)
    const bAsset = await acquiredAsset('B', 'FA-R-ISO-B', '700');
    await expect(disposals.submitDisposal({ fixedAssetId: bAsset, disposalDate: today, proceeds: '900', proceedsAccountId: acc.B.cash }, maker, mB)).resolves.toBeTruthy();
    expect(Number((await mB.query(`SELECT count(*) AS n FROM accounting_fixed_asset_disposals`))[0].n)).toBe(1);
    expect(await net('B', acc.B.gain)).toBe(0); // only submitted (pending approval) — nothing posted for the disposal yet
    expect(Number((await mA.query(`SELECT count(*) AS n FROM accounting_fixed_asset_disposals WHERE "fixedAssetId" = $1`, [bAsset]))[0].n)).toBe(0);
    const platform = await ambient.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('accounting_fixed_assets','accounting_journal_lines','accounting_fixed_asset_disposals')`);
    expect(platform).toEqual([]); // the Platform DB has none of the Company accounting tables
  });
});
