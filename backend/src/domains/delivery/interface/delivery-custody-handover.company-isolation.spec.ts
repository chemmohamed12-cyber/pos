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
 * Vehicle Driver Workspace, Stage C / C4 (2026-10-22) - real-Postgres proof of the driver cash handover and the server-side custody reconciliation: a handover never exceeds the
 * cash the vehicle is expected to carry, confirmation is by someone else, every fact stays on its own line, the derived figures come from verified rows only, and posting an expense is
 * serialised with handovers.
 */
describe('C4 — driver handover and custody reconciliation — real-Postgres, A/B', () => {
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
  let driver = '';
  let vehicleId = '';
  let cashAccount = '';
  let deliveryService: DeliveryService;
  let handovers: CustodyHandoverService;
  const dsOf = (k: 'A' | 'B') => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  const mgr = async () => (await dsOf('A')).manager;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'c4_handover', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting', 'logistics'] });
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
    driver = randomUUID();
    await (await dsOf('A')).query(`INSERT INTO users (id, "fullName", email) VALUES ($1,'C4 Driver','c4-driver@test.local')`, [driver]);
    const dsA = await dsOf('A');
    await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") SELECT id, 'finance.cash_document.approve', 'editable' FROM roles WHERE key = 'admin' ON CONFLICT DO NOTHING`);

    // chart + period (Company A)
    for (const [code, name, type, normal, fn] of [
      ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'], ['1110', 'Accounts receivable', 'asset', 'debit', 'ar'], ['1190', 'Driver custody', 'asset', 'debit', null], ['1195', 'Driver expense float', 'asset', 'debit', null], ['5900', 'Vehicle expenses', 'expense', 'debit', null], ['3999', 'Cash clearing', 'asset', 'debit', null],
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
    cashAccount = cash.id;
    vehicleId = randomUUID();
    await dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","driverUserId","custodyAccountId","settlementAccountId","status") VALUES ($1,'V-C4-1','PLATE-1',$2,$3,$4,'active')`, [vehicleId, driver, custodyA, cash.id]);

    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const shipments = new ShipmentService(h.controlPlane, numbering, processEngine, authorization, audit, events, inert, inert, treasury, inert, inert, inert);
    const fulfillment = { getFulfillmentOrder: async (id: string) => ({ id, salesOrderId: randomUUID(), warehouseId: randomUUID(), orderNumber: null, createdAt: new Date() }), getFulfillmentOrderBySalesOrderId: async () => null } as unknown as FulfillmentContract;
    const salesOrders = { getOrderSnapshot: async () => null } as unknown as SalesOrdersReadContract;
    const delivery = new DeliveryService(h.controlPlane, shipments, fulfillment, salesOrders, treasury, inert, audit, events, numbering, inert, inert);
    deliveryService = delivery;
    const approvals = new ApprovalEngineService(ambient, new ProcessEngineService(ambient), new AuditService(ambient), events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    const permissions = new PermissionService(dsA.getRepository(RolePermission), authorization);
    handovers = new CustodyHandoverService(h.controlPlane, shipments, new VehicleAccessService(authorization, permissions), authorization, audit, numbering, treasury);
    expenses = new CustodyExpenseService(h.controlPlane, delivery, shipments, audit, events, numbering, approvals, config, treasury);
    await expenses.onModuleInit();

    cfg['accounting.treasury_disbursement_reason_accounts'] = { custody_fuel: '5900', custody_toll: '5900', SALARY_ADVANCE: '5900' };
    cfg['accounting.cash_movement_clearing_account_code'] = '3999';
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('C3 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  async function newShipment(cod: string | null = null): Promise<string> {
    const ds = await dsOf('A');
    const id = randomUUID();
    await ds.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","vehicleId","driverUserId","codAmount") VALUES ($1,$2,$3,$4,$5,$6)`, [id, randomUUID(), `WB-C4-${id.slice(0, 8)}`, vehicleId, driver, cod]);
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,'out_for_delivery')`, [randomUUID(), id]);
    return id;
  }
  const collect = async (shipmentId: string, amount: string) => deliveryService.recordCollection(shipmentId, amount, 'cash', claimant, await mgr());
  const declare = async (amount: string, who = driver, key: string | null = null) => handovers.declare(vehicleId, amount, null, key, who, await mgr());
  const recon = async () => (await handovers.getReconciliation(vehicleId, claimant, await mgr())).reconciliation;
  const claimExpense = async (shipmentId: string, amount: string) => expenses.claim({ shipmentId, category: 'custody_fuel', amount, reason: 'Fuel for the trip' }, claimant, await mgr());
  const approveExpense = async (id: string) => expenses.decide(id, approver, 'approved', undefined, await mgr());

  it('K1 a handover can never exceed the cash the vehicle is expected to carry; instalments up to exactly that amount are accepted; a retry with the same clientKey records nothing again', async () => {
    await expect(declare('10.00')).rejects.toThrow(/exceeds the cash this vehicle is expected to be carrying \(0.00/);
    const s = await newShipment('500.00');
    await collect(s, '500.00');
    expect((await recon()).derived.cashInDriverHand).toBe('500.00');
    const a = await declare('300.00', driver, 'handover-key-0001');
    const again = await declare('300.00', driver, 'handover-key-0001');
    expect(again.id).toBe(a.id);
    expect(a.handoverNumber).toMatch(/^CHO-/);
    await expect(declare('300.00')).rejects.toThrow(/exceeds the cash this vehicle is expected to be carrying \(200.00/);
    await declare('200.00');
    expect((await recon()).derived.cashInDriverHand).toBe('0.00');
    await expect(declare('0.01')).rejects.toThrow(/exceeds/);
    await expect(declare('300.00', driver, 'handover-key-0001').then(() => declare('1.00', driver, 'handover-key-0001'))).rejects.toThrow(/already used for a different handover/);
  });

  it('K2 only the vehicle driver or an admin may declare; a stranger is refused; the reconciliation of a vehicle is "not found" for a user with no vehicle rights', async () => {
    const stranger = randomUUID();
    await (await dsOf('A')).query(`INSERT INTO users (id, "fullName", email) VALUES ($1,'Stranger','c4-stranger@test.local')`, [stranger]);
    await expect(handovers.declare(vehicleId, '1.00', null, null, stranger, await mgr())).rejects.toThrow(/Only the driver of this vehicle/);
    await expect(handovers.getReconciliation(vehicleId, stranger, await mgr())).rejects.toThrow(/not found/i);
  });

  it('K3 confirmation / rejection: never by the declarer; rejection needs a reason and gives the amount back; deciding twice is idempotent; a decided handover cannot flip', async () => {
    const before = Number((await recon()).derived.cashInDriverHand);
    const s = await newShipment('100.00');
    await collect(s, '100.00');
    const h1 = await declare('40.00');
    await expect(handovers.decide(h1.id, 'confirmed', null, driver, await mgr())).rejects.toThrow(/someone other than the person who declared/);
    await expect(handovers.decide(h1.id, 'rejected', 'x', approver, await mgr())).rejects.toThrow(/rejection reason/);
    const ok = await handovers.decide(h1.id, 'confirmed', null, approver, await mgr());
    expect(ok.status).toBe('confirmed');
    expect((await handovers.decide(h1.id, 'confirmed', null, approver, await mgr())).status).toBe('confirmed');
    await expect(handovers.decide(h1.id, 'rejected', 'changed my mind', approver, await mgr())).rejects.toThrow(/already confirmed/);
    const h2 = await declare('60.00');
    const rej = await handovers.decide(h2.id, 'rejected', 'cashier counted less', approver, await mgr());
    expect(rej.status).toBe('rejected');
    expect(Number((await recon()).derived.cashInDriverHand)).toBe(before + 100 - 40); // the rejected 60 is back in the driver's hand
  });

  /** A vehicle's separate EXPENSE FLOAT: a GL-mapped cash account funded by a Treasury transfer (the call a transfer document makes after its approvals). */
  async function mkFloat(code: string, fund: string): Promise<string> {
    const dsA = await dsOf('A');
    const types = await treasury.listAccountTypes(dsA.manager);
    const acct = (await treasury.createAccount(code, `${code} float`, types.find((t) => t.code === 'cash')!.id, claimant, dsA.manager)).id;
    await treasury.setAccountGlMapping(acct, '1195', claimant, dsA.manager);
    await treasury.cashIn(cashAccount, fund, null, null, 'seed', 'seed company cash', claimant, dsA.manager);
    await treasury.transferDirect(cashAccount, acct, fund, 'FUND', 'float funding', claimant, dsA.manager);
    return acct;
  }

  it('K4 the reconciliation keeps every fact on its own line; collections and the separate expense float are reconciled independently (expenses never touch collections); consistent data gives 0.00 differences', async () => {
    const dsA = await dsOf('A');
    // a clean vehicle so the figures are exact
    const v2 = randomUUID();
    const types = await treasury.listAccountTypes(dsA.manager);
    const acct = (await treasury.createAccount('C4-CUST2', 'C4 custody 2', types.find((t) => t.code === 'custody')!.id, claimant, dsA.manager)).id;
    await treasury.setAccountGlMapping(acct, '1190', claimant, dsA.manager);
    const float2 = await mkFloat('C4-FLOAT2', '200.00');
    await dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","driverUserId","custodyAccountId","settlementAccountId","expenseFloatAccountId","status") VALUES ($1,'V-C4-2','PLATE-2',$2,$3,$4,$5,'active')`, [v2, driver, acct, cashAccount, float2]);
    const mk = async (cod: string) => {
      const id = randomUUID();
      await dsA.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","vehicleId","driverUserId","codAmount") VALUES ($1,$2,$3,$4,$5,$6)`, [id, randomUUID(), `WB-C4-V2-${id.slice(0, 6)}`, v2, driver, cod]);
      await dsA.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,'out_for_delivery')`, [randomUUID(), id]);
      return id;
    };
    const s1 = await mk('500.00');
    const s2 = await mk('300.00');
    const s3 = await mk('90.00');
    const c1 = await collect(s1, '500.00');
    const c2 = await collect(s2, '300.00');
    const c3 = await collect(s3, '90.00');
    await deliveryService.rejectCollection(c3.id, 'not received', approver, await mgr()); // 90 rejected: reversed in the ledger, out of every figure
    await deliveryService.confirmCollection(c1.id, approver, await mgr());
    const custodyBefore = await treasury.getAccountBalance(acct, await mgr());
    const exp = await expenses.claim({ shipmentId: s1, category: 'custody_fuel', amount: '50.00', reason: 'Fuel' }, claimant, await mgr());
    await approveExpense(exp.id);
    await expenses.post(exp.id, poster, await mgr());
    await expenses.claim({ shipmentId: s2, category: 'custody_toll', amount: '7.00', reason: 'Toll' }, claimant, await mgr()); // pending approval
    expect(await treasury.getAccountBalance(acct, await mgr())).toBe(custodyBefore); // posting an expense did not move the collection custody account
    const h = await handovers.declare(v2, '100.00', null, null, driver, await mgr());
    await handovers.decide(h.id, 'confirmed', null, approver, await mgr());
    await handovers.declare(v2, '25.00', null, null, driver, await mgr()); // still only declared
    await deliveryService.remitCollection(c2.id, poster, cashAccount, await mgr()); // finance moves 300.00 into the settlement account

    const r = (await handovers.getReconciliation(v2, claimant, await mgr())).reconciliation;
    expect(r.collections).toEqual({ recorded: '0.00', confirmed: '800.00', rejected: '90.00', counted: '800.00', remitted: '300.00', notYetRemitted: '500.00' });
    expect(r.expenses).toEqual({ pendingApproval: '7.00', approvedNotPosted: '0.00', posted: '50.00', rejectedOrCancelled: '0.00' });
    expect(r.handovers).toEqual({ declared: '25.00', confirmed: '100.00', rejected: '0.00', handedOver: '125.00' });
    expect(r.derived.cashInDriverHand).toBe('675.00'); // 800 - 125: the 50.00 expense is NOT subtracted - it was paid from the float
    expect(r.derived.expectedCustodyAccountBalance).toBe('500.00'); // 800 - 300
    expect(r.derived.ledgerDifference).toBe('0.00'); // the collection custody account really holds 500.00
    expect(r.float).toEqual({ assigned: true, balance: '150.00', expectedBalance: '150.00', difference: '0.00', pendingApproval: '7.00', approvedNotPosted: '0.00', posted: '50.00', reversed: '0.00', availableAfterCommitments: '143.00' });
  });

  it('K5 expenses and handovers are independent: a large handover does not block an expense, and an expense never reduces the cash the driver must hand over', async () => {
    const dsA = await dsOf('A');
    const v3 = randomUUID();
    const types = await treasury.listAccountTypes(dsA.manager);
    const acct = (await treasury.createAccount('C4-CUST3', 'C4 custody 3', types.find((t) => t.code === 'custody')!.id, claimant, dsA.manager)).id;
    await treasury.setAccountGlMapping(acct, '1190', claimant, dsA.manager);
    const float3 = await mkFloat('C4-FLOAT3', '300.00');
    await dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","driverUserId","custodyAccountId","settlementAccountId","expenseFloatAccountId","status") VALUES ($1,'V-C4-3','PLATE-3',$2,$3,$4,$5,'active')`, [v3, driver, acct, cashAccount, float3]);
    const sid = randomUUID();
    await dsA.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","vehicleId","driverUserId","codAmount") VALUES ($1,$2,$3,$4,$5,'500.00')`, [sid, randomUUID(), `WB-C4-V3`, v3, driver]);
    await dsA.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,'out_for_delivery')`, [randomUUID(), sid]);
    await collect(sid, '500.00');
    await handovers.declare(v3, '500.00', null, null, driver, await mgr()); // the whole 500.00 of collections is declared handed over
    const x = await claimExpense(sid, '100.00');
    await approveExpense(x.id);
    expect((await expenses.post(x.id, poster, await mgr())).status).toBe('posted'); // paid from the float, not blocked by the handover
    const r = (await handovers.getReconciliation(v3, claimant, await mgr())).reconciliation;
    expect(r.derived.cashInDriverHand).toBe('0.00');
    expect(r.float.balance).toBe('200.00');
    expect(await treasury.getAccountBalance(acct, await mgr())).toBe('500.00');
  });

  it('K7 (Phase 2 review) the direct reconciliation route follows the SAME visibility rule as the workspace: a fleet reader without collection rights gets "not found", a collection viewer and the vehicle driver can read it', async () => {
    const dsA = await dsOf('A');
    const mkRoleUser = async (name: string, nodes: Array<[string, string]>) => {
      const id = randomUUID();
      await dsA.query(`INSERT INTO users (id, "fullName", email) VALUES ($1,$2,$3)`, [id, name, `${name}-${id.slice(0, 6)}@k7.local`]);
      const roleId = randomUUID();
      await dsA.query(`INSERT INTO roles (id, key) VALUES ($1,$2)`, [roleId, `k7-${name}-${id.slice(0, 6)}`]);
      for (const [node, access] of nodes) await dsA.query(`INSERT INTO role_permissions (id, "roleId", "nodeKey", access) VALUES ($1,$2,$3,$4)`, [randomUUID(), roleId, node, access]);
      await dsA.query(`INSERT INTO user_roles (id, "userId", "roleId") VALUES ($1,$2,$3)`, [randomUUID(), id, roleId]);
      return id;
    };
    const fleetOnly = await mkRoleUser('fleetonly', [['logistics.vehicle.view', 'read-only']]);
    const collViewer = await mkRoleUser('collviewer', [['logistics.vehicle.view', 'read-only'], ['logistics.collection.view', 'read-only']]);
    await expect(handovers.getReconciliation(vehicleId, fleetOnly, await mgr())).rejects.toThrow(/not found/i);
    expect((await handovers.getReconciliation(vehicleId, collViewer, await mgr())).vehicleId).toBe(vehicleId);
    expect((await handovers.getReconciliation(vehicleId, driver, await mgr())).vehicleId).toBe(vehicleId);
  });

  it('K8 (Phase 2 review) a REVERSED funding transfer keeps the float reconciliation at 0.00 difference (the funded total mirrors the Treasury balance rule); remitting a collection into a float account is refused', async () => {
    const dsA = await dsOf('A');
    const v4 = randomUUID();
    const float4 = await mkFloat('C4-FLOAT4', '100.00');
    const inLeg = await dsA.query(`SELECT id FROM treasury_transactions WHERE "treasuryAccountId" = $1 AND type = 'transfer_in'`, [float4]);
    await treasury.reverseTransaction(inLeg[0].id, 'funded the wrong float', claimant, dsA.manager, { ownerBypass: true });
    await dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","driverUserId","expenseFloatAccountId","status") VALUES ($1,'V-C4-4','PLATE-4',$2,$3,'active')`, [v4, driver, float4]);
    const r = (await handovers.getReconciliation(v4, claimant, await mgr())).reconciliation;
    expect(r.float.balance).toBe('0.00');
    expect(r.float.expectedBalance).toBe('0.00');
    expect(r.float.difference).toBe('0.00');
    const sid = randomUUID();
    await dsA.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","vehicleId","driverUserId","codAmount") VALUES ($1,$2,$3,$4,$5,'40.00')`, [sid, randomUUID(), 'WB-C4-V4', v4, driver]);
    await dsA.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,'out_for_delivery')`, [randomUUID(), sid]);
    const c4 = await collect(sid, '40.00');
    await expect(deliveryService.remitCollection(c4.id, poster, float4, await mgr())).rejects.toThrow(/vehicle expense float/);
    expect((await dsA.query(`SELECT "remittanceStatus" AS s FROM collections WHERE id = $1`, [c4.id]))[0].s).toBe('pending');
  });

  it('K6 Company B is untouched', async () => {
    const dsB = await dsOf('B');
    expect(Number((await dsB.query(`SELECT count(*) AS n FROM "custody_handovers"`))[0].n)).toBe(0);
    expect(Number((await dsB.query(`SELECT count(*) AS n FROM "custody_expenses"`))[0].n)).toBe(0);
  });
});
