import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { ApAdjustmentService } from '../application/ap-adjustment.service';
import { ApReconciliationService } from '../application/ap-reconciliation.service';
import { ArAdjustmentService } from '../application/ar-adjustment.service';
import { ArReconciliationService } from '../application/ar-reconciliation.service';
import { CashBankAdjustmentService } from '../application/cash-bank-adjustment.service';
import { CashBankReconciliationService } from '../application/cash-bank-reconciliation.service';
import { InventoryAdjustmentService } from '../application/inventory-adjustment.service';
import { InventoryReconciliationService } from '../application/inventory-reconciliation.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { LedgerService } from '../application/ledger.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { SupplierLedgerService } from '../../procurement/application/supplier-ledger.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { CustomersService } from '../../crm/application/customers.service';
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
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for the four accounting sub-ledger controllers
 * `ap`, `ar`, `cash-bank` and `inventory-accounting` (each = an approval-gated Adjustment service + a Reconciliation service).
 * Two real Company databases with their own chart of accounts and fiscal periods; the real Approval / Process engines, the real
 * Financial Event Engine + posting gate (Company scope), the real Supplier / Customer ledgers. A maker submits in Company A, the
 * checker(s) approve in Company A, the GL journal lands in Company A only, and reconciliation runs live in their own Company.
 */
