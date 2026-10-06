import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { FixedAssetService } from '../application/fixed-asset.service';
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
 * FA-02 (2026-10-06, CTO) — fixed-asset disposal with TWO separate configured accounts: Gain → credit the gain account, Loss → debit
 * the loss account; the account the result needs must be configured and postable, else the disposal is REJECTED BEFORE ANY MUTATION
 * (no disposal row, no approval request, no approval decision); no fallback, no hard-coded account. Real PostgreSQL, Company A with
 * Company B as the witness; the configuration is a mutable test double so every config state can be exercised.
 */
describe('FA-02 — disposal gain/loss accounts (separate, configured, fail-closed) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let assets: FixedAssetService;
  let disposals: FixedAssetDisposalService;
  let journals: JournalEntryService;
  let maker = '';
  let checker = '';
  const config: Record<string, string> = {};
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const acc: Record<Key, Record<string, string>> = { A: {}, B: {} };
  const mgr = async (k: Key) => (await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId)).manager;

  async function seed(k: Key, companyId: string) {
    const ds = await h.connections.getDataSource(companyId);
    const ids = { cost: randomUUID(), accum: randomUUID(), expense: randomUUID(), gain: randomUUID(), loss: randomUUID(), cash: randomUUID(), header: randomUUID(), inactive: randomUUID(), control: randomUUID(), offset: randomUUID() };
    acc[k] = ids;
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","isContra","controlFunction") VALUES
       ($1,'1210','Equipment','asset','debit',true,true,true,false,'fixed_asset'),
       ($2,'1219','Accumulated Depreciation','asset','credit',true,true,true,true,'fixed_asset'),
       ($3,'5800','Depreciation Expense','expense','debit',true,true,true,false,NULL),
       ($4,'4900','Gain on Disposal of Fixed Assets','revenue','credit',true,true,true,false,NULL),
       ($5,'5900','Loss on Disposal of Fixed Assets','expense','debit',true,true,true,false,NULL),
       ($6,'1105','Cash','asset','debit',true,true,true,false,NULL),
       ($7,'4000','Revenue Header','revenue','credit',false,true,true,false,NULL),
       ($8,'4990','Inactive Gain','revenue','credit',true,true,false,false,NULL),
       ($9,'2190','Control-like','liability','credit',true,false,true,false,'ap'),
       ($10,'2900','Offset','liability','credit',true,true,true,false,NULL)`,
      [ids.cost, ids.accum, ids.expense, ids.gain, ids.loss, ids.cash, ids.header, ids.inactive, ids.control, ids.offset],
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
    h = await setUpTwoCompanyHarness({ namePrefix: 'fa02_disposal', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    disposals = new FixedAssetDisposalService(ambient, glAccounts, approvals, financialEvents, registry, process, events, audit);
    await disposals.onModuleInit();
    maker = (await h.createUserWithAdminRoleIn('FA02 Maker', h.companyAId)).id;
    checker = (await h.createUserWithAdminRoleIn('FA02 Checker', h.companyAId)).id;
    const dsA = await h.connections.getDataSource(h.companyAId);
    const role = (await dsA.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,'accounting.fixed_asset.approve','editable') ON CONFLICT DO NOTHING`, [role.id]);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('FA-02 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  async function activeAsset(k: Key, code: string, cost: string) {
    const m = await mgr(k);
    const a = await assets.createAsset(
      { code, name: code, acquisitionDate: '2026-01-15', cost, usefulLifeMonths: 12, costAccountId: acc[k].cost, accumulatedDepreciationAccountId: acc[k].accum, depreciationExpenseAccountId: acc[k].expense },
      maker,
      m,
    );
    await m.query(`UPDATE process_instances SET "currentState" = 'active' WHERE "entityId" = $1 AND "entityType" = 'FixedAsset'`, [a.id]);
    return a.id;
  }
  const counts = async (m: Awaited<ReturnType<typeof mgr>>) => [
    Number((await m.query(`SELECT count(*) AS n FROM accounting_fixed_asset_disposals`))[0].n),
    Number((await m.query(`SELECT count(*) AS n FROM approval_requests WHERE "requestTypeCode" LIKE '%dispos%' OR "requestTypeCode" LIKE 'accounting.fixed_asset%'`))[0].n),
  ];
  async function postedLines(m: Awaited<ReturnType<typeof mgr>>, assetId: string) {
    const d = (await m.query(`SELECT "journalEntryId" FROM accounting_fixed_asset_disposals WHERE "fixedAssetId" = $1`, [assetId]))[0];
    expect(d.journalEntryId).toBeTruthy();
    const lines: Array<{ accountId: string; debit: string; credit: string }> = await m.query(`SELECT "accountId", "debitBase" AS debit, "creditBase" AS credit FROM accounting_journal_lines WHERE "journalEntryId" = $1`, [d.journalEntryId]);
    return lines.map((l) => ({ accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit) }));
  }

  it('1. LOSS needs the LOSS account: unset / unknown / header / inactive / control-function accounts are rejected BEFORE any mutation; a usable one lets it through', async () => {
    const mA = await mgr('A');
    const assetId = await activeAsset('A', 'FA-LOSS', '12000'); // no depreciation, no proceeds → loss 12000
    const before = await counts(mA);
    config[GAIN_KEY] = '4900'; // gain is configured — irrelevant for a loss
    for (const [value, reason] of [['', 'unset'], ['9999', 'not_found'], ['4000', 'not_postable'], ['4990', 'inactive'], ['2190', 'is_control_account']] as const) {
      config[LOSS_KEY] = value;
      await expect(disposals.submitDisposal({ fixedAssetId: assetId, disposalDate: today }, maker, mA)).rejects.toThrow(new RegExp(`loss of 12000\\.00.*\\(${reason}\\).*${LOSS_KEY}`));
    }
    expect(await counts(mA)).toEqual(before); // no disposal row, no approval request

    config[LOSS_KEY] = '5900';
    const { approvalRequestId } = await disposals.submitDisposal({ fixedAssetId: assetId, disposalDate: today }, maker, mA);
    await disposals.decide(approvalRequestId, checker, 'approved', undefined, mA);
    const lines = await postedLines(mA, assetId);
    expect(lines).toEqual(expect.arrayContaining([{ accountId: acc.A.cost, debit: 0, credit: 12000 }, { accountId: acc.A.loss, debit: 12000, credit: 0 }]));
    expect(lines.reduce((s, l) => s + l.debit - l.credit, 0)).toBe(0); // balanced
    expect(lines.some((l) => l.accountId === acc.A.gain)).toBe(false);
  });

  it('2. GAIN needs the GAIN account (and NOT the loss account): unset is rejected before mutation; configured → Cr gain, balanced, no loss line', async () => {
    const mA = await mgr('A');
    const assetId = await activeAsset('A', 'FA-GAIN', '1000');
    const before = await counts(mA);
    config[LOSS_KEY] = ''; // loss NOT configured — a gain disposal must not care
    config[GAIN_KEY] = '';
    await expect(disposals.submitDisposal({ fixedAssetId: assetId, disposalDate: today, proceeds: '5000', proceedsAccountId: acc.A.cash }, maker, mA)).rejects.toThrow(new RegExp(`gain of 4000\\.00.*\\(unset\\).*${GAIN_KEY}`));
    expect(await counts(mA)).toEqual(before);

    config[GAIN_KEY] = '4900';
    const { approvalRequestId } = await disposals.submitDisposal({ fixedAssetId: assetId, disposalDate: today, proceeds: '5000', proceedsAccountId: acc.A.cash }, maker, mA);
    await disposals.decide(approvalRequestId, checker, 'approved', undefined, mA);
    const lines = await postedLines(mA, assetId);
    expect(lines).toEqual(expect.arrayContaining([{ accountId: acc.A.cash, debit: 5000, credit: 0 }, { accountId: acc.A.cost, debit: 0, credit: 1000 }, { accountId: acc.A.gain, debit: 0, credit: 4000 }]));
    expect(lines.reduce((s, l) => s + l.debit - l.credit, 0)).toBe(0);
    expect(lines.some((l) => l.accountId === acc.A.loss)).toBe(false);
  });

  it('3. BREAK-EVEN (proceeds = cost): no gain/loss line and neither account needs to be configured', async () => {
    const mA = await mgr('A');
    const assetId = await activeAsset('A', 'FA-EVEN', '800');
    config[GAIN_KEY] = '';
    config[LOSS_KEY] = '';
    const { approvalRequestId } = await disposals.submitDisposal({ fixedAssetId: assetId, disposalDate: today, proceeds: '800', proceedsAccountId: acc.A.cash }, maker, mA);
    await disposals.decide(approvalRequestId, checker, 'approved', undefined, mA);
    const lines = await postedLines(mA, assetId);
    expect(lines.map((l) => l.accountId).sort()).toEqual([acc.A.cash, acc.A.cost].sort());
  });

  it('4. APPROVAL re-checks: if the configured account becomes unusable after submission, the decision is refused BEFORE it is recorded (still pending), and succeeds once fixed', async () => {
    const mA = await mgr('A');
    const assetId = await activeAsset('A', 'FA-LATE', '3000');
    config[LOSS_KEY] = '5900';
    const { approvalRequestId } = await disposals.submitDisposal({ fixedAssetId: assetId, disposalDate: today }, maker, mA);
    config[LOSS_KEY] = '';
    await expect(disposals.decide(approvalRequestId, checker, 'approved', undefined, mA)).rejects.toBeInstanceOf(ConflictException);
    expect(Number((await mA.query(`SELECT count(*) AS n FROM approval_decisions WHERE "approvalRequestId" = $1`, [approvalRequestId]))[0].n)).toBe(0);
    expect((await mA.query(`SELECT "currentState" FROM process_instances WHERE "entityId" = $1 AND "entityType" = 'FixedAsset'`, [assetId]))[0].currentState).toBe('active');
    config[LOSS_KEY] = '5900';
    await disposals.decide(approvalRequestId, checker, 'approved', undefined, mA);
    expect((await mA.query(`SELECT "currentState" FROM process_instances WHERE "entityId" = $1 AND "entityType" = 'FixedAsset'`, [assetId]))[0].currentState).toBe('disposed');
  });

  it('5. ISOLATION: the disposal posts into the Company that owns it; B is untouched by A\'s disposals; B\'s DataSource is never requested for A\'s calls; B resolves its OWN accounts', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    expect(Number((await mB.query(`SELECT count(*) AS n FROM accounting_fixed_asset_disposals`))[0].n)).toBe(0);
    expect(Number((await mB.query(`SELECT count(*) AS n FROM accounting_journal_entries`))[0].n)).toBe(0);
    config[LOSS_KEY] = '5900';
    const aAsset = await activeAsset('A', 'FA-ISO-A', '500');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await disposals.submitDisposal({ fixedAssetId: aAsset, disposalDate: today }, maker, mA);
    });
    const bAsset = await activeAsset('B', 'FA-ISO-B', '700');
    const { approvalRequestId } = await disposals.submitDisposal({ fixedAssetId: bAsset, disposalDate: today }, maker, mB);
    expect(approvalRequestId).toBeTruthy();
    const bDisposal = (await mB.query(`SELECT count(*) AS n FROM accounting_fixed_asset_disposals`))[0].n;
    expect(Number(bDisposal)).toBe(1);
    expect(await mB.query(`SELECT 1 FROM accounting_fixed_asset_disposals WHERE "fixedAssetId" = $1`, [aAsset])).toEqual([]);
  });
});
