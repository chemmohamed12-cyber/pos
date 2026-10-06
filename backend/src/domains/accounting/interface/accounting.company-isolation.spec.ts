import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GLAccountService } from '../application/gl-account.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { TaxPeriodService } from '../application/tax-period.service';
import { TaxCodeService } from '../application/tax-code.service';
import { ClosingExceptionService } from '../application/closing-exception.service';
import { ClosingAuditService } from '../application/closing-audit.service';
import { ArReconciliationService } from '../application/ar-reconciliation.service';
import { ApReconciliationService } from '../application/ap-reconciliation.service';
import { CashBankReconciliationService } from '../application/cash-bank-reconciliation.service';
import { InventoryReconciliationService } from '../application/inventory-reconciliation.service';
import { FixedAssetReconciliationService } from '../application/fixed-asset-reconciliation.service';
import { GrniReconciliationService } from '../application/grni-reconciliation.service';
import { WipReconciliationService } from '../application/wip-reconciliation.service';
import { LedgerService } from '../application/ledger.service';
import { GrniLedgerService } from '../../procurement/application/grni-ledger.service';
import { ManufacturingWipLedgerService } from '../../manufacturing/application/manufacturing-wip-ledger.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { SupplierLedgerService } from '../../procurement/application/supplier-ledger.service';
import { CustomersService } from '../../crm/application/customers.service';
import { CONTROL_FUNCTIONS } from '../domain/control-function';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { LimitService } from '../../../foundation/limit-engine/limit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

/**
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for `accounting.controller.ts` (46 routes: Chart of
 * Accounts, currencies, financial dimensions, tax codes/periods, fiscal years/periods, closing exceptions, and the FA-01-gated
 * period close — Matrix §49 addendum). Two real Company databases; the real GL-account / currency / dimension / fiscal-period /
 * tax services, the real Closing Audit orchestrating all seven reconciliations, and the real Approval + Process engines.
 * Every Company has its OWN chart of accounts: an account created in one is invisible to the other, with the same codes reusable.
 */
