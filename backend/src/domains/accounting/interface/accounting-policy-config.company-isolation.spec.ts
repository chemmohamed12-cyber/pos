import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AccountingPolicyConfigService, ACCOUNTING_POLICY_KEYS } from '../application/accounting-policy-config.service';
import { FixedAssetService } from '../application/fixed-asset.service';
import { FixedAssetAcquisitionService } from '../application/fixed-asset-acquisition.service';
import { JournalEntryService } from '../application/journal-entry.service';
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

/** In-memory double of the Configuration Engine contract used by the policy service and by posting (get / set / clear at installation scope). */
class ConfigDouble {
  store = new Map<string, unknown>();
  sets: Array<{ key: string; scope: unknown; value: unknown; actor: string }> = [];
  get<T = unknown>(key: string): T {
    return this.store.get(key) as T;
  }
  async set(key: string, scope: unknown, value: unknown, actor: { userId: string }) {
    this.sets.push({ key, scope, value, actor: actor.userId });
    this.store.set(key, value);
  }
  async clear(key: string) {
    this.store.delete(key);
  }
}

/**
 * NAV-02 (2026-10-06) — Accounting Policy configuration over the existing Configuration Engine. Real PostgreSQL, Company A with Company B as
 * the witness. Proves: the managed keys (13 consumed by posting; the 13th, the opening-correction account, was added by C4), validation against the REQUESTING Company's chart with the same rule posting
 * applies (exists / active / postable / non-control), advisory type warnings, reason maps, Company isolation of validation and audit, and that
 * a value saved through the service is what real posting then uses (D8 acquisition helper posts to the configured account).
 */