describe('Accounting sub-ledger controllers (ap / ar / cash-bank / inventory) Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let approvals: ApprovalEngineService;
  let apAdj: ApAdjustmentService;
  let apRec: ApReconciliationService;
  let arAdj: ArAdjustmentService;
  let arRec: ArReconciliationService;
  let cbAdj: CashBankAdjustmentService;
  let cbRec: CashBankReconciliationService;
  let invAdj: InventoryAdjustmentService;
  let invRec: InventoryReconciliationService;
  let maker: string;
  let checker1: string;
  let checker2: string;
  const customerId = randomUUID();
  const supplierId = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';
  const mgr = async (k: Key) => (await h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId)).manager;

  async function seedChart(companyId: string) {
    const ds = await h.connections.getDataSource(companyId);
    for (const [code, name, type, normal, fn] of [
      ['1101', 'Bank', 'asset', 'debit', 'bank'],
      ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'],
      ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
      ['2110', 'Accounts Payable', 'liability', 'credit', 'ap'],
      ['3105', 'Opening Balance Equity', 'equity', 'credit', null],
      ['5900', 'Adjustments Expense', 'expense', 'debit', null],
    ] as Array<[string, string, string, string, string | null]>) {
      await ds.query(
        `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,true,true,$6)`,
        [randomUUID(), code, name, type, normal, fn],
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
    await new NumberingService(ambient).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({
      namePrefix: 'subledger_isolation',
      extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'],
    });
    ambient = await createAmbientDataSource(h);
    await seedChart(h.companyAId);
    await seedChart(h.companyBId);
    const dsA = await h.connections.getDataSource(h.companyAId);
    await dsA.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-SL-A','Subledger Supplier A')`, [supplierId]);
    await dsA.query(`INSERT INTO "customers" ("id","code","name") VALUES ($1,'CUST-SL-A','Subledger Customer A')`, [customerId]);

    const inert = {} as never;
    const audit = new AuditService(ambient);
    const numbering = new NumberingService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const cfgValues: Record<string, unknown> = { 'accounting.cash_bank_opening_balance_account_code': '3105' };
    const cfg = { get: (key: string) => cfgValues[key] } as unknown as ConfigurationEngineService;
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

    const supplierLedger = new SupplierLedgerService(ambient, numbering, audit);
    const customers = new CustomersService(inert, inert, inert, inert, inert, inert, inert, inert);
    const customerLedger = new CustomerLedgerService(ambient, numbering, audit, customers);
    const treasuryNone = {} as never; // no Treasury source: none of the paths below read it

    apAdj = new ApAdjustmentService(approvals, financialEvents, registry, events, audit, supplierLedger as never);
    apRec = new ApReconciliationService(ambient, ledger, audit, supplierLedger as never);
    arAdj = new ArAdjustmentService(approvals, financialEvents, registry, events, audit, customerLedger as never);
    arRec = new ArReconciliationService(ambient, ledger, audit, customerLedger as never);
    cbAdj = new CashBankAdjustmentService(ambient, approvals, financialEvents, registry, events, audit, cfg, undefined);
    cbRec = new CashBankReconciliationService(ambient, ledger, audit, treasuryNone);
    invAdj = new InventoryAdjustmentService(ambient, approvals, financialEvents, registry, events, audit);
    invRec = new InventoryReconciliationService(ambient, ledger, audit, undefined, undefined);
    for (const s of [apAdj, arAdj, cbAdj, invAdj]) await s.onModuleInit();

    maker = (await h.createUserWithAdminRoleIn('Sub Maker', h.companyAId)).id;
    checker1 = (await h.createUserWithAdminRoleIn('Sub Checker 1', h.companyAId)).id;
    checker2 = (await h.createUserWithAdminRoleIn('Sub Checker 2', h.companyAId)).id;
    const role = (await dsA.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    for (const node of ['accounting.ap.approve', 'accounting.ar.approve', 'accounting.cash.approve', 'accounting.inventory.approve']) {
      await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable') ON CONFLICT DO NOTHING`, [role.id, node]);
    }
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown();
  });

  async function postedEvents(k: Key): Promise<number> {
    const m = await mgr(k);
    return (await m.query(`SELECT count(*)::int n FROM accounting_financial_events WHERE status = 'POSTED'`))[0].n;
  }

  it('AP: an adjustment is submitted and approved inside Company A; the GL journal lands in A only; the reconciliation run is A\'s', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    const before = await postedEvents('A');
    const { approvalRequestId } = await apAdj.submitAdjustment({ supplierRef: supplierId, kind: 'adjustment', amount: '100.00', reason: 'rounding fix', contraAccountCode: '5900', direction: 'credit' }, maker, mA);
    await expect(apAdj.decide(approvalRequestId, checker1, 'approved', undefined, mB)).rejects.toBeInstanceOf(NotFoundException);
    await apAdj.decide(approvalRequestId, checker1, 'approved', undefined, mA);
    expect(await postedEvents('A')).toBe(before + 1);
    expect(await postedEvents('B')).toBe(0);
    expect((await mB.query(`SELECT count(*)::int n FROM accounting_journal_entries`))[0].n).toBe(0);

    const run = await apRec.reconcile({}, maker, mA);
    expect((await apRec.listRuns({}, mA)).map((r) => r.id)).toEqual([run.id]);
    expect(await apRec.listRuns({}, mB)).toEqual([]);
    await expect(apRec.getRun(run.id, mB)).rejects.toBeInstanceOf(NotFoundException);
    expect((await apRec.apStatement({}, mA)).apAccountCode).toBe('2110');
  });

  it('AR: an adjustment moves the Customer Ledger and the GL inside Company A only (approved by the checker if the matrix gates it)', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    const before = await postedEvents('A');
    const submitted = await arAdj.submitAdjustment({ customerId, kind: 'adjustment', amount: '30.00', reason: 'billing correction', contraAccountCode: '5900', direction: 'debit' }, maker, mA);
    if (submitted.mode === 'approval') {
      await expect(arAdj.decide(submitted.approvalRequestId!, checker1, 'approved', undefined, mB)).rejects.toBeInstanceOf(NotFoundException);
      await arAdj.decide(submitted.approvalRequestId!, checker1, 'approved', undefined, mA);
    }
    expect(await postedEvents('A')).toBe(before + 1);
    expect(await postedEvents('B')).toBe(0);
    expect((await mA.query(`SELECT count(*)::int n FROM customer_ledger_entries WHERE "customerId" = $1`, [customerId]))[0].n).toBe(1);
    expect((await mB.query(`SELECT count(*)::int n FROM customer_ledger_entries`))[0].n).toBe(0);

    const run = await arRec.reconcile({}, maker, mA);
    expect((await arRec.listRuns({}, mA)).map((r) => r.id)).toEqual([run.id]);
    expect(await arRec.listRuns({}, mB)).toEqual([]);
    expect((await arRec.customerStatement(customerId, {}, mA)).subledger.length).toBe(1);
    expect((await arRec.customerStatement(customerId, {}, mB)).subledger.length).toBe(0);
  });

  it('Cash/Bank: an opening-balance adjustment posts to Company A\'s bank account only; its runs list is Company-local', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    const before = await postedEvents('A');
    const { approvalRequestId } = (await cbAdj.submitAdjustment({ kind: 'opening_balance', amount: '500.00', reason: 'opening', glAccountCode: '1101', counterAccountCode: '3105', direction: 'debit' }, maker, mA)) as { approvalRequestId: string };
    await cbAdj.decide(approvalRequestId, checker1, 'approved', undefined, mA);
    expect(await postedEvents('A')).toBe(before + 1);
    expect(await postedEvents('B')).toBe(0);
    expect(await cbRec.listRuns({}, mA)).toEqual([]);
    expect(await cbRec.listRuns({}, mB)).toEqual([]);
  });

  it('Inventory: a count-variance adjustment posts to Company A\'s inventory account only; the reconciliation run is A\'s', async () => {
    const mA = await mgr('A');
    const mB = await mgr('B');
    const before = await postedEvents('A');
    const { approvalRequestId } = await invAdj.submitAdjustment({ kind: 'physical_count_variance', amount: '40.00', reason: 'count', counterAccountCode: '5900', direction: 'credit' }, maker, mA);
    await expect(invAdj.decide(approvalRequestId, checker1, 'approved', undefined, mB)).rejects.toBeInstanceOf(NotFoundException);
    await invAdj.decide(approvalRequestId, checker1, 'approved', undefined, mA);
    expect(await postedEvents('A')).toBe(before + 1);
    expect(await postedEvents('B')).toBe(0);

    const run = await invRec.reconcile({}, maker, mA);
    expect((await invRec.listRuns({}, mA)).map((r) => r.id)).toEqual([run.id]);
    expect(await invRec.listRuns({}, mB)).toEqual([]);
  });

  it('Test F — nothing leaked into Company B (no journals, ledger movements, runs or financial events)', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    for (const t of ['accounting_journal_entries', 'accounting_financial_events', 'ap_reconciliation_runs', 'ar_reconciliation_runs', 'inventory_reconciliation_runs', 'supplier_ledger_entries', 'customer_ledger_entries']) {
      const exists = (await dsB.query(`SELECT to_regclass($1) AS t`, [`public.${t}`]))[0].t;
      if (exists) expect((await dsB.query(`SELECT count(*)::int n FROM "${t}"`))[0].n).toBe(0);
    }
  });
});
