import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { CommissionService } from './commission.service';
import { TargetService } from '../../targets/application/target.service';
import { HrService } from '../../hr/application/hr.service';
import { CustomersService } from '../../crm/application/customers.service';
import { UsersService } from '../../../foundation/identity/users.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

/**
 * ADR-071 (Commission & Target Phase 1) — proves the ratified `ADR-068`
 * decisions exactly as built: the Resolution Engine's Customer -> Customer
 * Group [inert] -> Sales Rep precedence (§A/§2/§9), flat and marginal-
 * tiered basis calculation (§3/§4/§C), the immutable `CommissionResult`
 * snapshot (§F), the `triggerEventKey` dedup invariant distinguishing an
 * Invoice event from a Collection event (§12), the unresolved-Sales-Rep
 * fail-closed behavior (§14), FA-01 SoD on the approval batch (§6), and
 * Target Management's own non-overlap/approval lifecycle (§D/§E).
 *
 * Commission subscribes to the ALREADY-EXISTING `finance.invoice.posted`/
 * `collection.remitted` topics — it never owns or recomputes the Sales
 * side. Rather than drive a full Sales-Order -> Fulfillment -> Delivery ->
 * COD-remittance pipeline just to produce those two events, this suite
 * publishes them directly via `EventBusService.publish` +
 * `dispatchPending()` with realistic payloads (the exact fields their real
 * publishers emit, confirmed by reading `invoices.service.ts` and
 * `delivery.service.ts`) — the same "fabricate only the opaque upstream
 * fixture, exercise every line this domain actually owns for real" method
 * `payroll-phase1.spec.ts` already used for its own `wages_payable`
 * control-account fixture.
 */
