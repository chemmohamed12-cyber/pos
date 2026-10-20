import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { ACCOUNT_TEMPLATES } from '../domain/account-templates/ifrs-sme.template';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * GRNI control account - root cause and repair (CTO 2026-10-20), real PostgreSQL, Company A with Company B as the independent witness.
 * Root cause: the IFRS-SME template had NO `grni` account, so a Company created from it could not post a goods receipt (Dr Inventory / Cr GRNI). Fixed at the shared source (the template gets
 * 2105 GRNI) and for charts that already exist by `ensureControlAccounts` (adds only what is missing, never duplicates, idempotent). Rejections create no journal; a re-drive after the repair
 * posts exactly one balanced entry and a second re-drive is a no-op.
 */
describe('GRNI control account - template, repair of existing charts, posting, no partial entries, isolation - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let glAccounts: GLAccountService;
  let financialEvents: FinancialEventService;
  const actor = randomUUID();
  const year = new Date().toISOString().slice(0, 4);
  const today = new Date().toISOString().slice(0, 10);
  type Key = 'A' | 'B';
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seedFiscal(k: Key) {
    const ds = await dsOf(k);
    const fy = randomUUID();
    const fp = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
    await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'grni_ctrl', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const cfg = { get: () => undefined } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(h.controlPlane, audit);
    const limits = { check: async () => ({ allowed: true, max: 1000 }), consume: async () => undefined } as never; // the account-count limit itself is covered elsewhere
    glAccounts = new GLAccountService(h.controlPlane, audit, events, limits, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, cfg, dimensions);
    const handlerRegistry = new FinancialEventHandlerRegistry();
    financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, handlerRegistry, cfg);
    financialEvents.onModuleInit();
    await seedFiscal('A');
    await seedFiscal('B');
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('GRNI teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const count = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
  const grniAccounts = async (k: Key) => (await dsOf(k)).query(`SELECT code, "isActive", "isPostable", "controlFunction" FROM accounting_gl_accounts WHERE "controlFunction" = 'grni'`) as Promise<Array<{ code: string; isActive: boolean }>>;
  const receipt = (n: string, total = '35.0000') => ({
    idempotencyKey: `procurement:goods_receipt:${n}:posted`,
    businessDate: today,
    orgUnitId: null,
    currency: 'EGP',
    sourceEntityType: 'goods_receipt',
    sourceEntityId: n,
    grNumber: `GR-${n}`,
    totalValueBase: total,
  });
  async function post(k: Key, n: string) {
    const ds = await dsOf(k);
    return financialEvents.ingest('procurement.goods_receipt.posted', receipt(n), ds.manager);
  }
  const lines = async (k: Key, journalId: string) =>
    ((await (await dsOf(k)).query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [journalId],
    )) as Array<{ code: string; dr: string; cr: string }>).map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`));
  const none = async (k: Key) => ({ journals: await count(k, 'accounting_journal_entries'), lines: await count(k, 'accounting_journal_lines') });

  it('1. the shared source: the template has exactly one GRNI control account (liability, postable), at a code nothing else uses', () => {
    for (const tpl of ACCOUNT_TEMPLATES) {
      const grni = tpl.accounts.filter((a) => a.controlFunction === 'grni');
      expect(grni).toHaveLength(1);
      expect([grni[0].accountType, grni[0].isPostable ?? true]).toEqual(['liability', true]);
      expect(tpl.accounts.filter((a) => a.code === grni[0].code)).toHaveLength(1);
    }
  });

  it('2. NEW Company: the imported chart posts a goods receipt Dr Inventory 1120 / Cr GRNI 2105 for the receipt value; the same event again is a no-op (one journal)', async () => {
    const dsA = await dsOf('A');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await glAccounts.importTemplate(ACCOUNT_TEMPLATES[0].key, false, actor, dsA.manager);
      expect((await grniAccounts('A')).map((a) => a.code)).toEqual(['2105']);
      const r = await post('A', 'a1');
      expect(r.status).toBe('POSTED');
      expect(await lines('A', r.journalEntryId!)).toEqual(['1120 D 35.00', '2105 C 35.00']);
      const again = await post('A', 'a1');
      expect([again.status, again.deduped, again.journalEntryId]).toEqual(['POSTED', true, r.journalEntryId]);
    });
    expect((await none('A')).journals).toBe(1);
  });

  it('3. LEGACY Company (chart imported before GRNI existed): the receipt is REJECTED with an actionable message, creating NO journal, entry line or partial state', async () => {
    const dsB = await dsOf('B');
    await glAccounts.importTemplate(ACCOUNT_TEMPLATES[0].key, false, actor, dsB.manager);
    await dsB.query(`DELETE FROM accounting_gl_accounts WHERE "controlFunction" = 'grni'`); // what a chart created from the old template looks like
    const before = await none('B');
    const r = await post('B', 'b1');
    expect(r.status).toBe('REJECTED');
    const [ev] = await dsB.query(`SELECT "rejectionReason" AS r FROM accounting_financial_events WHERE "sourceEntityId" = 'b1'`);
    expect(ev.r).toMatch(/GRNI control account/);
    expect(ev.r).toMatch(/Complete control accounts/);
    expect(ev.r).toMatch(/re-drive/);
    expect(await none('B')).toEqual(before);
    expect(await grniAccounts('B')).toHaveLength(0);
  });

  it('4. REPAIR: dry run writes nothing; the real run adds only 2105; a second run creates nothing (no duplicates); Company A is untouched', async () => {
    const dsB = await dsOf('B');
    const accountsBefore = await count('B', 'accounting_gl_accounts');
    const aBefore = await count('A', 'accounting_gl_accounts');
    const dry = await glAccounts.ensureControlAccounts(ACCOUNT_TEMPLATES[0].key, true, actor, dsB.manager);
    expect([dry.created, dry.accounts.map((a) => a.code)]).toEqual([0, ['2105']]);
    expect(await count('B', 'accounting_gl_accounts')).toBe(accountsBefore);
    const real = await glAccounts.ensureControlAccounts(ACCOUNT_TEMPLATES[0].key, false, actor, dsB.manager);
    expect([real.created, real.accounts.map((a) => a.code), real.skipped]).toEqual([1, ['2105'], []]);
    expect(await count('B', 'accounting_gl_accounts')).toBe(accountsBefore + 1);
    const [acc] = (await dsB.query(`SELECT "isActive","isPostable","controlFunction","allowManualJournal","parentAccountId" FROM accounting_gl_accounts WHERE code = '2105'`)) as Array<Record<string, unknown>>;
    expect([acc.isActive, acc.isPostable, acc.controlFunction, acc.allowManualJournal, !!acc.parentAccountId]).toEqual([true, true, 'grni', false, true]);
    const second = await glAccounts.ensureControlAccounts(ACCOUNT_TEMPLATES[0].key, false, actor, dsB.manager);
    expect([second.created, second.accounts, second.skipped]).toEqual([0, [], []]);
    expect(await count('B', 'accounting_gl_accounts')).toBe(accountsBefore + 1);
    expect(await count('A', 'accounting_gl_accounts')).toBe(aBefore); // isolation: A's chart is not touched by B's repair
    expect(Number((await dsB.query(`SELECT count(*) AS n FROM audit_records WHERE action = 'accounting.gl_account.control_accounts_ensured'`))[0].n)).toBe(1);
  });

  it('5. RE-DRIVE the same rejected receipt after the repair: exactly one balanced journal; a second re-drive does not duplicate it', async () => {
    const dsB = await dsOf('B');
    const [ev] = await dsB.query(`SELECT id FROM accounting_financial_events WHERE "sourceEntityId" = 'b1'`);
    const r = await financialEvents.redrive(ev.id, dsB.manager);
    expect(r.status).toBe('POSTED');
    expect(await lines('B', r.journalEntryId!)).toEqual(['1120 D 35.00', '2105 C 35.00']);
    const again = await financialEvents.redrive(ev.id, dsB.manager);
    expect([again.status, again.journalEntryId]).toEqual(['POSTED', r.journalEntryId]);
    expect((await none('B')).journals).toBe(1);
    expect(Number((await dsB.query(`SELECT count(*) AS n FROM accounting_journal_lines`))[0].n)).toBe(2);
  });

  it('6. INACTIVE or UNMARKED GRNI account: rejected before posting; the repair refuses to create a duplicate and says what to do by hand; reactivating makes the posting work', async () => {
    const dsB = await dsOf('B');
    await dsB.query(`UPDATE accounting_gl_accounts SET "isActive" = false WHERE code = '2105'`);
    const before = await none('B');
    expect((await post('B', 'b2')).status).toBe('REJECTED');
    expect(await none('B')).toEqual(before);
    const skipInactive = await glAccounts.ensureControlAccounts(ACCOUNT_TEMPLATES[0].key, false, actor, dsB.manager);
    expect(skipInactive.created).toBe(0);
    expect(skipInactive.skipped[0].reason).toMatch(/inactive/);
    await dsB.query(`UPDATE accounting_gl_accounts SET "isActive" = true, "controlFunction" = NULL WHERE code = '2105'`);
    const skipUnmarked = await glAccounts.ensureControlAccounts(ACCOUNT_TEMPLATES[0].key, false, actor, dsB.manager);
    expect(skipUnmarked.created).toBe(0);
    expect(skipUnmarked.skipped[0].reason).toMatch(/without the control function "grni"/);
    expect(Number((await dsB.query(`SELECT count(*) AS n FROM accounting_gl_accounts WHERE code = '2105'`))[0].n)).toBe(1); // never a second 2105
    await dsB.query(`UPDATE accounting_gl_accounts SET "controlFunction" = 'grni' WHERE code = '2105'`);
    const again = await post('B', 'b2');
    expect([again.status, again.deduped]).toEqual(['REJECTED', true]); // the same event key is NOT silently re-posted by a new ingest: re-driving is the explicit step
    const [ev] = await dsB.query(`SELECT id FROM accounting_financial_events WHERE "sourceEntityId" = 'b2'`);
    const ok = await financialEvents.redrive(ev.id, dsB.manager);
    expect(ok.status).toBe('POSTED');
    expect((await none('B')).journals).toBe(2); // b1 and b2: one journal each, no duplicates
  });

  it('7. Company isolation and unknown template: receipts and repair of B never reach A; an unknown template is refused', async () => {
    const dsA = await dsOf('A');
    await expect(glAccounts.ensureControlAccounts('no-such-template', false, actor, dsA.manager)).rejects.toThrow(/not found/);
    expect(await count('A', 'accounting_financial_events')).toBe(1); // only A's own receipt
    expect(await count('A', 'accounting_journal_entries')).toBe(1);
    expect((await grniAccounts('A')).map((x) => x.code)).toEqual(['2105']);
    expect(await count('B', 'accounting_financial_events')).toBeGreaterThanOrEqual(2);
  });

  it('8. an EMPTY chart is refused by the repair - the template import is the way for a chart with no accounts', async () => {
    const fake = { getRepository: () => ({ find: async () => [], count: async () => 0 }) } as never;
    const svc = Object.create(GLAccountService.prototype) as GLAccountService;
    (svc as unknown as { em: (m?: unknown) => unknown }).em = () => fake;
    await expect(svc.ensureControlAccounts(ACCOUNT_TEMPLATES[0].key, false, actor)).rejects.toThrow(ConflictException);
  });
});
