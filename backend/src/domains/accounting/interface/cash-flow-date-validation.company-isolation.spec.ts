import { randomUUID } from 'crypto';
import { ArgumentsHost } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { GeneralLedgerController } from './general-ledger.controller';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialReportingService } from '../application/financial-reporting.service';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { AllExceptionsFilter } from '../../../foundation/error-contract/all-exceptions.filter';
import { CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Cash Flow Statement date validation (2026-10-15). `GET /accounting/reports/cash-flow` called without
 * `from`/`to` used to reach `FinancialReportingService.getDepreciationAddBack` with `undefined` and
 * answer HTTP 500 (`Cannot read properties of undefined (reading 'slice')`). The controller now rejects
 * a missing or malformed date with a 400 VALIDATION_ERROR before any query runs; a valid range still
 * returns exactly what the read model computes, per Company.
 *
 * Real Postgres, two separately provisioned Company databases (A posts 100.00 to a bank account, B
 * posts 250.00). The thrown exception is passed through the real `AllExceptionsFilter`, so the
 * asserted status and code are the ones the client receives.
 */
describe('Cash Flow Statement — date validation (real Postgres, 2026-10-15)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let reporting: FinancialReportingService;
  let controller: GeneralLedgerController;
  const actorUserId = randomUUID();

  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const FIGURES = { A: '100.00', B: '250.00' } as const;

  const reqFor = (companyId: string, ds: DataSource): CompanyScopedRequest =>
    ({ user: { id: actorUserId, email: 'x@test.local', companyId }, companyContext: { companyId, dataSource: ds } }) as unknown as CompanyScopedRequest;

  /** What the client receives for `exception`, through the real global filter. */
  function httpResponseFor(exception: unknown) {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({ correlationId: 'corr-cf' }) }),
    } as unknown as ArgumentsHost;
    new AllExceptionsFilter().catch(exception, host);
    return { status: status.mock.calls[0][0] as number, body: json.mock.calls[0][0] as { success: boolean; error: { code: string; message: string } } };
  }

  async function callCashFlow(companyId: string, from: unknown, to: unknown) {
    const ds = await h.connections.getDataSource(companyId);
    try {
      const body = await controller.getCashFlowStatement(reqFor(companyId, ds), from as string, to as string);
      return { status: 200, body };
    } catch (e) {
      return httpResponseFor(e);
    }
  }

  async function seedCompany(companyId: string, key: 'A' | 'B', journals: JournalEntryService) {
    const ds = await h.connections.getDataSource(companyId);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actorUserId, 'Cash Flow Test Accountant', `cf-${companyId}@test.local`]);
    const bankId = randomUUID();
    const revenueId = randomUUID();
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction")
       VALUES ($1,$2,$3,'asset','debit',true,true,true,'bank'), ($4,$5,$6,'revenue','credit',true,true,true,NULL)`,
      [bankId, `1010-${key}`, `${key} Bank`, revenueId, `4000-${key}`, `${key} Revenue`],
    );
    const fiscalYearId = randomUUID();
    const fiscalPeriodId = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,$2,$3,$4)`, [fiscalYearId, `FY-${key}`, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,$3,$4,$5)`, [
      fiscalPeriodId,
      fiscalYearId,
      `P-${key}`,
      `${year}-01-01`,
      `${year}-12-31`,
    ]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fiscalYearId, randomUUID(), fiscalPeriodId],
    );
    const draft = await journals.createEntry(
      {
        sourceType: 'MANUAL',
        businessDate: today,
        description: `Cash flow journal ${key}`,
        transactionCurrencyCode: 'EGP',
        lines: [
          { accountId: bankId, debit: FIGURES[key] },
          { accountId: revenueId, credit: FIGURES[key] },
        ],
      },
      actorUserId,
      ds.manager,
    );
    await journals.postEntry(draft.id, actorUserId, {}, ds.manager);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({
      namePrefix: 'cash_flow_dates',
      extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'],
    });

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const config = { get: () => undefined } as unknown as ConfigurationEngineService;
    for (const id of [h.companyAId, h.companyBId]) {
      const ds = await h.connections.getDataSource(id);
      await numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
    }
    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
    reporting = new FinancialReportingService(h.controlPlane);
    // Only the reporting service is reached by the cash-flow routes; the others are inert.
    controller = new GeneralLedgerController(inert, inert, reporting, inert, inert);

    await seedCompany(h.companyAId, 'A', journals);
    await seedCompany(h.companyBId, 'B', journals);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it('reproduces the original defect at the read-model layer: no dates → TypeError → client would get 500 INTERNAL_ERROR', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    let caught: unknown;
    try {
      await reporting.getCashFlowStatement({ from: undefined as unknown as string, to: undefined as unknown as string }, dsA.manager);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(httpResponseFor(caught).status).toBe(500);
  });

  it.each([
    ['missing from', undefined, today],
    ['missing to', `${year}-01-01`, undefined],
    ['both missing', undefined, undefined],
    ['empty from', '', today],
    ['bad format from (DD/MM/YYYY)', '01/01/2026', today],
    ['bad format to (no day)', `${year}-01-01`, `${year}-12`],
    ['non-date text to', `${year}-01-01`, 'yesterday'],
    ['impossible calendar date from', `${year}-02-30`, today],
    ['timestamp instead of date', `${year}-01-01T00:00:00Z`, today],
    ['repeated parameter (array)', [`${year}-01-01`, `${year}-02-01`], today],
  ])('%s → 400 VALIDATION_ERROR, and no query is issued', async (_label, from, to) => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const spy = jest.spyOn(dsA.manager as EntityManager, 'query');
    try {
      const res = await callCashFlow(h.companyAId, from, to);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('the export route applies the same check (400 before any query)', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const spy = jest.spyOn(dsA.manager as EntityManager, 'query');
    let caught: unknown;
    try {
      await controller.exportCashFlowStatement(reqFor(h.companyAId, dsA), undefined as unknown as string, today, undefined, {} as never);
    } catch (e) {
      caught = e;
    } finally {
      spy.mockRestore();
    }
    expect(httpResponseFor(caught)).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION_ERROR' } } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('valid dates → 200, identical to the read model, per Company (A 100.00 vs B 250.00)', async () => {
    const from = `${year}-01-01`;
    for (const [companyId, ending] of [
      [h.companyAId, '100.0000'],
      [h.companyBId, '250.0000'],
    ] as const) {
      const ds = await h.connections.getDataSource(companyId);
      const res = await callCashFlow(companyId, from, today);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(await reporting.getCashFlowStatement({ from, to: today }, ds.manager));
      expect(res.body).toMatchObject({ beginningCash: '0.0000', endingCash: ending, netChangeActual: ending });
    }
  });
});
