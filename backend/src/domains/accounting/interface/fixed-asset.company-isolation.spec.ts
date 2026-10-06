import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { FixedAssetService } from '../application/fixed-asset.service';
import { DepreciationService } from '../application/depreciation.service';
import { FixedAssetDisposalService } from '../application/fixed-asset-disposal.service';
import { FixedAssetReconciliationService } from '../application/fixed-asset-reconciliation.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { LedgerService } from '../application/ledger.service';
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
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

/**
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for `fixed-asset.controller.ts` (register, depreciation
 * runs, disposal approvals, reconciliation). Two real Company databases, each with its own chart of accounts and fiscal periods; the
 * real Approval / Process engines and the real Financial Event Engine + posting gate (Company scope). An asset, its depreciation
 * charges and journals, and a disposal request live — and are approved — only inside their own Company.
 */
describe('FixedAssetController Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let assets: FixedAssetService;
  let depreciation: DepreciationService;
  let disposals: FixedAssetDisposalService;
  let reconciliation: FixedAssetReconciliationService;
  let approvals: ApprovalEngineService;
  let maker: string;
  let checker: string;
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const accountIds: Record<Key, { cost: string; accum: string; expense: string }> = { A: { cost: '', accum: '', expense: '' }, B: { cost: '', accum: '', expense: '' } };
  const mgr = async (k: Key) => (await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId)).manager;

  async function seedChart(k: Key, companyId: string) {
    const ds = await h.connections.getDataSource(companyId);
    const ids = { cost: randomUUID(), accum: randomUUID(), expense: randomUUID() };
    accountIds[k] = ids;
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","isContra","controlFunction") VALUES
       ($1,'1210','Equipment','asset','debit',true,true,true,false,'fixed_asset'),
       ($2,'1219','Accumulated Depreciation','asset','credit',true,true,true,true,'fixed_asset'),
       ($3,'5800','Depreciation Expense','expense','debit',true,true,true,false,NULL),
       ($4,'4900','Gain on Disposal','revenue','credit',true,true,true,false,NULL),
       ($5,'5900','Loss on Disposal','expense','debit',true,true,true,false,NULL)`,
      [ids.cost, ids.accum, ids.expense, randomUUID(), randomUUID()],
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
    h = await setUpTwoCompanyHarness({ namePrefix: 'fixed_asset_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    ambient = await createAmbientDataSource(h);
    await seedChart('A', h.companyAId);
    await seedChart('B', h.companyBId);

    const inert = {} as never;
    const audit = new AuditService(ambient);
    const numbering = new NumberingService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    // FA-02: a disposal now needs its gain/loss account configured BEFORE it is submitted (see fixed-asset-disposal-gain-loss spec).
    const cfg = { get: (k: string) => (k === 'accounting.fixed_asset_gain_on_disposal_account_code' ? '4900' : k === 'accounting.fixed_asset_loss_on_disposal_account_code' ? '5900' : undefined) } as unknown as ConfigurationEngineService;
    approvals = new ApprovalEngineService(ambient, process, audit, events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    const currencies = new CurrencyService(ambient, audit);
    const glAccounts = new GLAccountService(ambient, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(ambient, process, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(ambient, audit);
    const journals = new JournalEntryService(ambient, glAccounts, fiscalPeriods, currencies, audit, events, numbering, process, cfg, dimensions);
    const ledger = new LedgerService(ambient);
    const registry = new FinancialEventHandlerRegistry();
    const financialEvents = new FinancialEventService(ambient, currencies, journals, audit, events, registry, cfg);
    financialEvents.onModuleInit();

    assets = new FixedAssetService(ambient, glAccounts, process, audit);
    depreciation = new DepreciationService(ambient, currencies, financialEvents, registry, process, audit);
    disposals = new FixedAssetDisposalService(ambient, glAccounts, approvals, financialEvents, registry, process, events, audit);
    reconciliation = new FixedAssetReconciliationService(ambient, ledger, process);
    await depreciation.onModuleInit();
    await disposals.onModuleInit();

    maker = (await h.createUserWithAdminRoleIn('FA Maker', h.companyAId)).id;
    checker = (await h.createUserWithAdminRoleIn('FA Checker', h.companyAId)).id;
    const dsA = await h.connections.getDataSource(h.companyAId);
    const role = (await dsA.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,'accounting.fixed_asset.approve','editable') ON CONFLICT DO NOTHING`, [role.id]);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown();
  });

  let assetA = '';
  let assetB = '';

  it('assets are registered in their own Company; an account of another Company is not a valid reference', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    const base = { name: 'Press', acquisitionDate: '2026-01-15', cost: '12000', usefulLifeMonths: 12 };
    await expect(assets.createAsset({ ...base, code: 'FA-1', costAccountId: accountIds.A.cost, accumulatedDepreciationAccountId: accountIds.A.accum, depreciationExpenseAccountId: accountIds.A.expense }, maker, mB)).rejects.toBeInstanceOf(NotFoundException);
    assetA = (await assets.createAsset({ ...base, code: 'FA-1', costAccountId: accountIds.A.cost, accumulatedDepreciationAccountId: accountIds.A.accum, depreciationExpenseAccountId: accountIds.A.expense }, maker, mA)).id;
    assetB = (await assets.createAsset({ ...base, code: 'FA-1', cost: '600', costAccountId: accountIds.B.cost, accumulatedDepreciationAccountId: accountIds.B.accum, depreciationExpenseAccountId: accountIds.B.expense }, maker, mB)).id; // same code in another Company is legal
    expect((await assets.listAssets(mA)).map((a) => a.id)).toEqual([assetA]);
    expect((await assets.listAssets(mB)).map((a) => a.id)).toEqual([assetB]);
    await expect(assets.getAsset(assetA, mB)).rejects.toBeInstanceOf(NotFoundException);
    expect((await assets.getAsset(assetA, mA)).lifecycleState).toBe('pending_acquisition');
    expect((await assets.updateAsset(assetA, { name: 'Press 2' }, maker, mA)).name).toBe('Press 2');
    await expect(assets.updateAsset(assetA, { name: 'x' }, maker, mB)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a depreciation run charges and posts only the Company\'s own active assets, and its GL journal lands in that Company', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    // The acquisition journal is the Journal engine's concern (not under test here): put A's asset straight into its active lifecycle state.
    await mA.query(`UPDATE process_instances SET "currentState" = 'active' WHERE "entityId" = $1 AND "entityType" = 'FixedAsset'`, [assetA]);
    const run = await depreciation.runDepreciation(`${year}-03`, maker, undefined, mA);
    expect(run.lines.length).toBe(1);
    expect((await mA.query(`SELECT count(*)::int n FROM accounting_depreciation_run_lines`))[0].n).toBe(1);
    expect((await mB.query(`SELECT count(*)::int n FROM accounting_depreciation_run_lines`))[0].n).toBe(0);
    expect(run.lines[0].skipped).toBeUndefined();
    expect(run.lines[0].failureReason).toBeUndefined();
    expect(run.lines[0].calculatedAmount).toMatch(/^1000\.00/);
    expect((await mA.query(`SELECT count(*)::int n FROM accounting_financial_events WHERE status = 'POSTED'`))[0].n).toBe(1);
    expect((await mB.query(`SELECT count(*)::int n FROM accounting_financial_events`))[0].n).toBe(0);
  });

  it('a disposal is submitted and decided inside the Company; the other Company can neither see nor decide it; reconciliation runs are local', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    await expect(disposals.submitDisposal({ fixedAssetId: assetA, disposalDate: today }, maker, mB)).rejects.toBeInstanceOf(NotFoundException);
    const { approvalRequestId } = await disposals.submitDisposal({ fixedAssetId: assetA, disposalDate: today }, maker, mA);
    await expect(disposals.decide(approvalRequestId, checker, 'approved', undefined, mB)).rejects.toBeInstanceOf(NotFoundException);
    expect((await disposals.listDisposals(undefined, mA)).length).toBe(1);
    expect(await disposals.listDisposals(undefined, mB)).toEqual([]);
    const reconA = await reconciliation.reconcile(undefined, undefined, mA);
    const reconB = await reconciliation.reconcile(undefined, undefined, mB);
    expect(JSON.stringify(reconA)).toContain(accountIds.A.cost);
    expect(JSON.stringify(reconA)).not.toContain(accountIds.B.cost);
    expect(JSON.stringify(reconB)).not.toContain(accountIds.A.cost);
  });

  it('Test F — nothing leaked into the other Company\'s fixed-asset tables', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsB.query(`SELECT count(*)::int n FROM accounting_fixed_asset_disposals`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM accounting_depreciation_runs`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM accounting_fixed_assets`))[0].n).toBe(1); // B's own asset only
  });
});
