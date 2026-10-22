import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { DeliveryService } from '../application/delivery.service';
import { CustodyExpenseService } from '../application/custody-expense.service';
import { CustodyHandoverService } from '../application/custody-handover.service';
import { VehicleAccessService } from '../../shipment/application/vehicle-access.service';
import { RolePermission } from '../../../foundation/permission/role-permission.entity';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../accounting/application/journal-entry.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../accounting/application/financial-events/handler-registry';
import { GLAccountService } from '../../accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../accounting/application/fiscal-period.service';
import { CurrencyService } from '../../accounting/application/currency.service';
import { FinancialDimensionService } from '../../accounting/application/financial-dimension.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { ApprovalRequestType } from '../../../foundation/approval-engine/approval-request-type.entity';
import { ApprovalMatrixRule } from '../../../foundation/approval-engine/approval-matrix-rule.entity';
import { ApprovalRequest } from '../../../foundation/approval-engine/approval-request.entity';
import { ApprovalDecision } from '../../../foundation/approval-engine/approval-decision.entity';
import { ProcessInstance } from '../../../foundation/process-engine/process-instance.entity';
import { ProcessTransitionRecord } from '../../../foundation/process-engine/process-transition-record.entity';
import { AuditRecord } from '../../../foundation/audit/audit-record.entity';
import { EventOutbox } from '../../../foundation/events/event-outbox.entity';
import { FulfillmentContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import { SalesOrdersReadContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Vehicle Driver Workspace, Stage C / C3 (2026-10-22; D-4, D-5) - real-Postgres proof of the custody-expense flow: a claim is validated against the company posting profile and a
 * GL-mapped custody account (fail closed), EVERY expense needs a separate approver through the FA-01 engine, posting is an explicit Treasury cash-out (balance checked, one GL event,
 * Treasury == GL), a retry changes nothing, and Company B never sees any of it.
 */
describe('C3 — custody expenses: claim → separate approval → explicit posting — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let expenses: CustodyExpenseService;
  let treasury: TreasuryService;
  const cfg: Record<string, unknown> = {};
  const year = new Date().toISOString().slice(0, 4);
  let claimant: string;
  let approver: string;
  let poster: string;
  let custodyA = '';
  let shippingCompanyA = '';
  const dsOf = (k: 'A' | 'B') => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  const mgr = async () => (await dsOf('A')).manager;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'c3_expenses', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting', 'logistics'] });
    const opts = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
    ambient = new DataSource({
      type: 'postgres', host: opts.host, port: opts.port, username: opts.username, password: opts.password, database: opts.database,
      entities: [ApprovalRequestType, ApprovalMatrixRule, ApprovalRequest, ApprovalDecision, ProcessInstance, ProcessTransitionRecord, AuditRecord, EventOutbox],
      synchronize: false, logging: false,
    });
    await ambient.initialize();
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const config = { get: (key: string) => cfg[key] } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
    new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config).onModuleInit();
    treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);

    claimant = (await h.createUserWithAdminRoleIn('Claimant', h.companyAId)).id;
    approver = (await h.createUserWithAdminRoleIn('Approver', h.companyAId)).id;
    poster = (await h.createUserWithAdminRoleIn('Poster', h.companyAId)).id;
    const dsA = await dsOf('A');
    await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") SELECT id, 'finance.cash_document.approve', 'editable' FROM roles WHERE key = 'admin' ON CONFLICT DO NOTHING`);

    // chart + period (Company A)
    for (const [code, name, type, normal, fn] of [
      ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'], ['1190', 'Driver custody', 'asset', 'debit', null], ['5900', 'Vehicle expenses', 'expense', 'debit', null], ['3999', 'Cash clearing', 'asset', 'debit', null],
    ] as const) {
      await dsA.query(`INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`, [randomUUID(), code, name, type, normal, fn]);
    }
    const fy = randomUUID();
    const fp = randomUUID();
    await dsA.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await dsA.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await dsA.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`, [randomUUID(), fy, randomUUID(), fp]);
    await numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, dsA.manager);

    const types = await treasury.listAccountTypes(dsA.manager);
    const custodyType = types.find((t) => t.code === 'custody')!.id;
    const cash = await treasury.createAccount('C3-CASH', 'C3 cash', types.find((t) => t.code === 'cash')!.id, claimant, dsA.manager);
    await treasury.setAccountGlMapping(cash.id, '1101', claimant, dsA.manager);
    custodyA = (await treasury.createAccount('C3-CUSTODY', 'C3 custody', custodyType, claimant, dsA.manager)).id;
    await treasury.setAccountGlMapping(custodyA, '1190', claimant, dsA.manager);
    shippingCompanyA = randomUUID();
    await dsA.query(`INSERT INTO "shipping_companies" ("id","code","name","custodyAccountId","treasuryAccountId","status") VALUES ($1,'SC-C3','C3 Carrier',$2,$3,'active')`, [shippingCompanyA, custodyA, cash.id]);

    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const shipments = new ShipmentService(h.controlPlane, numbering, processEngine, authorization, audit, events, inert, inert, treasury, inert, inert, inert);
    const fulfillment = { getFulfillmentOrder: async (id: string) => ({ id, salesOrderId: randomUUID(), warehouseId: randomUUID(), orderNumber: null, createdAt: new Date() }), getFulfillmentOrderBySalesOrderId: async () => null } as unknown as FulfillmentContract;
    const salesOrders = { getOrderSnapshot: async () => null } as unknown as SalesOrdersReadContract;
    const delivery = new DeliveryService(h.controlPlane, shipments, fulfillment, salesOrders, treasury, inert, audit, events, numbering, inert, inert);
    const approvals = new ApprovalEngineService(ambient, new ProcessEngineService(ambient), new AuditService(ambient), events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    expenses = new CustodyExpenseService(h.controlPlane, delivery, shipments, audit, events, numbering, approvals, config, treasury, new CustodyHandoverService(h.controlPlane, shipments, new VehicleAccessService(authorization, new PermissionService(dsA.getRepository(RolePermission), authorization)), authorization, audit, numbering));
    await expenses.onModuleInit();

    cfg['accounting.treasury_disbursement_reason_accounts'] = { custody_fuel: '5900', custody_toll: '5900', SALARY_ADVANCE: '5900' };
    cfg['accounting.cash_movement_clearing_account_code'] = '3999';
    // the driver's cash: 1000.00 sits in the custody account (as if collected)
    await treasury.cashIn(custodyA, '1000.00', null, null, 'seed', 'seed custody cash', claimant, dsA.manager);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('C3 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  async function newShipment(): Promise<string> {
    const ds = await dsOf('A');
    const id = randomUUID();
    await ds.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","shippingCompanyId") VALUES ($1,$2,$3,$4)`, [id, randomUUID(), `WB-C3-${id.slice(0, 8)}`, shippingCompanyA]);
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,'out_for_delivery')`, [randomUUID(), id]);
    return id;
  }
  const claim = async (shipmentId: string, over: Partial<{ category: string; amount: string; reason: string; clientKey: string; incurredOn: string }> = {}) =>
    expenses.claim({ shipmentId, category: 'custody_fuel', amount: '100.00', reason: 'Fuel for the trip', ...over }, claimant, await mgr());
  const decide = async (id: string, who: string, d: 'approved' | 'rejected') => expenses.decide(id, who, d, undefined, await mgr());
  async function glBal(code: string): Promise<string> {
    const r = await (await dsOf('A')).query(
      `SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"),0)::numeric(20,2)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" JOIN "accounting_journal_entries" je ON je.id = jl."journalEntryId" AND je."postedAt" IS NOT NULL WHERE ga.code = $1`,
      [code],
    );
    return r[0].b;
  }
  const count = async (table: string) => Number((await (await dsOf('A')).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
  const custodyBalance = async () => treasury.getAccountBalance(custodyA, await mgr());

  it('H1 categories are the mapped custody_* reasons only; an unmapped, non-custody or malformed category, a bad amount or reason is refused and records nothing', async () => {
    expect(expenses.listCategories()).toEqual(['custody_fuel', 'custody_toll']); // SALARY_ADVANCE is mapped but not a custody category
    const s = await newShipment();
    const before = await count('custody_expenses');
    await expect(claim(s, { category: 'custody_unknown' })).rejects.toThrow(/has no account in the company posting profile/);
    await expect(claim(s, { category: 'SALARY_ADVANCE' })).rejects.toThrow(/custody_\* reason code/);
    await expect(claim(s, { amount: '0' })).rejects.toThrow(/positive number/);
    await expect(claim(s, { amount: '10.123' })).rejects.toThrow(/positive number/);
    await expect(claim(s, { reason: 'x' })).rejects.toThrow(/reason of 3-255/);
    await expect(claim(s, { incurredOn: '2999-01-01' })).rejects.toThrow(/future/);
    expect(await count('custody_expenses')).toBe(before);
    expect(await count('shipment_custodies')).toBe(0); // a refused claim did not even open a custody record
  });

  it('H2 a claim is pending approval with an approval request and a CEX number; a second claim on the same shipment shares ONE custody record', async () => {
    const s = await newShipment();
    const a = await claim(s);
    const b = await claim(s, { category: 'custody_toll', amount: '20.00', reason: 'Toll road' });
    expect(a.status).toBe('pending_approval');
    expect(a.approvalRequestId).toBeTruthy();
    expect(a.expenseNumber).toMatch(/^CEX-/);
    expect(a.custodyId).toBe(b.custodyId);
    expect((await (await dsOf('A')).query(`SELECT count(*)::int AS n FROM "shipment_custodies" WHERE "shipmentId" = $1`, [s]))[0].n).toBe(1);
  });

  it('H3 the claimant cannot approve his own expense (maker != checker); a different approver can; nothing is posted by approving', async () => {
    const s = await newShipment();
    const x = await claim(s);
    const balance = await custodyBalance();
    const journals = await count('accounting_journal_entries');
    await expect(decide(x.id, claimant, 'approved')).rejects.toThrow();
    expect((await expenses.listForShipmentUnscoped(s, await mgr()))[0].status).toBe('pending_approval');
    const ok = await decide(x.id, approver, 'approved');
    expect(ok.status).toBe('approved');
    expect(ok.decidedByUserId).toBe(approver);
    expect(await custodyBalance()).toBe(balance);
    expect(await count('accounting_journal_entries')).toBe(journals);
  });

  it('H4 posting needs an approved expense; posting moves the cash from the custody account, creates ONE GL journal (Dr expense / Cr custody) and Treasury == GL; a retry changes nothing', async () => {
    const s = await newShipment();
    const x = await claim(s, { amount: '150.00' });
    await expect(expenses.post(x.id, poster, await mgr())).rejects.toThrow(/Only an approved expense can be posted/);
    await decide(x.id, approver, 'approved');
    const bal0 = await custodyBalance();
    const gl5900 = await glBal('5900');
    const gl1190 = await glBal('1190');
    const journals = await count('accounting_journal_entries');
    const txns = await count('treasury_transactions');
    const posted = await expenses.post(x.id, poster, await mgr());
    expect(posted.status).toBe('posted');
    expect(posted.postedByUserId).toBe(poster);
    expect(posted.treasuryTransactionId).toBeTruthy();
    expect(Number(await custodyBalance())).toBe(Number(bal0) - 150);
    expect(Number(await glBal('5900'))).toBe(Number(gl5900) + 150);
    expect(Number(await glBal('1190'))).toBe(Number(gl1190) - 150);
    expect((await count('accounting_journal_entries')) - journals).toBe(1);
    const again = await expenses.post(x.id, poster, await mgr());
    expect(again.treasuryTransactionId).toBe(posted.treasuryTransactionId);
    expect(await count('treasury_transactions')).toBe(txns + 1);
    expect((await count('accounting_journal_entries')) - journals).toBe(1);
  });

  it('H5 posting is refused when the custody balance does not cover it; the expense stays approved and posts after the cash is there (no overdraw, nothing netted)', async () => {
    const s = await newShipment();
    const bal = Number(await custodyBalance());
    const x = await claim(s, { amount: (bal + 500).toFixed(2) });
    await decide(x.id, approver, 'approved');
    await expect(expenses.post(x.id, poster, await mgr())).rejects.toThrow();
    expect((await expenses.listForShipmentUnscoped(s, await mgr()))[0].status).toBe('approved');
    expect(Number(await custodyBalance())).toBe(bal);
    await treasury.cashIn(custodyA, '1000.00', null, null, 'top-up', 'more cash collected', claimant, await mgr());
    expect((await expenses.post(x.id, poster, await mgr())).status).toBe('posted');
  });

  it('H6 a rejected expense can never be posted; the claimant can cancel an unposted claim, another user cannot, and a posted one cannot be cancelled', async () => {
    const s = await newShipment();
    const r = await claim(s);
    expect((await decide(r.id, approver, 'rejected')).status).toBe('rejected');
    await expect(expenses.post(r.id, poster, await mgr())).rejects.toThrow(/Only an approved expense/);

    const c = await claim(s);
    await expect(expenses.cancel(c.id, 'not needed', approver, await mgr())).rejects.toThrow(/Only the person who claimed/);
    expect((await expenses.cancel(c.id, 'not needed', claimant, await mgr())).status).toBe('cancelled');
    await expect(expenses.post(c.id, poster, await mgr())).rejects.toThrow(/Only an approved expense/);

    const p = await claim(s);
    await decide(p.id, approver, 'approved');
    await expenses.post(p.id, poster, await mgr());
    await expect(expenses.cancel(p.id, 'too late', claimant, await mgr())).rejects.toThrow(/cannot be cancelled/);
  });

  it('H7 fail closed: a custody account without a GL mapping refuses the claim; a category removed from the posting profile after approval blocks posting and the expense stays approved', async () => {
    const dsA = await dsOf('A');
    const types = await treasury.listAccountTypes(dsA.manager);
    const bare = (await treasury.createAccount('C3-BARE', 'unmapped custody', types.find((t) => t.code === 'custody')!.id, claimant, dsA.manager)).id;
    const sc = randomUUID();
    await dsA.query(`INSERT INTO "shipping_companies" ("id","code","name","custodyAccountId","status") VALUES ($1,'SC-C3-BARE','Bare',$2,'active')`, [sc, bare]);
    const sBare = randomUUID();
    await dsA.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","shippingCompanyId") VALUES ($1,$2,$3,$4)`, [sBare, randomUUID(), `WB-C3-BARE`, sc]);
    await dsA.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,'out_for_delivery')`, [randomUUID(), sBare]);
    await expect(claim(sBare)).rejects.toThrow(/not GL-mapped/);

    const s = await newShipment();
    const x = await claim(s, { category: 'custody_toll', amount: '5.00', reason: 'Toll' });
    await decide(x.id, approver, 'approved');
    const saved = cfg['accounting.treasury_disbursement_reason_accounts'];
    cfg['accounting.treasury_disbursement_reason_accounts'] = { custody_fuel: '5900' };
    await expect(expenses.post(x.id, poster, await mgr())).rejects.toThrow();
    cfg['accounting.treasury_disbursement_reason_accounts'] = saved;
    expect((await expenses.listForShipmentUnscoped(s, await mgr()))[0].status).toBe('approved');
    expect((await expenses.post(x.id, poster, await mgr())).status).toBe('posted');
  });

  it('H8 a retry with the same clientKey returns the first claim (one row, one approval request); the same key for a different expense is refused', async () => {
    const s = await newShipment();
    const before = await count('custody_expenses');
    const a = await claim(s, { clientKey: 'expense-key-0001' });
    const b = await claim(s, { clientKey: 'expense-key-0001' });
    expect(b.id).toBe(a.id);
    expect((await count('custody_expenses')) - before).toBe(1);
    await expect(claim(s, { clientKey: 'expense-key-0001', amount: '55.00' })).rejects.toThrow(/already used for a different expense/);
  });

  it('H9 Treasury == GL for the custody account after all the above, no journal is unbalanced, and Company B is untouched', async () => {
    // the seeded custody cash was never journalled (non-emitting cash-in); every POSTED expense was, exactly once: GL == -(sum of posted expenses)
    const postedSum = Number((await (await dsOf('A')).query(`SELECT COALESCE(SUM(amount),0)::numeric(20,2)::text AS t FROM custody_expenses WHERE status = 'posted'`))[0].t);
    expect(Number(await glBal('1190'))).toBe(-postedSum);
    expect(Number(await glBal('5900'))).toBe(postedSum);
    expect((await (await dsOf('A')).query(`SELECT count(*)::int AS n FROM accounting_journal_entries WHERE "postedAt" IS NOT NULL AND "totalDebitBase" <> "totalCreditBase"`))[0].n).toBe(0);
    const dsB = await dsOf('B');
    expect(Number((await dsB.query(`SELECT count(*) AS n FROM "custody_expenses"`))[0].n)).toBe(0);
    expect(Number((await dsB.query(`SELECT count(*) AS n FROM "shipment_custodies"`))[0].n)).toBe(0);
  });
});