describe('CommissionService & TargetService (ADR-071, Commission & Target Phase 1)', () => {
  let moduleRef: TestingModule;
  let commission: CommissionService;
  let targets: TargetService;
  let hr: HrService;
  let customers: CustomersService;
  let users: UsersService;
  let approvals: ApprovalEngineService;
  let events: EventBusService;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const SECOND_APPROVER = 'f539302e-9ae7-4cc2-99cf-381f08acab83';
  const shortName = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000)}`;
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    commission = moduleRef.get(CommissionService);
    targets = moduleRef.get(TargetService);
    hr = moduleRef.get(HrService);
    customers = moduleRef.get(CustomersService);
    users = moduleRef.get(UsersService);
    approvals = moduleRef.get(ApprovalEngineService);
    events = moduleRef.get(EventBusService);
    dataSource = moduleRef.get(DataSource);
  }, 60_000);

  // Test-isolation fix (2026-09-21 incident): this suite has no isolated test
  // database (confirmed — no test in this codebase's history has ever had one;
  // every *.spec.ts boots the real AppModule against the same DB_NAME as the
  // dev server). Every OTHER domain's fixtures (Employees, Customers, Work
  // Orders, ...) are created through their own real service layer and are
  // functionally inert if left behind. `makeShipmentForCustomer` below is
  // the one exception in this file: it inserts directly into `sales_orders`/
  // `shipments` via raw SQL (Commission has no reason to own a create-path
  // for Sales Order fixtures), which deliberately bypasses
  // `SalesOrdersService.createOrder()` — including its own
  // `processEngine.start()` call. A row created this way is a valid,
  // complete `Shipment`/`SalesOrder` row for Commission's own purposes (a
  // shipment→sales_order→customer join), but an INCOMPLETE one for the real
  // Sales Orders UI, which lists every `sales_orders` row and expects each
  // to have a `process_instances` row. Left behind, these rows broke the
  // live Sales Orders page for a real user (2026-09-21). Tracked and
  // deleted here so a test re-run can never reproduce that again.
  const createdFixtureShipmentIds: string[] = [];
  const createdFixtureSalesOrderIds: string[] = [];

  afterAll(async () => {
    if (createdFixtureShipmentIds.length > 0) {
      await dataSource.query(`DELETE FROM shipments WHERE id = ANY($1)`, [createdFixtureShipmentIds]);
    }
    if (createdFixtureSalesOrderIds.length > 0) {
      await dataSource.query(`DELETE FROM sales_orders WHERE id = ANY($1)`, [createdFixtureSalesOrderIds]);
    }
    await moduleRef.close();
  });

  async function makeSalesRep(): Promise<{ employeeId: string; userId: string }> {
    const suffix = shortName('');
    const user = await users.create({ fullName: `Rep ${suffix}`, email: `rep.${suffix}@test.daii.local` });
    const emp = await hr.createEmployee({ fullName: shortName('RepEmp'), employmentType: 'full_time' }, ADMIN_A);
    await hr.linkUser(emp.id, user.id, ADMIN_A);
    return { employeeId: emp.id, userId: user.id };
  }

  async function makeAssignedCustomer(salesRepUserId: string): Promise<string> {
    const customer = await customers.createCustomer({ name: shortName('Cust') }, ADMIN_A);
    await customers.assignSalesRep(customer.id, salesRepUserId, 'primary', ADMIN_A);
    return customer.id;
  }

  async function publishAndDispatch(topic: string, payload: Record<string, unknown>): Promise<void> {
    await dataSource.transaction(async (manager) => {
      await events.publish(manager, topic, payload);
    });
    await events.dispatchPending();
  }

  async function publishInvoicePosted(customerId: string, netAmount: string, grossAmount: string): Promise<string> {
    const invoiceId = randomUUID();
    await publishAndDispatch('finance.invoice.posted', {
      invoiceId,
      invoiceNumber: shortName('INV'),
      customerId,
      salesOrderId: null,
      netAmount,
      taxAmount: '0.00',
      grossAmount,
    });
    return invoiceId;
  }

  /** Real `shipments.salesOrderId` link — the exact join `onCollectionRemitted` performs — via minimal raw-SQL fixtures for the two upstream tables Commission has no reason to own a create-path for. */
  async function makeShipmentForCustomer(customerId: string, salesRepUserId: string): Promise<string> {
    const salesOrderId = randomUUID();
    await dataSource.query(
      `INSERT INTO sales_orders (id, "orderNumber", "customerId", "salesRepUserId", "totalAmount") VALUES ($1,$2,$3,$4,$5)`,
      [salesOrderId, shortName('SO'), customerId, salesRepUserId, '1000.00'],
    );
    createdFixtureSalesOrderIds.push(salesOrderId);
    const shipmentId = randomUUID();
    await dataSource.query(
      `INSERT INTO shipments (id, "fulfillmentOrderId", "waybillNumber", "salesOrderId") VALUES ($1,$2,$3,$4)`,
      [shipmentId, shortName('FO'), shortName('WB'), salesOrderId],
    );
    createdFixtureShipmentIds.push(shipmentId);
    return shipmentId;
  }

  async function publishCollectionRemitted(shipmentId: string, amount: string): Promise<string> {
    const collectionId = randomUUID();
    await publishAndDispatch('collection.remitted', { collectionId, shipmentId, amount, businessDate: new Date().toISOString() });
    return collectionId;
  }

  it('1. Resolution precedence: a Customer-scoped policy wins over the Sales Rep default (ADR-068 §A/§9)', async () => {
    const rep = await makeSalesRep();
    const customerId = await makeAssignedCustomer(rep.userId);

    await commission.createPolicy({ scope: 'sales_rep', scopeRefId: rep.employeeId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.03' }, ADMIN_A);
    await commission.createPolicy({ scope: 'customer', scopeRefId: customerId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.10' }, ADMIN_A);

    const invoiceId = await publishInvoicePosted(customerId, '1000.00', '1000.00');

    const [result] = await commission.listResults(rep.employeeId);
    expect(result).toBeTruthy();
    expect(result.sourceTransactionRefs).toEqual({ invoice: invoiceId });
    expect(result.policyScope).toBe('customer'); // NOT 'sales_rep' — the customer policy won
    expect(Number(result.rate)).toBeCloseTo(0.1, 4);
    expect(Number(result.calculatedAmount)).toBeCloseTo(100, 2); // 1000 * 0.10, never the 0.03 sales-rep rate
  }, 30_000);

  it('2. Marginal-tier calculation: achievement above 100% is split band-by-band across tiers against the Approved Target (ADR-068 §3/§4)', async () => {
    const rep = await makeSalesRep();
    const customerId = await makeAssignedCustomer(rep.userId);

    const target = await targets.create({ employeeId: rep.employeeId, periodStart: today(), periodEnd: today(), targetValue: '10000.00' }, ADMIN_A);
    const submittedTarget = await targets.submitForApproval(target.id, ADMIN_A);
    await approvals.decide(submittedTarget.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    await commission.createPolicy(
      {
        scope: 'sales_rep',
        scopeRefId: rep.employeeId,
        basis: 'gross_sales', // net_sales is disabled (ADR-071 Addendum A-11)
        rateModel: 'target_tiered',
        tiers: [
          { tierOrder: 1, fromPercent: '0', toPercent: '100', rate: '0.02' },
          { tierOrder: 2, fromPercent: '100', toPercent: null, rate: '0.05' },
        ],
      },
      ADMIN_A,
    );

    // netAmount 15000 against a 10000 target = 150% achievement:
    // band 1 (0-100%) = 15000 * 1.00 * 0.02 = 300.00
    // band 2 (100-150%) = 15000 * 0.50 * 0.05 = 375.00 => 675.00 total
    await publishInvoicePosted(customerId, '15500.00', '15000.00'); // (net, gross) — the policy basis is gross_sales = 15000

    const [result] = await commission.listResults(rep.employeeId);
    expect(result.calculationBasis).toBe('gross_sales');
    expect(result.targetPeriodId).toBe(target.id);
    expect(Number(result.calculatedAmount)).toBeCloseTo(675, 2);
    const applicableTier = result.applicableTier as { achievementPercent: number; appliedTiers: unknown[] };
    expect(applicableTier.achievementPercent).toBeCloseTo(150, 2);
    expect(applicableTier.appliedTiers).toHaveLength(2);
  }, 30_000);

  it('3. Unresolved Sales Rep fails closed: a customer with no active assignment produces NO CommissionResult (ADR-071 §14)', async () => {
    const customer = await customers.createCustomer({ name: shortName('CustNoRep') }, ADMIN_A);
    await commission.createPolicy({ scope: 'customer', scopeRefId: customer.id, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.10' }, ADMIN_A);

    const invoiceId = await publishInvoicePosted(customer.id, '500.00', '500.00');

    const found = await dataSource.query(`SELECT id FROM commission_results WHERE "triggerEventKey" = $1`, [`invoice:${invoiceId}`]);
    expect(found).toHaveLength(0); // never guessed, never a zeroed/fallback result — just absent, surfaced for remediation
  }, 30_000);

  it('4. Dedup invariant: redelivering the same invoice event is a safe no-op; Invoice and Collection triggers never collide even off the same numeric id (ADR-071 §12)', async () => {
    const rep = await makeSalesRep();
    const customerId = await makeAssignedCustomer(rep.userId);
    await commission.createPolicy({ scope: 'sales_rep', scopeRefId: rep.employeeId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.05' }, ADMIN_A);

    const invoiceId = await publishInvoicePosted(customerId, '200.00', '200.00');
    // Redeliver the exact same event (simulating an outbox/consumer retry).
    await publishAndDispatch('finance.invoice.posted', { invoiceId, invoiceNumber: shortName('INV'), customerId, salesOrderId: null, netAmount: '200.00', taxAmount: '0.00', grossAmount: '200.00' });

    const rowsForInvoice = await dataSource.query(`SELECT id FROM commission_results WHERE "triggerEventKey" = $1`, [`invoice:${invoiceId}`]);
    expect(rowsForInvoice).toHaveLength(1); // exactly one, the redelivery was a no-op

    // Supersede with a 'collected_amount'-basis policy (the invoice-driven result above is already
    // an immutable snapshot, unaffected — proven separately by test 6) so the collection event
    // below actually has a matching basis to resolve against.
    await commission.createPolicy({ scope: 'sales_rep', scopeRefId: rep.employeeId, basis: 'collected_amount', rateModel: 'flat', flatRate: '0.02' }, ADMIN_A);

    const shipmentId = await makeShipmentForCustomer(customerId, rep.userId);
    const collectionId = await publishCollectionRemitted(shipmentId, '300.00');
    const rowsForCollection = await dataSource.query(`SELECT id FROM commission_results WHERE "triggerEventKey" = $1`, [`collection:${collectionId}`]);
    expect(rowsForCollection).toHaveLength(1); // a distinct trigger kind, never merged with the invoice's own key
  }, 30_000);

  it('5. Customer Group tier is architecturally present but functionally inert (ADR-071 §3/§21): resolution skips it and falls through to Sales Rep', async () => {
    const rep = await makeSalesRep();
    const customerId = await makeAssignedCustomer(rep.userId);

    // A customer_group-scoped policy exists in the table, at a deliberately distinct rate — proves
    // it is never even queried, not merely "queried and lost."
    // customer_group is disabled (ADR-071 Addendum A-11): creation is refused, so resolution can only fall through to the Sales Rep
    await expect(commission.createPolicy({ scope: 'customer_group', scopeRefId: randomUUID(), basis: 'gross_sales', rateModel: 'flat', flatRate: '0.99' }, ADMIN_A)).rejects.toThrow(/customer_group.*disabled/i);
    await commission.createPolicy({ scope: 'sales_rep', scopeRefId: rep.employeeId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.03' }, ADMIN_A);

    await publishInvoicePosted(customerId, '1000.00', '1000.00');

    const [result] = await commission.listResults(rep.employeeId);
    expect(result.policyScope).toBe('sales_rep');
    expect(Number(result.rate)).toBeCloseTo(0.03, 4); // never 0.99
  }, 30_000);

  it('6. Immutable snapshot integrity: a later policy change never rewrites an already-calculated CommissionResult (ADR-068 §F)', async () => {
    const rep = await makeSalesRep();
    const customerId = await makeAssignedCustomer(rep.userId);
    await commission.createPolicy({ scope: 'sales_rep', scopeRefId: rep.employeeId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.04' }, ADMIN_A);

    await publishInvoicePosted(customerId, '1000.00', '1000.00');
    const [before] = await commission.listResults(rep.employeeId);
    expect(Number(before.calculatedAmount)).toBeCloseTo(40, 2);

    // Supersede the policy with a very different rate AFTER the result was already calculated.
    await commission.createPolicy({ scope: 'sales_rep', scopeRefId: rep.employeeId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.50' }, ADMIN_A);

    const [after] = await commission.listResults(rep.employeeId);
    expect(after.id).toBe(before.id);
    expect(Number(after.calculatedAmount)).toBeCloseTo(40, 2); // untouched
    expect(Number(after.rate)).toBeCloseTo(0.04, 4); // untouched
  }, 30_000);

  it('7. Approval batch full lifecycle: FA-01 SoD, batch approval, and Payroll\'s own read contract (listApprovedCommissionResults) only ever sees APPROVED results', async () => {
    const rep = await makeSalesRep();
    const customerId = await makeAssignedCustomer(rep.userId);
    await commission.createPolicy({ scope: 'sales_rep', scopeRefId: rep.employeeId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.06' }, ADMIN_A);
    await publishInvoicePosted(customerId, '2000.00', '2000.00');

    // Not yet approved — Payroll's own read contract must see nothing.
    const beforeApproval = await commission.listApprovedCommissionResults(rep.employeeId, today(), today());
    expect(beforeApproval).toHaveLength(0);

    const batch = await commission.submitApprovalBatch(today(), today(), ADMIN_A);
    expect(batch.approvalRequestId).toBeTruthy();

    // Maker cannot decide their own batch (FA-01 SoD).
    await expect(approvals.decide(batch.approvalRequestId!, ADMIN_A, 'approved', null)).rejects.toThrow(/maker/i);

    await approvals.decide(batch.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const afterApproval = await commission.listApprovedCommissionResults(rep.employeeId, today(), today());
    expect(afterApproval).toHaveLength(1);
    expect(Number(afterApproval[0].calculatedAmount)).toBeCloseTo(120, 2); // 2000 * 0.06
  }, 30_000);

  it('8. Correction/immutability: createAdjustment never mutates the original CommissionResult (ADR-068 §H)', async () => {
    const rep = await makeSalesRep();
    const customerId = await makeAssignedCustomer(rep.userId);
    await commission.createPolicy({ scope: 'sales_rep', scopeRefId: rep.employeeId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.05' }, ADMIN_A);
    await publishInvoicePosted(customerId, '800.00', '800.00');

    const [result] = await commission.listResults(rep.employeeId);
    const originalAmount = result.calculatedAmount;

    const adjustment = await commission.createAdjustment({ originalCommissionResultId: result.id, kind: 'correction', reason: 'manual rate override approved out-of-band', amountDelta: '10.00' }, ADMIN_A);
    expect(adjustment.id).toBeTruthy();

    const [resultAfter] = await commission.listResults(rep.employeeId);
    expect(resultAfter.calculatedAmount).toBe(originalAmount); // untouched — the adjustment is a separate record
  }, 30_000);

  it('9. Target non-overlap (ADR-068 §D): two APPROVED targets for the same employee with overlapping periods are rejected at the DB level', async () => {
    const rep = await makeSalesRep();
    const t1 = await targets.create({ employeeId: rep.employeeId, periodStart: '2028-01-01', periodEnd: '2028-01-31', targetValue: '5000.00' }, ADMIN_A);
    const submitted1 = await targets.submitForApproval(t1.id, ADMIN_A);
    await approvals.decide(submitted1.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const t2 = await targets.create({ employeeId: rep.employeeId, periodStart: '2028-01-15', periodEnd: '2028-02-15', targetValue: '6000.00' }, ADMIN_A);
    const submitted2 = await targets.submitForApproval(t2.id, ADMIN_A);
    // FA-01's own decide() resolves normally — the DB exclusion-constraint violation happens
    // inside TargetService.onApprovalApproved, invoked asynchronously from the outbox dispatch
    // pass (EventBusService.dispatchPending() swallows a handler's error per-event, same as every
    // other subscriber in this codebase; it never propagates back to decide()'s own caller).
    await approvals.decide(submitted2.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const t2After = (await targets.listTargets(rep.employeeId)).find((t) => t.id === t2.id)!;
    expect(t2After.status).not.toBe('approved'); // the exclusion constraint blocked it, never silently double-approved
  }, 30_000);

  it('10. UTC day-boundary correctness (independent re-verification finding, 2026-09-21): a CommissionResult calculated in the final hours of the UTC calendar day is still included in that same UTC day\'s own batch, regardless of the DB session\'s configured timezone', async () => {
    const rep = await makeSalesRep();
    const customerId = await makeAssignedCustomer(rep.userId);
    const policy = await commission.createPolicy({ scope: 'sales_rep', scopeRefId: rep.employeeId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.07' }, ADMIN_A);

    // The exact previously-broken window: the DB session's configured timezone
    // (confirmed Africa/Cairo, UTC+3, by the independent re-verification) casts a naive
    // 'YYYY-MM-DD 23:59:59' upper bound to 20:59:59 UTC — 3 hours short of the real UTC day end.
    // A calculationTimestamp of 22:30 UTC today falls squarely inside that previously-excluded gap.
    const todayUtc = today();
    const lateUtcTimestamp = `${todayUtc}T22:30:00.000Z`;
    const triggerEventKey = `invoice:${randomUUID()}`;
    await dataSource.query(
      `INSERT INTO commission_results
         (id, "employeeId", "customerId", "sourceTransactionRefs", "resolvedPolicyId", "policyScope", "calculationBasis", "rate", "calculationInputs", "calculatedAmount", "calculationTimestamp", "triggerEventKey")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [rep.employeeId, customerId, JSON.stringify({ invoice: triggerEventKey }), policy.id, 'sales_rep', 'gross_sales', '0.07', JSON.stringify({}), '70.00', lateUtcTimestamp, triggerEventKey],
    );

    const batch = await commission.submitApprovalBatch(todayUtc, todayUtc, ADMIN_A);
    const batchedIds = (await dataSource.query(`SELECT id FROM commission_results WHERE "batchId" = $1`, [batch.id])).map((r: { id: string }) => r.id);
    const [lateResult] = await dataSource.query(`SELECT id FROM commission_results WHERE "triggerEventKey" = $1`, [triggerEventKey]);
    expect(batchedIds).toContain(lateResult.id); // previously wrongly excluded — now correctly swept in

    await approvals.decide(batch.approvalRequestId!, SECOND_APPROVER, 'approved', null);
    const approved = await commission.listApprovedCommissionResults(rep.employeeId, todayUtc, todayUtc);
    expect(approved.some((r) => r.id === lateResult.id)).toBe(true); // Payroll's own read contract also sees it correctly
  }, 30_000);
});