describe('NAV-02 — accounting policy configuration (validated, Company-aware) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let policy: AccountingPolicyConfigService;
  let acquisitions: FixedAssetAcquisitionService;
  let assets: FixedAssetService;
  const cfg = new ConfigDouble();
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const mgr = async (k: Key) => (await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId)).manager;
  const ids: Record<Key, Record<string, string>> = { A: {}, B: {} };

  async function seed(k: Key, companyId: string, full: boolean) {
    const ds = await h.connections.getDataSource(companyId);
    const i = { equity: randomUUID(), revenue: randomUUID(), expense: randomUUID(), header: randomUUID(), inactive: randomUUID(), control: randomUUID(), cost: randomUUID(), accum: randomUUID(), dep: randomUUID(), clearing: randomUUID() };
    ids[k] = i;
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","isContra","controlFunction") VALUES
       ($1,'3105','Opening Balance Equity','equity','credit',true,true,true,false,NULL),
       ($2,'1999','Header','asset','debit',false,true,true,false,NULL),
       ($3,'3999','Inactive','equity','credit',true,true,false,false,NULL),
       ($4,'1120','Inventory','asset','debit',true,false,true,false,'inventory')`,
      [i.equity, i.header, i.inactive, i.control],
    );
    if (full) {
      await ds.query(
        `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","isContra","controlFunction") VALUES
         ($1,'4201','Other Income','revenue','credit',true,true,true,false,NULL),
         ($2,'5101','Other Expense','expense','debit',true,true,true,false,NULL),
         ($3,'1210','Equipment','asset','debit',true,true,true,false,'fixed_asset'),
         ($4,'1219','Accumulated Depreciation','asset','credit',true,true,true,true,'fixed_asset'),
         ($5,'5800','Depreciation Expense','expense','debit',true,true,true,false,NULL),
         ($6,'2950','Acquisition Clearing','liability','credit',true,true,true,false,NULL)`,
        [i.revenue, i.expense, i.cost, i.accum, i.dep, i.clearing],
      );
    }
    const fy = randomUUID();
    const fp = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'nav02_policy', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    ambient = await createAmbientDataSource(h);
    await seed('A', h.companyAId, true);
    await seed('B', h.companyBId, false); // B's chart deliberately lacks 4201 / 5101 / fixed-asset accounts
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const numbering = new NumberingService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const engine = cfg as unknown as ConfigurationEngineService;
    policy = new AccountingPolicyConfigService(engine, audit);
    const currencies = new CurrencyService(ambient, audit);
    const glAccounts = new GLAccountService(ambient, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(ambient, process, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(ambient, audit);
    const journals = new JournalEntryService(ambient, glAccounts, fiscalPeriods, currencies, audit, events, numbering, process, engine, dimensions);
    const registry = new FinancialEventHandlerRegistry();
    const financialEvents = new FinancialEventService(ambient, currencies, journals, audit, events, registry, engine);
    financialEvents.onModuleInit();
    assets = new FixedAssetService(ambient, glAccounts, process, audit);
    acquisitions = new FixedAssetAcquisitionService(ambient, assets, financialEvents, registry, audit);
    acquisitions.onModuleInit();
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('NAV-02 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const OPENING = 'accounting.inventory_opening_balance_account_code';
  const GAIN = 'accounting.inventory_adjustment_gain_account_code';
  const REASONS = 'accounting.inventory_manual_receipt_reason_accounts';
  const CLEARING = 'accounting.fixed_asset_acquisition_clearing_account_code';
  const auditCount = async (k: Key, action: string) => Number((await (await mgr(k)).query(`SELECT count(*) AS n FROM audit_records WHERE action = $1`, [action]))[0].n);

  it('1. LIST: exactly the 13 keys posting actually consumes, grouped, all UNSET on a fresh installation (the 5 unconsumed AR/AP hint keys are not offered)', async () => {
    const list = await policy.list(await mgr('A'));
    expect(list).toHaveLength(13);
    expect(ACCOUNTING_POLICY_KEYS.map((k) => k.key)).not.toContain('accounting.ap_expense_account_code');
    expect(list.every((v) => v.status === 'unset')).toBe(true);
    expect([...new Set(list.map((v) => v.group))].sort()).toEqual(['cash', 'fixed_assets', 'inventory', 'procurement', 'sales']);
  });

  it('2. SET a valid account through the existing engine (installation scope): stored, status OK, audited in the Company; a typical type gives no warning', async () => {
    const v = await policy.set(OPENING, '3105', actor, await mgr('A'));
    expect(v).toMatchObject({ status: 'ok', code: '3105', warning: null, account: { code: '3105', accountType: 'equity' } });
    expect(cfg.sets.at(-1)).toMatchObject({ key: OPENING, scope: { scope_type: 'installation', scope_id: null }, value: '3105', actor });
    expect(await auditCount('A', 'accounting.policy_config.updated')).toBe(1);
  });

  it('3. HARD RULES (same as posting): unknown / header / inactive / control accounts are rejected before anything is stored; the previous value and the audit trail are untouched', async () => {
    const mA = await mgr('A');
    const sets = cfg.sets.length;
    for (const [code, re] of [['9999', /does not exist/], ['1999', /not postable/], ['3999', /inactive/], ['1120', /control account \(inventory\)/]] as const) {
      await expect(policy.set(OPENING, code, actor, mA)).rejects.toThrow(re);
    }
    await expect(policy.set(OPENING, '', actor, mA)).rejects.toBeInstanceOf(BadRequestException);
    expect(cfg.sets.length).toBe(sets);
    expect(cfg.get(OPENING)).toBe('3105');
    expect(await auditCount('A', 'accounting.policy_config.updated')).toBe(1);
  });

  it('4. ADVISORY type check: an unusual account type is saved with a WARNING (no accounting rule is invented), a typical one is not warned', async () => {
    const mA = await mgr('A');
    const odd = await policy.set(GAIN, '5101', actor, mA); // gain account that is an expense
    expect(odd.status).toBe('ok');
    expect(odd.warning).toMatch(/unusual for this setting \(typical: revenue\)/);
    const typical = await policy.set(GAIN, '4201', actor, mA);
    expect(typical.warning).toBeNull();
  });

  it('5. REASON MAP (manual receipt reasons): valid map saved; one bad entry rejects the whole map; invalid reason code rejected; clear returns to unset (fail-closed)', async () => {
    const mA = await mgr('A');
    const ok = await policy.set(REASONS, { DONATION: '3105', FOUND_STOCK: '4201' }, actor, mA);
    expect(ok.status).toBe('ok');
    expect(ok.entries.map((e) => [e.reason, e.code, e.status])).toEqual([['DONATION', '3105', 'ok'], ['FOUND_STOCK', '4201', 'ok']]);
    const before = cfg.get(REASONS);
    await expect(policy.set(REASONS, { DONATION: '3105', BAD: '1120' }, actor, mA)).rejects.toThrow(/Reason "BAD".*control account/);
    await expect(policy.set(REASONS, { 'bad code!': '3105' }, actor, mA)).rejects.toBeInstanceOf(BadRequestException);
    await expect(policy.set(REASONS, {}, actor, mA)).rejects.toBeInstanceOf(BadRequestException);
    expect(cfg.get(REASONS)).toEqual(before);
    const cleared = await policy.clear(REASONS, actor, mA);
    expect(cleared.status).toBe('unset');
    expect(cfg.get(REASONS)).toBeUndefined();
  });

  it('6. ONLY managed keys are reachable: an arbitrary key and the unconsumed AR/AP hint keys are refused', async () => {
    const mA = await mgr('A');
    for (const key of ['core.some_other_setting', 'accounting.ap_expense_account_code', 'accounting.max_gl_accounts']) {
      await expect(policy.set(key, '3105', actor, mA)).rejects.toBeInstanceOf(NotFoundException);
      await expect(policy.clear(key, actor, mA)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('7. COMPANY ISOLATION: validation uses the REQUESTING Company\'s chart — the same installation-wide value is OK in A and INVALID in B; B cannot save A-only codes; audit lands only in the acting Company; B\'s DataSource is never requested for A\'s calls', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await policy.list(mA);
      await policy.set(OPENING, '3105', actor, mA);
    });
    expect((await policy.list(mA)).find((v) => v.key === GAIN)).toMatchObject({ status: 'ok', code: '4201' });
    expect((await policy.list(mB)).find((v) => v.key === GAIN)).toMatchObject({ status: 'invalid', code: '4201', problem: expect.stringMatching(/does not exist in this Company's chart/) });
    const stored = cfg.get(GAIN);
    await expect(policy.set(GAIN, '4201', actor, mB)).rejects.toThrow(/does not exist/); // B's chart has no 4201
    expect(cfg.get(GAIN)).toBe(stored);
    expect(await auditCount('B', 'accounting.policy_config.updated')).toBe(0);
    expect(await auditCount('A', 'accounting.policy_config.updated')).toBeGreaterThan(0);
    const platform = await ambient.query(`SELECT table_name FROM information_schema.tables WHERE table_name = 'accounting_gl_accounts'`);
    expect(platform).toEqual([]); // the Platform DB has no chart: validation never ran there
  });

  it('8. POSTING VERIFICATION: a value saved through this service is what real posting uses — with the clearing account set via the service the D8 acquisition helper posts Dr cost / Cr that account; unset (fail-closed) it is rejected before any write', async () => {
    const mA = await mgr('A');
    const asset = (await assets.createAsset({ code: 'FA-N2', name: 'Press', acquisitionDate: `${year}-01-15`, cost: '9000', usefulLifeMonths: 12, costAccountId: ids.A.cost, accumulatedDepreciationAccountId: ids.A.accum, depreciationExpenseAccountId: ids.A.dep }, actor, mA)).id;
    await expect(acquisitions.createAcquisitionJournal(asset, actor, mA)).rejects.toThrow(/Acquisition Clearing account is not usable \(unset\)/);
    await policy.set(CLEARING, '2950', actor, mA);
    const r = await acquisitions.createAcquisitionJournal(asset, actor, mA);
    expect(r.asset.lifecycleState).toBe('active');
    const lines = (await mA.query(`SELECT "accountId", "debitBase" AS d, "creditBase" AS c FROM accounting_journal_lines WHERE "journalEntryId" = $1`, [r.journalEntryId])) as Array<{ accountId: string; d: string; c: string }>;
    expect(lines.map((l) => [l.accountId, Number(l.d), Number(l.c)]).sort()).toEqual([[ids.A.cost, 9000, 0], [ids.A.clearing, 0, 9000]].sort());
    await policy.clear(CLEARING, actor, mA); // back to fail-closed
    const asset2 = (await assets.createAsset({ code: 'FA-N3', name: 'Lathe', acquisitionDate: `${year}-01-16`, cost: '100', usefulLifeMonths: 12, costAccountId: ids.A.cost, accumulatedDepreciationAccountId: ids.A.accum, depreciationExpenseAccountId: ids.A.dep }, actor, mA)).id;
    await expect(acquisitions.createAcquisitionJournal(asset2, actor, mA)).rejects.toBeInstanceOf(ConflictException);
  });
});
