import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { buildPayrollFixture, PayrollFixture } from '../../../foundation/testing/payroll-company-fixture';

/**
 * Commission -> Payroll consumption (CTO mandate 2026-10-25; ADR-071 Addendum A-1/A-2/A-3/A-11) — real Postgres, real services, the real event path
 * (`finance.invoice.posted` / `collection.remitted` -> Commission -> FA-01 batch approval -> Payroll run -> consumption).
 *
 *  R-COM-01 attribution is the source event's business date   R-COM-02 exactly-once consumption (DB-enforced, concurrent runs)
 *  R-COM-03 late approval goes to the first open run, flagged carried-forward, posted history untouched   R-COM-04 adjustments are consumed once
 *  R-COM-05 net_sales / customer_group are disabled   R-ACC-01 the accrual recognises commission exactly once
 */
describe('Commission attribution and exactly-once consumption by Payroll (real PG)', () => {
  jest.setTimeout(580_000);
  let f: PayrollFixture;
  let repEmployee = '';
  let customerId = '';
  const year = new Date().toISOString().slice(0, 4);
  const u = () => f.users.A;
  const consumption = async (where: string, params: unknown[] = []) => (await (await f.mgr('A')).query(`SELECT * FROM payroll_input_consumptions WHERE ${where}`, params)) as Array<Record<string, unknown>>;

  beforeAll(async () => {
    f = await buildPayrollFixture('payroll_com');
    const mA = await f.mgr('A');
    const dsA = await f.dsOf('A');
    const role = (await dsA.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,'commission.batch.approve','editable') ON CONFLICT DO NOTHING`, [role.id]);

    // the sales rep: an Employee linked to a platform user that is an active member of Company A, who owns a customer
    const repUser = await f.h.createUserWithAdminRoleIn('Commission Rep', f.h.companyAId);
    await dsA.query(`INSERT INTO users (id, "fullName", email) VALUES ($1, 'Commission Rep', $2) ON CONFLICT DO NOTHING`, [repUser.id, repUser.email]);
    repEmployee = await f.employee('A', 'Rep One', '1000.00');
    await f.hr.linkUser(repEmployee, repUser.id, u().prep, mA, f.h.companyAId);
    customerId = randomUUID();
    await dsA.query(`INSERT INTO customers (id, code, name, "creditLimit") VALUES ($1, 'COM-CUST', 'Commission Customer', '1000000.00')`, [customerId]);
    await dsA.query(`INSERT INTO customer_assignments ("customerId", "salesRepUserId") VALUES ($1, $2)`, [customerId, repUser.id]);
    await f.commission.createPolicy({ scope: 'customer', scopeRefId: customerId, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.10' }, u().prep, mA);
  });

  afterAll(async () => {
    await f.teardown();
  });

  /** An invoice of `net` posted on the business date `businessDate`; returns the CommissionResult it produced. */
  async function invoice(net: string, businessDate: string) {
    const ds = await f.dsOf('A');
    const invoiceId = randomUUID();
    await ds.transaction(async (m) => {
      await f.events.publish(m, 'finance.invoice.posted', { invoiceId, customerId, netAmount: net, grossAmount: net, taxAmount: '0.00', businessDate, idempotencyKey: `test:invoice:${invoiceId}` });
    });
    await f.drain('A');
    const rows = await ds.query(`SELECT id, "calculatedAmount", "calculationInputs" FROM commission_results WHERE "triggerEventKey" = $1`, [`invoice:${invoiceId}`]);
    expect(rows).toHaveLength(1);
    return rows[0] as { id: string; calculatedAmount: string; calculationInputs: Record<string, unknown> };
  }

  /** Batch every un-batched result of the year and approve it (maker `sub`, approver `appr`). */
  async function approveBatch(): Promise<void> {
    const mA = await f.mgr('A');
    const batch = await f.commission.submitApprovalBatch(`${year}-01-01`, `${year}-12-31`, u().sub, mA);
    await f.commission.decide(batch.approvalRequestId!, u().appr, 'approved', null, mA);
    await f.drain('A');
  }

  it('R-COM-01 — the attribution date is the source event\'s BUSINESS date (invoice event), stored inside the snapshot; processing time is not the attribution', async () => {
    const r = await invoice('1000.00', '2026-09-15');
    expect(r.calculatedAmount).toBe('100.00');
    expect(r.calculationInputs).toMatchObject({ attributionDate: '2026-09-15', attributionRule: 'event-business-date-v1' });
    // (the collection path -- `collection.remitted` -> shipment -> sales order -> customer -- uses the same pure date helper on its ISO-timestamp `businessDate`; it needs the
    //  delivery chain and is exercised in the integrated scenario, not here)
  });

  it('R-COM-05 — net_sales and customer_group policies are disabled (creation refused); a legacy row of a disabled kind produces no money and is audited', async () => {
    const mA = await f.mgr('A');
    await expect(f.commission.createPolicy({ scope: 'sales_rep', scopeRefId: repEmployee, basis: 'net_sales', rateModel: 'flat', flatRate: '0.05' }, u().prep, mA)).rejects.toThrow(/net_sales.*disabled/i);
    await expect(f.commission.createPolicy({ scope: 'customer_group', scopeRefId: randomUUID(), basis: 'gross_sales', rateModel: 'flat', flatRate: '0.05' }, u().prep, mA)).rejects.toThrow(/customer_group.*disabled/i);
    // a legacy customer-scope policy with the disabled basis, inserted behind the service
    const otherCustomer = randomUUID();
    const ds = await f.dsOf('A');
    await ds.query(`INSERT INTO customers (id, code, name, "creditLimit") VALUES ($1, 'COM-LEGACY', 'Legacy', '1000.00')`, [otherCustomer]);
    const repUserId = (await ds.query(`SELECT "salesRepUserId" AS id FROM customer_assignments LIMIT 1`))[0].id;
    await ds.query(`INSERT INTO customer_assignments ("customerId", "salesRepUserId") VALUES ($1, $2)`, [otherCustomer, repUserId]);
    await ds.query(
      `INSERT INTO commission_policies (scope, "scopeRefId", basis, "rateModel", "flatRate", "effectiveFrom", status, "createdByUserId") VALUES ('customer', $1, 'net_sales', 'flat', 0.5, now() - interval '1 hour', 'active', $2)`,
      [otherCustomer, u().prep],
    );
    const invoiceId = randomUUID();
    await ds.transaction(async (m) => {
      await f.events.publish(m, 'finance.invoice.posted', { invoiceId, customerId: otherCustomer, netAmount: '500.00', grossAmount: '500.00', businessDate: '2026-09-16', idempotencyKey: `test:inv:${invoiceId}` });
    });
    await f.drain('A');
    expect(await ds.query(`SELECT 1 FROM commission_results WHERE "triggerEventKey" = $1`, [`invoice:${invoiceId}`])).toHaveLength(0);
    expect((await ds.query(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'commission.result.skipped_disabled_policy'`))[0].n).toBeGreaterThanOrEqual(1);
  });

  it('R-COM-02 / R-ACC-01 — an approved result is consumed by exactly one posted run: reserved on calculation, consumed on posting, never offered again; the accrual recognises it once', async () => {
    const mA = await f.mgr('A');
    await approveBatch(); // the 2026-09-15 result of the first test
    const sept = await f.period('A', '2026-09', '2026-09-01', '2026-09-30');
    const run = await f.payroll.calculate(sept, u().prep, mA);
    const line = (await f.payroll.getRun(run.id, mA)).lines.find((l) => l.employeeId === repEmployee)!;
    expect(line).toMatchObject({ grossPay: '1000.00', commissionAmount: '100.00', adjustmentsAmount: '0.00', netPay: '1100.00' });
    expect(await consumption(`"payrollRunId" = $1`, [run.id])).toHaveLength(1);
    expect((await consumption(`"payrollRunId" = $1`, [run.id]))[0]).toMatchObject({ inputKind: 'commission_result', state: 'reserved', carriedForward: false, payrollRunLineId: line.id });

    // recalculating in place releases and re-reserves: still exactly one LIVE hold
    await f.payroll.calculate(sept, u().prep, mA);
    expect(await consumption(`"payrollRunId" = $1 AND state IN ('reserved','consumed')`, [run.id])).toHaveLength(1);
    expect(await consumption(`"payrollRunId" = $1 AND state = 'released'`, [run.id])).toHaveLength(1);

    await f.acknowledgeAll('A', run.id);
    await f.payroll.review(run.id, u().rev, mA);
    const sub = await f.payroll.submitForApproval(run.id, u().sub, mA);
    await f.payroll.decide(sub.approvalRequestId!, u().appr, 'approved', null, mA);
    await f.drain('A');
    expect((await f.payroll.getRun(run.id, mA)).run.status).toBe('posted');
    expect((await consumption(`"payrollRunId" = $1 AND state = 'consumed'`, [run.id]))).toHaveLength(1);

    // accrual: expense = gross + commission, payable = net, commission recognised once (not twice, not zero)
    const header = (await f.payroll.getRun(run.id, mA)).run;
    const fe = await f.payroll.getFinancialEventStatus(run.id, mA);
    expect(fe?.status.toUpperCase()).toBe('POSTED');
    const ledger = await f.ledger('A');
    expect(Number(ledger.expense)).toBeCloseTo(Number(header.totalGross) + Number(header.totalCommission), 2);
    expect(Number(ledger.payable)).toBeCloseTo(-Number(header.totalNet), 2);
    expect(header.totalCommission).toBe('100.00');

    // never offered again: the next period does not include the consumed result
    const oct = await f.period('A', '2026-10', '2026-10-01', '2026-10-31');
    const octRun = await f.payroll.calculate(oct, u().prep, mA);
    const octLine = (await f.payroll.getRun(octRun.id, mA)).lines.find((l) => l.employeeId === repEmployee)!;
    expect(octLine.commissionAmount).toBeNull();
    expect(octLine.netPay).toBe('1000.00');
  });

  it('R-COM-03 — a result approved AFTER its period was posted goes to the first open run (carried forward, flagged); the posted run and its line are untouched', async () => {
    const mA = await f.mgr('A');
    const late = await invoice('2000.00', '2026-09-20'); // attributed to September, processed and approved in October
    await approveBatch();
    const octRun = (await f.payroll.listRuns(mA)).find((r) => r.status === 'calculated')!; // October is calculated, not posted
    const recalculated = await f.payroll.calculate(octRun.payrollPeriodId, u().prep, mA);
    const line = (await f.payroll.getRun(recalculated.id, mA)).lines.find((l) => l.employeeId === repEmployee)!;
    expect(line.commissionAmount).toBe('200.00');
    const hold = (await consumption(`"sourceId" = $1`, [late.id]))[0];
    expect(hold).toMatchObject({ state: 'reserved', carriedForward: true, payrollRunId: recalculated.id });
    const info = (await f.payroll.listExceptions(recalculated.id, mA)).find((e) => e.code === 'COMMISSION_CARRIED_FORWARD' && e.employeeId === repEmployee);
    expect(info).toMatchObject({ impactClass: 'INFO' });
    // September's posted line did not change
    const septRun = (await f.payroll.listRuns(mA)).find((r) => r.status === 'posted' && r.kind === 'regular')!;
    expect((await f.payroll.getRun(septRun.id, mA)).lines.find((l) => l.employeeId === repEmployee)!.commissionAmount).toBe('100.00');
  });

  it('R-COM-02 — two runs calculated CONCURRENTLY cannot both take the same approved result (database-enforced); the sum paid across both is the amount once', async () => {
    const mA = await f.mgr('A');
    const r = await invoice('3000.00', '2026-08-01'); // 300.00, attributed before both periods
    await approveBatch();
    const nov = await f.period('A', '2026-11', '2026-11-01', '2026-11-30');
    const dec = await f.period('A', '2026-12', '2026-12-01', '2026-12-31');
    const [a, b] = await Promise.all([f.payroll.calculate(nov, u().prep, mA), f.payroll.calculate(dec, u().extra, mA)]);
    const total = async (runId: string) => Number((await f.payroll.getRun(runId, mA)).lines.find((l) => l.employeeId === repEmployee)?.commissionAmount ?? 0);
    expect((await total(a.id)) + (await total(b.id))).toBe(300);
    const live = await consumption(`"sourceId" = $1 AND state IN ('reserved','consumed')`, [r.id]);
    expect(live).toHaveLength(1);
    // the database itself refuses a second live hold, even behind the service
    await expect(
      mA.query(`INSERT INTO payroll_input_consumptions ("inputKind","sourceId","payrollRunId","employeeId",amount,state) VALUES ('commission_result', $1, $2, $3, 300, 'reserved')`, [r.id, a.id, repEmployee]),
    ).rejects.toThrow(/UQ_payroll_input_consumptions_live_source|duplicate key/);
  });

  it('R-COM-04 — adjustments (payroll and commission) are immutable inputs consumed exactly once by the next open run; the posted run is untouched; invalid adjustments are refused', async () => {
    const mA = await f.mgr('A');
    const septRun = (await f.payroll.listRuns(mA)).find((r) => r.status === 'posted' && r.kind === 'regular')!;
    const septLine = (await f.payroll.getRun(septRun.id, mA)).lines.find((l) => l.employeeId === repEmployee)!;
    const openLine = (await f.payroll.getRun((await f.payroll.listRuns(mA)).find((r) => r.status === 'calculated')!.id, mA)).lines[0];

    await expect(f.payroll.createAdjustment({ originalPayrollRunLineId: openLine.id, kind: 'adjustment', reason: 'x', amountDelta: '5.00' }, u().prep, mA)).rejects.toThrow(/POSTED run/i); // only posted history is corrected this way
    await expect(f.payroll.createAdjustment({ originalPayrollRunLineId: septLine.id, kind: 'adjustment', reason: 'x', amountDelta: 'abc' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.payroll.createAdjustment({ originalPayrollRunLineId: septLine.id, kind: 'adjustment', reason: 'x', amountDelta: '0' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.payroll.createAdjustment({ originalPayrollRunLineId: septLine.id, kind: 'adjustment', reason: 'x', amountDelta: '1.234' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);

    const padj = await f.payroll.createAdjustment({ originalPayrollRunLineId: septLine.id, kind: 'adjustment', reason: 'missed deduction', amountDelta: '-25.00' }, u().prep, mA);
    const resultId = (await mA.query(`SELECT id FROM commission_results ORDER BY "calculationTimestamp" ASC LIMIT 1`))[0].id as string; // the approved September result
    const cadj = await f.commission.createAdjustment({ originalCommissionResultId: resultId, kind: 'correction', reason: 'rate correction', amountDelta: '10.00' }, u().prep, mA);
    await expect(f.commission.createAdjustment({ originalCommissionResultId: resultId, kind: 'correction', reason: 'bad', amountDelta: 'ten' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);

    const openRunId = (await f.payroll.listRuns(mA)).find((r) => r.status === 'calculated')!.id;
    const run = await f.payroll.calculate((await f.payroll.getRun(openRunId, mA)).run.payrollPeriodId, u().prep, mA);
    const line = (await f.payroll.getRun(run.id, mA)).lines.find((l) => l.employeeId === repEmployee)!;
    expect(line.adjustmentsAmount).toBe('-15.00'); // -25.00 + 10.00
    const holds = await consumption(`"payrollRunId" = $1 AND "inputKind" IN ('payroll_adjustment','commission_adjustment')`, [run.id]);
    expect(holds.map((h) => [h.inputKind, h.sourceId, h.state]).sort()).toEqual([['commission_adjustment', cadj.id, 'reserved'], ['payroll_adjustment', padj.id, 'reserved']].sort());
    // September's posted line did not move
    expect((await f.payroll.getRun(septRun.id, mA)).lines.find((l) => l.employeeId === repEmployee)!.netPay).toBe('1100.00');
    // net = gross + commission + adjustments
    expect(Number(line.netPay)).toBeCloseTo(Number(line.grossPay) + Number(line.commissionAmount ?? 0) + Number(line.adjustmentsAmount), 2);
  });
});
