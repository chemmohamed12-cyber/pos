import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { DeliveryService } from '../application/delivery.service';
import { CustodyExpenseService } from '../application/custody-expense.service';
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
 * Vehicle Driver Workspace, Stage C / C3 (2026-10-22; D-4, D-5; reworked 2026-10-26 for the approved SEPARATE EXPENSE FLOAT policy) - real-Postgres proof of the custody-expense flow: a claim is
 * validated against the company posting profile and a GL-mapped vehicle expense float (fail closed), expenses are paid ONLY from the float and never touch customer collections, EVERY expense needs a separate approver through the FA-01 engine, posting is an explicit Treasury cash-out (balance checked, one GL event,
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
  let floatA = '';
  let cashA = '';
  let vehicleA = '';
  let shipmentSvc: ShipmentService;
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
      ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'], ['1190', 'Driver custody', 'asset', 'debit', null], ['1195', 'Driver expense float', 'asset', 'debit', null], ['5900', 'Vehicle expenses', 'expense', 'debit', null], ['3999', 'Cash clearing', 'asset', 'debit', null],
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
    cashA = cash.id;
    floatA = (await treasury.createAccount('C3-FLOAT', 'C3 expense float', types.find((t) => t.code === 'cash')!.id, claimant, dsA.manager)).id;
    await treasury.setAccountGlMapping(floatA, '1195', claimant, dsA.manager);
    vehicleA = randomUUID();
    await dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","custodyAccountId","settlementAccountId","expenseFloatAccountId","status") VALUES ($1,'V-C3-1','PLATE-C3',$2,$3,$4,'active')`, [vehicleA, custodyA, cash.id, floatA]);

    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const shipments = new ShipmentService(h.controlPlane, numbering, processEngine, authorization, audit, events, inert, inert, treasury, inert, inert, inert);
    const fulfillment = { getFulfillmentOrder: async (id: string) => ({ id, salesOrderId: randomUUID(), warehouseId: randomUUID(), orderNumber: null, createdAt: new Date() }), getFulfillmentOrderBySalesOrderId: async () => null } as unknown as FulfillmentContract;
    const salesOrders = { getOrderSnapshot: async () => null } as unknown as SalesOrdersReadContract;
    const delivery = new DeliveryService(h.controlPlane, shipments, fulfillment, salesOrders, treasury, inert, audit, events, numbering, inert, inert);
    const approvals = new ApprovalEngineService(ambient, new ProcessEngineService(ambient), new AuditService(ambient), events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    expenses = new CustodyExpenseService(h.controlPlane, delivery, shipments, audit, events, numbering, approvals, config, treasury);
    shipmentSvc = shipments;
    await expenses.onModuleInit();

    cfg['accounting.treasury_disbursement_reason_accounts'] = { custody_fuel: '5900', custody_toll: '5900', SALARY_ADVANCE: '5900' };
    cfg['accounting.cash_movement_clearing_account_code'] = '3999';
    // the driver's cash: 1000.00 sits in the custody account (as if collected)
    await treasury.cashIn(custodyA, '1000.00', null, null, 'seed', 'seed custody cash', claimant, dsA.manager);
    // the company's cash account holds money; the vehicle's expense FLOAT is funded by an ordinary Treasury transfer (the T3 transfer document does the same call after its approvals)
    await treasury.cashIn(cash.id, '5000.00', null, null, 'seed', 'seed company cash', claimant, dsA.manager);
    await treasury.transferDirect(cash.id, floatA, '1000.00', 'FUND-1', 'initial float', claimant, dsA.manager);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('C3 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  async function newShipment(): Promise<string> {
    const ds = await dsOf('A');
    const id = randomUUID();
    await ds.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","vehicleId") VALUES ($1,$2,$3,$4)`, [id, randomUUID(), `WB-C3-${id.slice(0, 8)}`, vehicleA]);
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
  const floatBalance = async () => treasury.getAccountBalance(floatA, await mgr());
  const fund = async (amount: string) => {
    const m = await mgr();
    await treasury.cashIn(cashA, amount, null, null, 'seed', 'top-up company cash', claimant, m);
    await treasury.transferDirect(cashA, floatA, amount, 'FUND-N', 'replenishment', claimant, m);
  };

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

  it('H4 posting needs an approved expense; posting pays out of the FLOAT, creates ONE GL journal (Dr expense / Cr float account) and leaves the collection custody account untouched; a retry changes nothing', async () => {
    const s = await newShipment();
    const x = await claim(s, { amount: '150.00' });
    expect(x.floatAccountId).toBe(floatA);
    await expect(expenses.post(x.id, poster, await mgr())).rejects.toThrow(/Only an approved expense can be posted/);
    await decide(x.id, approver, 'approved');
    const float0 = await floatBalance();
    const coll0 = await custodyBalance();
    const gl5900 = await glBal('5900');
    const gl1195 = await glBal('1195');
    const gl1190 = await glBal('1190');
    const journals = await count('accounting_journal_entries');
    const txns = await count('treasury_transactions');
    const posted = await expenses.post(x.id, poster, await mgr());
    expect(posted.status).toBe('posted');
    expect(posted.postedByUserId).toBe(poster);
    expect(Number(await floatBalance())).toBe(Number(float0) - 150);
    expect(await custodyBalance()).toBe(coll0); // customer collections were never used
    expect(await glBal('1190')).toBe(gl1190);
    expect(Number(await glBal('5900'))).toBe(Number(gl5900) + 150);
    expect(Number(await glBal('1195'))).toBe(Number(gl1195) - 150);
    expect((await count('accounting_journal_entries')) - journals).toBe(1);
    const again = await expenses.post(x.id, poster, await mgr());
    expect(again.treasuryTransactionId).toBe(posted.treasuryTransactionId);
    expect(await count('treasury_transactions')).toBe(txns + 1);
    expect((await count('accounting_journal_entries')) - journals).toBe(1);
  });

  it('H5 the float is the ONLY source: an expense larger than the float is refused even though the collection custody account holds plenty; it posts after a replenishment transfer', async () => {
    const s = await newShipment();
    await treasury.cashIn(custodyA, '3000.00', null, null, 'seed', 'more customer cash in custody', claimant, await mgr()); // collections hold plenty
    const fl = Number(await floatBalance());
    const coll = Number(await custodyBalance());
    expect(coll).toBeGreaterThan(fl + 400); // collections could have paid for it - and must not
    const x = await claim(s, { amount: (fl + 400).toFixed(2) });
    await decide(x.id, approver, 'approved');
    await expect(expenses.post(x.id, poster, await mgr())).rejects.toThrow();
    expect((await expenses.listForShipmentUnscoped(s, await mgr()))[0].status).toBe('approved');
    expect(Number(await floatBalance())).toBe(fl);
    expect(Number(await custodyBalance())).toBe(coll);
    await fund('1500.00'); // replenishment = an ordinary Treasury transfer
    expect((await expenses.post(x.id, poster, await mgr())).status).toBe('posted');
    expect(Number(await custodyBalance())).toBe(coll);
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

  it('H7 fail closed: no float assigned, an unmapped float account, a collection account used as the float, and a category removed from the posting profile all refuse - and record nothing', async () => {
    const dsA = await dsOf('A');
    const mkShipment = async (vehicle: string) => {
      const id = randomUUID();
      await dsA.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","vehicleId") VALUES ($1,$2,$3,$4)`, [id, randomUUID(), `WB-C3-${id.slice(0, 8)}`, vehicle]);
      await dsA.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,'out_for_delivery')`, [randomUUID(), id]);
      return id;
    };
    const types = await treasury.listAccountTypes(dsA.manager);
    const cashType = types.find((t) => t.code === 'cash')!.id;
    // 1. vehicle with no float
    const vNone = randomUUID();
    await dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","custodyAccountId","status") VALUES ($1,'V-C3-NONE','P-N',$2,'active')`, [vNone, custodyA]);
    await expect(claim(await mkShipment(vNone))).rejects.toThrow(/No expense float is assigned/);
    // 2. float account that is not GL-mapped
    const bare = (await treasury.createAccount('C3-BARE-FLOAT', 'bare float', cashType, claimant, dsA.manager)).id;
    const vBare = randomUUID();
    await dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","custodyAccountId","expenseFloatAccountId","status") VALUES ($1,'V-C3-BARE','P-B',$2,$3,'active')`, [vBare, custodyA, bare]);
    await expect(claim(await mkShipment(vBare))).rejects.toThrow(/not GL-mapped/);
    // 3. a float that equals the vehicle's collection custody account cannot even exist: the database refuses it (and the service refuses it at assignment and again at claim time)
    const vSame = randomUUID();
    await expect(dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","custodyAccountId","expenseFloatAccountId","status") VALUES ($1,'V-C3-SAME','P-S',$2,$2,'active')`, [vSame, custodyA])).rejects.toThrow(/CHK_vehicles_float_not_collection/);
    // 4. category removed from the posting profile after approval: posting refused, stays approved
    const s = await newShipment();
    const x = await claim(s, { category: 'custody_toll', amount: '5.00', reason: 'Toll' });
    await decide(x.id, approver, 'approved');
    const saved = cfg['accounting.treasury_disbursement_reason_accounts'];
    cfg['accounting.treasury_disbursement_reason_accounts'] = { custody_fuel: '5900' };
    await expect(expenses.post(x.id, poster, await mgr())).rejects.toThrow();
    cfg['accounting.treasury_disbursement_reason_accounts'] = saved;
    expect((await expenses.listForShipmentUnscoped(s, await mgr()))[0].status).toBe('approved');
    expect((await expenses.post(x.id, poster, await mgr())).status).toBe('posted');
    expect(await count('custody_expenses')).toBeGreaterThan(0);
    expect((await (await dsOf('A')).query(`SELECT count(*)::int AS n FROM custody_expenses WHERE "vehicleId" IN ($1,$2)`, [vNone, vBare]))[0].n).toBe(0);
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

  it('H10 reversal: finance reverses a posted expense (append-only offsetting leg + reversal journal), the float is restored, collections untouched; only posted ones; idempotent; reason mandatory', async () => {
    const s = await newShipment();
    const x = await claim(s, { amount: '40.00' });
    await expect(expenses.reverse(x.id, 'oops', poster, await mgr())).rejects.toThrow(/Only a posted expense can be reversed/);
    await decide(x.id, approver, 'approved');
    await expenses.post(x.id, poster, await mgr());
    const fl = Number(await floatBalance());
    const coll = await custodyBalance();
    const gl5900 = Number(await glBal('5900'));
    await expect(expenses.reverse(x.id, 'x', poster, await mgr())).rejects.toThrow(/reason of 3-255/);
    const r = await expenses.reverse(x.id, 'posted to the wrong category', poster, await mgr());
    expect(r.status).toBe('reversed');
    expect(r.reversalTransactionId).toBeTruthy();
    expect(r.reversedByUserId).toBe(poster);
    expect(Number(await floatBalance())).toBe(fl + 40);
    expect(Number(await glBal('5900'))).toBe(gl5900 - 40);
    expect(await custodyBalance()).toBe(coll);
    const txns = await count('treasury_transactions');
    expect((await expenses.reverse(x.id, 'again', poster, await mgr())).reversalTransactionId).toBe(r.reversalTransactionId);
    expect(await count('treasury_transactions')).toBe(txns);
    const orig = await (await dsOf('A')).query(`SELECT status FROM treasury_transactions WHERE id = $1`, [r.treasuryTransactionId]);
    expect(orig[0].status).toBe('reversed'); // history kept
  });

  it('H11 assigning a float is fail-closed: unknown / inactive / unmapped / bank accounts, a collection custody or settlement account and another vehicle\'s float are refused; unassigning needs a zero balance and no open claims', async () => {
    const dsA = await dsOf('A');
    const types = await treasury.listAccountTypes(dsA.manager);
    const m = await mgr();
    const v = randomUUID();
    await dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","custodyAccountId","settlementAccountId","status") VALUES ($1,'V-C3-ASSIGN','P-A',$2,$3,'active')`, [v, custodyA, cashA]);
    await expect(shipmentSvc.setVehicleExpenseFloat(v, randomUUID(), claimant, m)).rejects.toThrow(/not found/);
    const bank = (await treasury.createAccount('C3-BANK', 'bank', types.find((t) => t.code === 'bank')!.id, claimant, dsA.manager)).id;
    await treasury.setAccountGlMapping(bank, '1101', claimant, dsA.manager);
    await expect(shipmentSvc.setVehicleExpenseFloat(v, bank, claimant, m)).rejects.toThrow(/must be a cash account/);
    const bare = (await treasury.createAccount('C3-BARE2', 'bare', types.find((t) => t.code === 'cash')!.id, claimant, dsA.manager)).id;
    await expect(shipmentSvc.setVehicleExpenseFloat(v, bare, claimant, m)).rejects.toThrow(/not GL-mapped/);
    await expect(shipmentSvc.setVehicleExpenseFloat(v, custodyA, claimant, m)).rejects.toThrow(/already used as a collection custody/);
    await expect(shipmentSvc.setVehicleExpenseFloat(v, floatA, claimant, m)).rejects.toThrow(/already used as a collection custody \/ settlement account or as another vehicle/);
    const ok = (await treasury.createAccount('C3-FLOAT2', 'float 2', types.find((t) => t.code === 'cash')!.id, claimant, dsA.manager)).id;
    await treasury.setAccountGlMapping(ok, '1195', claimant, dsA.manager);
    expect((await shipmentSvc.setVehicleExpenseFloat(v, ok, claimant, m)).expenseFloatAccountId).toBe(ok);
    await treasury.transferDirect(cashA, ok, '25.00', 'fund', 'seed', claimant, m);
    await expect(shipmentSvc.setVehicleExpenseFloat(v, null, claimant, m)).rejects.toThrow(/still holds 25.00/);
    await treasury.transferDirect(ok, cashA, '25.00', 'return', 'return unused float', claimant, m); // returning the float = a transfer back
    expect((await shipmentSvc.setVehicleExpenseFloat(v, null, claimant, m)).expenseFloatAccountId).toBeNull();
  });

  it('H12 the accounting posting guard applies: with the fiscal period closed the payout is refused (nothing moves, the expense stays approved) and posts once the period is open again', async () => {
    const dsA = await dsOf('A');
    const s = await newShipment();
    const x = await claim(s, { amount: '12.00' });
    await decide(x.id, approver, 'approved');
    const fl = await floatBalance();
    const journals = await count('accounting_journal_entries');
    await dsA.query(`UPDATE "process_instances" SET "currentState" = 'closed' WHERE "definitionKey" = 'accounting_fiscal_period'`);
    try {
      await expect(expenses.post(x.id, poster, await mgr())).rejects.toThrow();
      expect((await expenses.listForShipmentUnscoped(s, await mgr()))[0].status).toBe('approved');
      expect(await floatBalance()).toBe(fl);
      expect(await count('accounting_journal_entries')).toBe(journals);
    } finally {
      await dsA.query(`UPDATE "process_instances" SET "currentState" = 'open' WHERE "definitionKey" = 'accounting_fiscal_period'`);
    }
    expect((await expenses.post(x.id, poster, await mgr())).status).toBe('posted');
  });

  it('H13 a float account can never become a settlement account of a vehicle or a shipping company (collections are not settled into it)', async () => {
    const dsA = await dsOf('A');
    const m = await mgr();
    await expect(shipmentSvc.setVehicleSettlementAccount(vehicleA, floatA, claimant, m)).rejects.toThrow(/vehicle expense float/);
    const sc = randomUUID();
    await dsA.query(`INSERT INTO "shipping_companies" ("id","code","name","status") VALUES ($1,'SC-H13','H13 Carrier','active')`, [sc]);
    await expect(shipmentSvc.setShippingCompanyTreasuryAccount(sc, floatA, claimant, m)).rejects.toThrow(/vehicle expense float/);
  });

  it('H14 one float, one vehicle: two concurrent assignments of the same new account - exactly one wins; the database backstops the race', async () => {
    const dsA = await dsOf('A');
    const m = await mgr();
    const types = await treasury.listAccountTypes(dsA.manager);
    const f = (await treasury.createAccount('C3-FLOAT-RACE', 'race float', types.find((t) => t.code === 'cash')!.id, claimant, dsA.manager)).id;
    await treasury.setAccountGlMapping(f, '1195', claimant, dsA.manager);
    const va = randomUUID();
    const vb = randomUUID();
    for (const [id, code] of [[va, 'V-RACE-A'], [vb, 'V-RACE-B']]) await dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","status") VALUES ($1,$2,$2,'active')`, [id, code]);
    const results = await Promise.allSettled([shipmentSvc.setVehicleExpenseFloat(va, f, claimant, m), shipmentSvc.setVehicleExpenseFloat(vb, f, claimant, m)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await dsA.query(`SELECT count(*)::int AS n FROM "vehicles" WHERE "expenseFloatAccountId" = $1`, [f]))[0].n).toBe(1);
    // the database also refuses a float equal to the vehicle's own collection account (backstop behind the service check)
    await expect(dsA.query(`UPDATE "vehicles" SET "expenseFloatAccountId" = "custodyAccountId" WHERE id = $1`, [vehicleA])).rejects.toThrow(/CHK_vehicles_float_not_collection/);
  });

  it('H9 end state: no journal is unbalanced; float GL == funded - posted-and-not-reversed; custody (collections) account and its GL were never touched; Company B untouched', async () => {
    const postedSum = Number((await (await dsOf('A')).query(`SELECT COALESCE(SUM(amount),0)::numeric(20,2)::text AS t FROM custody_expenses WHERE status = 'posted'`))[0].t);
    expect(Number(await glBal('5900'))).toBe(postedSum);
    expect(Number(await glBal('1195'))).toBe(Number(await floatBalance()));
    expect(Number(await glBal('1190'))).toBe(0); // the seed cash-in is non-emitting; no expense ever journalled against the collection custody account
    expect(Number(await custodyBalance())).toBe(4000); // 1000 seed + 3000 added in H5; no expense ever moved it
    expect((await (await dsOf('A')).query(`SELECT count(*)::int AS n FROM accounting_journal_entries WHERE "postedAt" IS NOT NULL AND "totalDebitBase" <> "totalCreditBase"`))[0].n).toBe(0);
    const dsB = await dsOf('B');
    expect(Number((await dsB.query(`SELECT count(*) AS n FROM "custody_expenses"`))[0].n)).toBe(0);
    expect(Number((await dsB.query(`SELECT count(*) AS n FROM "shipment_custodies"`))[0].n)).toBe(0);
  });
});