describe('AccountingController Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let glAccounts: GLAccountService;
  let currencies: CurrencyService;
  let dimensions: FinancialDimensionService;
  let fiscal: FiscalPeriodService;
  let taxCodes: TaxCodeService;
  let taxPeriods: TaxPeriodService;
  let closingExceptions: ClosingExceptionService;
  let approvals: ApprovalEngineService;
  let maker: string;
  let checker: string;
  const year = new Date().toISOString().slice(0, 4);
  type Key = 'A' | 'B';
  const mgr = async (k: Key) => (await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId)).manager;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'accounting_ctl_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting', 'manufacturing'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const numbering = new NumberingService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const limits = new LimitService(ambient, { sync: async () => undefined } as never, audit);
    approvals = new ApprovalEngineService(ambient, process, audit, events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    currencies = new CurrencyService(ambient, audit);
    glAccounts = new GLAccountService(ambient, audit, events, limits, inert, currencies);
    dimensions = new FinancialDimensionService(ambient, audit);
    taxCodes = new TaxCodeService(ambient, audit);
    taxPeriods = new TaxPeriodService(ambient, audit);
    closingExceptions = new ClosingExceptionService(ambient, audit);

    const ledger = new LedgerService(ambient);
    const customers = new CustomersService(inert, inert, inert, inert, inert, inert, inert, inert);
    const arRec = new ArReconciliationService(ambient, ledger, audit, new CustomerLedgerService(ambient, numbering, audit, customers) as never);
    const apRec = new ApReconciliationService(ambient, ledger, audit, new SupplierLedgerService(ambient, numbering, audit) as never);
    const cbRec = new CashBankReconciliationService(ambient, ledger, audit, { getAllTreasuryBalances: async () => ({ balances: [{ treasuryAccountId: '00000000-0000-0000-0000-0000000000aa', code: 'MAIN', name: 'Main', glAccountCode: '1000', balance: '0.00' }] }), listTreasuryLedger: async () => [] } as never);
    const invRec = new InventoryReconciliationService(ambient, ledger, audit, undefined, undefined);
    const faRec = new FixedAssetReconciliationService(ambient, ledger, process);
    const grniRec = new GrniReconciliationService(ambient, ledger, audit, new GrniLedgerService(ambient));
    const valuation = { getValuedOnHandTotal: async (_asOf: string | undefined, _m?: EntityManager) => [] } as unknown as InventoryValuationContract;
    const wipRec = new WipReconciliationService(ambient, ledger, audit, new ManufacturingWipLedgerService(ambient, valuation));
    const closingAudit = new ClosingAuditService(ambient, audit, arRec, apRec, cbRec, invRec, faRec, grniRec, wipRec);
    // The Black-Box snapshot file assembly has its own real-Postgres spec (closing-snapshot.service.spec); here only the hand-off is observed.
    const snapshots = { beginPending: async () => ({ id: randomUUID() }), assembleAndFinalize: async () => undefined } as never;
    fiscal = new FiscalPeriodService(ambient, process, audit, approvals, events, closingAudit, snapshots);
    await fiscal.onModuleInit();

    maker = (await h.createUserWithAdminRoleIn('Acct Maker', h.companyAId)).id;
    checker = (await h.createUserWithAdminRoleIn('Acct Checker', h.companyAId)).id;
    const dsA = await h.connections.getDataSource(h.companyAId);
    const role = (await dsA.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    for (const node of ['accounting.fiscal_period.approve', 'accounting.fiscal_year.approve', 'accounting.fiscal_closing.approve']) {
      await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable') ON CONFLICT DO NOTHING`, [role.id, node]);
    }
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown();
  });

  let accountA = '';

  it('Chart of Accounts: each Company owns its chart — same codes are reusable, the tree/list never cross Companies, an unknown parent is a 404', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    accountA = (await glAccounts.createAccount({ code: '1000', name: 'Alpha Cash', accountType: 'asset' }, maker, mA)).id;
    await glAccounts.createAccount({ code: '1000', name: 'Beta Cash', accountType: 'asset' }, maker, mB); // same code, different Company
    expect((await glAccounts.listAccounts({}, mA)).map((a) => a.name)).toEqual(['Alpha Cash']);
    expect((await glAccounts.listAccounts({}, mB)).map((a) => a.name)).toEqual(['Beta Cash']);
    expect((await glAccounts.getTree(false, mA)).map((n) => n.id)).toEqual([accountA]);
    await expect(glAccounts.getAccount(accountA, mB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(glAccounts.createAccount({ code: '1001', name: 'Orphan', accountType: 'asset', parentAccountId: accountA }, maker, mB)).rejects.toThrow();
    expect((await glAccounts.updateAccount(accountA, { name: 'Alpha Cash 2' }, maker, mA)).name).toBe('Alpha Cash 2');
    await expect(glAccounts.updateAccount(accountA, { name: 'x' }, maker, mB)).rejects.toBeInstanceOf(NotFoundException);
    // a control function assigned in A does not occupy B's chart
    await glAccounts.assignControlFunction(accountA, 'bank', maker, mA);
    expect((await glAccounts.getAccountByCode('1000', mB)).controlFunction).toBeNull();
  });

  it('Chart templates are imported into the caller\'s Company only', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    const templates = glAccounts.listTemplates();
    expect(templates.length).toBeGreaterThan(0);
    const dsB = await h.connections.getDataSource(h.companyBId);
    await dsB.query(`DELETE FROM accounting_gl_accounts`);
    const before = (await glAccounts.listAccounts({}, mA)).length;
    const preview = await glAccounts.importTemplate(templates[0].key, true, maker, mB);
    expect(preview).toBeTruthy();
    expect(await glAccounts.listAccounts({}, mB)).toEqual([]); // a dry run writes nothing
    await glAccounts.importTemplate(templates[0].key, false, maker, mB);
    expect((await glAccounts.listAccounts({}, mB)).length).toBe(templates[0].accountCount); // the whole template landed in B
    expect((await glAccounts.listAccounts({}, mA)).length).toBe(before); // A untouched by B's import
  });

  it('Currencies, financial dimensions and tax codes/periods are Company-local', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    await currencies.createCurrency({ code: 'USD', name: 'US Dollar', symbol: '$' }, maker, mA);
    expect((await currencies.listCurrencies(mA)).map((c) => c.code)).toContain('USD');
    expect((await currencies.listCurrencies(mB)).map((c) => c.code)).not.toContain('USD');
    await expect(currencies.getCurrency('USD', mB)).rejects.toBeInstanceOf(NotFoundException);

    const type = await dimensions.createDimensionType({ code: 'DEPT', name: 'Department' }, maker, mA);
    await dimensions.createDimensionValue(type.id, { code: 'D1', name: 'Dept 1' }, maker, mA);
    expect((await dimensions.listDimensionTypes(mA)).map((t) => t.code)).toEqual(['DEPT']);
    expect(await dimensions.listDimensionTypes(mB)).toEqual([]);

    await taxCodes.createTaxCode({ code: 'VAT14', name: 'VAT 14', rate: '14' }, maker, mA);
    await taxPeriods.createTaxPeriod({ code: `${year}-Q1`, startDate: `${year}-01-01`, endDate: `${year}-03-31` }, maker, mA);
    expect((await taxCodes.listTaxCodes(mB)).length).toBe(0);
    expect((await taxPeriods.listTaxPeriods(mA)).length).toBe(1);
    expect(await taxPeriods.listTaxPeriods(mB)).toEqual([]);
  });

  let periodA = '';

  it('Fiscal years and periods are Company-local; the period close is FA-01-gated, approved by the checker inside the Company, and the other Company cannot touch it', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    // every control function exists in A's chart so the Closing Audit's seven reconciliations can run
    for (const fn of CONTROL_FUNCTIONS) {
      if (fn === 'bank') continue; // already assigned above
      await glAccounts.createAccount({ code: `9${CONTROL_FUNCTIONS.indexOf(fn)}00`, name: `Control ${fn}`, accountType: fn === 'ap' || fn === 'grni' || fn === 'wages_payable' || fn === 'tax_payable' ? 'liability' : fn === 'retained_earnings' ? 'equity' : fn === 'fx_gain_loss' || fn === 'rounding' ? 'expense' : 'asset', controlFunction: fn }, maker, mA);
    }
    const yearA = await fiscal.createFiscalYear({ code: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` }, maker, mA);
    await fiscal.activateFiscalYear(yearA.id, maker, mA);
    expect((await fiscal.listFiscalYears(mA)).map((y) => y.id)).toEqual([yearA.id]);
    expect(await fiscal.listFiscalYears(mB)).toEqual([]);
    await expect(fiscal.getFiscalYear(yearA.id, mB)).rejects.toBeInstanceOf(NotFoundException);
    const periods = await fiscal.listPeriods(yearA.id, mA);
    expect(periods.length).toBe(12);
    periodA = periods[0].id;

    await expect(fiscal.transitionPeriod(periodA, 'soft_close', maker, mB)).rejects.toBeInstanceOf(NotFoundException);
    await fiscal.transitionPeriod(periodA, 'soft_close', maker, mA);
    await expect(fiscal.submitPeriodClose(periodA, maker, mB)).rejects.toBeInstanceOf(NotFoundException);
    const request = await fiscal.submitPeriodClose(periodA, maker, mA);
    await expect(approvals.decide(request.id, checker, 'approved', null, mB)).rejects.toBeInstanceOf(NotFoundException);
    await approvals.decide(request.id, checker, 'approved', null, mA);
    expect((await fiscal.listPeriods(yearA.id, mA)).find((p) => p.id === periodA)?.status).toBe('closed');
    expect((await fiscal.listClosingWorkflowRuns(periodA, mA)).length).toBe(1);
    expect(await fiscal.listClosingWorkflowRuns(periodA, mB)).toEqual([]);
    expect(await closingExceptions.list(periodA, mA)).toBeDefined();
    expect(await closingExceptions.list(periodA, mB)).toEqual([]);
  });

  it('Test F — nothing leaked into the other Company\'s accounting tables', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsB.query(`SELECT count(*)::int n FROM accounting_fiscal_years`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM accounting_tax_codes`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM accounting_financial_dimension_types`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM accounting_closing_workflow_runs`))[0].n).toBe(0);
  });
});
