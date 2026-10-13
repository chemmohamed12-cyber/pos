import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { PayrollService } from './payroll.service';
import { HrService } from '../../hr/application/hr.service';
import { CommissionService } from '../../commission/application/commission.service';
import { CustomersService } from '../../crm/application/customers.service';
import { UsersService } from '../../../foundation/identity/users.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

/**
 * WP-PAY-01 — RUNTIME CHARACTERIZATION of PA-34 / PA-35 / PA-36 (TEST-ONLY; Phase 0 evidence for contract H0-4; no product code changed).
 *
 * Purpose: PA-34 (disbursement posts no GL leg), PA-35 (commission is paid but never recognised) and PA-36 (floating-point money arithmetic)
 * are, so far, findings by CODE READING. This spec measures what the code ACTUALLY does on a disposable, seeded database and PINS today's
 * behaviour: if the code-reading prediction were wrong, an assertion here fails and that failure is new evidence — it is never "fixed" from here.
 * It decides no accounting policy: the expected values below are what the CURRENT code does, not what the policy should be (that is the
 * accounting owner's decision, H0-4 / DEC-03 / DEC-04).
 *
 * Same fixtures as `integrated-attendance-payroll-commission-gl-e2e.spec.ts` (boots AppModule against the seeded ambient test database;
 * run serially). Measurements are printed as one JSON line prefixed `WP-PAY-01 MEASURED` so the run log is the evidence.
 */
describe('WP-PAY-01 — runtime characterization of the payroll -> GL path (PA-34, PA-35, PA-36)', () => {
  let moduleRef: TestingModule;
  let payroll: PayrollService;
  let hr: HrService;
  let commission: CommissionService;
  let customers: CustomersService;
  let users: UsersService;
  let approvals: ApprovalEngineService;
  let treasury: TreasuryService;
  let events: EventBusService;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const SECOND_APPROVER = 'f539302e-9ae7-4cc2-99cf-381f08acab83';
  const shortName = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000)}`;
  const isoDate = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (n: number) => isoDate(new Date(Date.now() + n * 86_400_000));
  const measured = (name: string, data: unknown) => console.log(`WP-PAY-01 MEASURED ${JSON.stringify({ name, ...((data as object) ?? {}) })}`);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    payroll = moduleRef.get(PayrollService);
    hr = moduleRef.get(HrService);
    commission = moduleRef.get(CommissionService);
    customers = moduleRef.get(CustomersService);
    users = moduleRef.get(UsersService);
    approvals = moduleRef.get(ApprovalEngineService);
    treasury = moduleRef.get(TreasuryService);
    events = moduleRef.get(EventBusService);
    dataSource = moduleRef.get(DataSource);
  }, 90_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  async function makePeriod(): Promise<string> {
    const period = await payroll.createPeriod({ code: shortName('PAY01'), startDate: addDays(-3), endDate: addDays(5) }, ADMIN_A);
    return period.id;
  }

  async function makeFundedAccount(amount: string): Promise<string> {
    const suffix = shortName('');
    const type = await treasury.createAccountType(`P01TYPE-${suffix}`, `PAY01 Type ${suffix}`, ADMIN_A);
    const account = await treasury.createAccount(`P01ACC-${suffix}`, `PAY01 Account ${suffix}`, type.id, ADMIN_A);
    await treasury.cashIn(account.id, amount, null, null, 'PAY01 funding', 'pay01 fixture', ADMIN_A);
    return account.id;
  }

  async function makeEmployee(basic: string): Promise<{ employeeId: string; userId: string }> {
    const suffix = shortName('');
    const user = await users.create({ fullName: `PAY01 Rep ${suffix}`, email: `pay01.${suffix}@test.daii.local` });
    const emp = await hr.createEmployee({ fullName: shortName('PAY01Emp'), employmentType: 'full_time' }, ADMIN_A);
    await hr.linkUser(emp.id, user.id, ADMIN_A);
    await payroll.createCompensation({ employeeId: emp.id, earnings: [{ componentCode: 'basic', amount: basic }] }, ADMIN_A);
    return { employeeId: emp.id, userId: user.id };
  }

  async function approveRun(runId: string): Promise<void> {
    await payroll.review(runId, ADMIN_A);
    const submitted = await payroll.submitForApproval(runId, ADMIN_A);
    await approvals.decide(submitted.approvalRequestId!, SECOND_APPROVER, 'approved', null);
  }

  const eventCount = async (where: string, params: unknown[] = []): Promise<number> =>
    Number((await dataSource.query(`SELECT COUNT(*)::int AS n FROM accounting_financial_events WHERE ${where}`, params))[0].n);

  it('TEMPLATE COMPLETENESS (M0-6): payroll posting in a Company whose chart has no active wages_payable control account — what happens to the run and to its Financial Event', async () => {
    const wpBefore = Number((await dataSource.query(`SELECT COUNT(*)::int AS n FROM accounting_gl_accounts WHERE "controlFunction" = 'wages_payable' AND "isActive" = true`))[0].n);
    await makeEmployee('1000.00');
    const periodId = await makePeriod();
    const run = await payroll.calculate(periodId, ADMIN_A);
    await approveRun(run.id);
    await events.dispatchPending();
    const { run: after } = await payroll.getRun(run.id);
    const fe: Array<{ status: string; rejectionReason: string | null }> = await dataSource.query(
      `SELECT status, "rejectionReason" FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [run.id],
    );
    measured('M0-6 wages_payable', { activeWagesPayableAccountsBefore: wpBefore, payrollRunStatus: after.status, financialEvents: fe });
    if (wpBefore > 0) {
      // Since the 2026-10-13 template fix (`2150 Wages Payable` in ifrs-sme; see WAGES-PAYABLE-CONTROL-ACCOUNT-TEMPLATE-2026-10-13.md) a freshly provisioned Company has the control account and the event POSTS.
      expect(fe).toHaveLength(1);
      expect(fe[0].status.toUpperCase()).toBe('POSTED');
    }
    if (wpBefore === 0) {
      // Pinned (observed on 3bf740b, before the template fix, on a freshly provisioned Company): the run reaches 'posted' while its Financial Event is REJECTED for lack of the control account.
      expect(fe).toHaveLength(1);
      expect(fe[0].status.toUpperCase()).toBe('REJECTED');
      expect(fe[0].rejectionReason ?? '').toMatch(/wages_payable/i);
      // Test fixture only (the same hand-seeding the earlier fixtures did for grni/wip): give the Company the account so the next test can measure the posting path.
      await dataSource.query(
        `INSERT INTO accounting_gl_accounts ("code","name","nameAr","accountType","normalBalance","isContra","parentAccountId","isPostable","controlFunction","currencyMode","allowManualJournal","isActive")
         VALUES ('2150','Wages Payable','wages payable','liability','credit',false,NULL,true,'wages_payable','functional_only',false,true)`,
      );
    }
  }, 120_000);

  it('PA-35 + PA-34: a run with salary 4000.00 and approved commission 200.00 — what the ledger receives at posting, and what it receives at disbursement', async () => {
    // fixture: employee with basic 4000.00, a customer assigned to the linked user, a 10% customer-scope commission on a 2000.00 invoice
    const rep = await makeEmployee('4000.00');
    const customer = await customers.createCustomer({ name: shortName('PAY01Cust') }, ADMIN_A);
    await customers.assignSalesRep(customer.id, rep.userId, 'primary', ADMIN_A);
    await commission.createPolicy({ scope: 'customer', scopeRefId: customer.id, basis: 'gross_sales', rateModel: 'flat', flatRate: '0.10' }, ADMIN_A);
    await dataSource.transaction(async (manager) => {
      await events.publish(manager, 'finance.invoice.posted', { invoiceId: randomUUID(), invoiceNumber: shortName('PAY01INV'), customerId: customer.id, salesOrderId: null, netAmount: '2000.00', taxAmount: '0.00', grossAmount: '2000.00' });
    });
    await events.dispatchPending();
    const start = addDays(-3);
    const end = addDays(5);
    const batch = await commission.submitApprovalBatch(start, end, ADMIN_A);
    await approvals.decide(batch.approvalRequestId!, SECOND_APPROVER, 'approved', null);

    const periodId = await makePeriod();
    const run = await payroll.calculate(periodId, ADMIN_A);
    const { lines } = await payroll.getRun(run.id);
    const line = lines.find((l) => l.employeeId === rep.employeeId)!;
    const sumGross = lines.reduce((s, l) => s + Number(l.grossPay), 0);
    const sumNet = lines.reduce((s, l) => s + Number(l.netPay), 0);
    const sumCommission = lines.reduce((s, l) => s + Number(l.commissionAmount ?? 0), 0);

    await approveRun(run.id);
    await events.dispatchPending();

    const fe: Array<{ id: string; status: string; journalEntryId: string | null }> = await dataSource.query(
      `SELECT id, status, "journalEntryId" FROM accounting_financial_events WHERE "sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`,
      [run.id],
    );
    expect(fe).toHaveLength(1);
    const jl: Array<{ debit: string; credit: string; controlFunction: string | null; code: string }> = await dataSource.query(
      `SELECT jl."debitBase" AS debit, jl."creditBase" AS credit, a."controlFunction", a.code FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId" WHERE jl."journalEntryId" = $1`,
      [fe[0].journalEntryId],
    );
    const journalDebit = jl.reduce((s, l) => s + Number(l.debit || 0), 0);
    const journalCredit = jl.reduce((s, l) => s + Number(l.credit || 0), 0);

    // --- disbursement ---
    const account = await makeFundedAccount('100000000.00');
    const idsBefore = new Set<string>((await dataSource.query(`SELECT id::text AS id FROM accounting_financial_events`)).map((r: { id: string }) => r.id));
    const feBefore = idsBefore.size;
    const cashBefore = Number((await dataSource.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('cash_in','transfer_in') THEN amount ELSE -amount END),0)::numeric AS b FROM treasury_transactions WHERE "treasuryAccountId" = $1`, [account]))[0].b);
    const feForRunBefore = await eventCount(`"sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`, [run.id]);
    const disbursed = await payroll.disburse(run.id, account, ADMIN_A);
    await events.dispatchPending();
    const feAfter = await eventCount('1=1');
    const feForRunAfter = await eventCount(`"sourceEntityType" = 'PayrollRun' AND "sourceEntityId"::text = $1`, [run.id]);
    const cashAfter = Number((await dataSource.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('cash_in','transfer_in') THEN amount ELSE -amount END),0)::numeric AS b FROM treasury_transactions WHERE "treasuryAccountId" = $1`, [account]))[0].b);
    const newFinancialEvents: Array<{ sourceDomain: string; eventType: string; status: string }> = (
      await dataSource.query(`SELECT id::text AS id, "sourceDomain", "eventType", status FROM accounting_financial_events`)
    ).filter((r: { id: string }) => !idsBefore.has(r.id));

    measured('PA-35/PA-34', {
      lineGross: Number(line.grossPay), lineCommission: Number(line.commissionAmount ?? 0), lineNet: Number(line.netPay),
      runSumGross: sumGross, runSumCommission: sumCommission, runSumNet: sumNet,
      postedJournalDebit: journalDebit, postedJournalCredit: journalCredit, postedJournalLines: jl.map((l) => ({ code: l.code, fn: l.controlFunction, debit: l.debit, credit: l.credit })),
      cashPaidOut: cashBefore - cashAfter, disbursedAt: !!disbursed.disbursedAt,
      financialEventsCreatedByDisburse: feAfter - feBefore, payrollRunEventsBefore: feForRunBefore, payrollRunEventsAfter: feForRunAfter, eventsCreatedByDisburse: newFinancialEvents,
    });

    // Pinned to what the code-reading predicted (PA-35): the posted journal carries the GROSS pay only; commission is not in it.
    expect(Math.abs(journalDebit - journalCredit)).toBeLessThan(0.0001);
    expect(journalDebit).toBeCloseTo(sumGross, 2);
    expect(journalDebit).not.toBeCloseTo(sumNet, 2); // the journal does not equal what is paid (net includes commission)
    expect(sumCommission).toBeGreaterThan(0);
    // Pinned (PA-34): money leaves the treasury account but disbursement creates NO financial event / journal for the run.
    expect(cashBefore - cashAfter).toBeCloseTo(sumNet, 2);
    expect(feAfter - feBefore).toBe(0);
    expect(feForRunAfter).toBe(feForRunBefore);
  }, 120_000);

  it('PA-36: cent-valued salaries — does the floating-point accumulation in the run total drift from the exact decimal sum of its lines?', async () => {
    const amounts = ['1000.07', '2000.13', '333.33', '1234.57', '999.99', '4321.09', '0.10', '0.20', '5555.55', '7777.77', '1.01', '2.02'];
    const staff: string[] = [];
    for (const a of amounts) staff.push((await makeEmployee(a)).employeeId);
    const periodId = await makePeriod();
    const run = await payroll.calculate(periodId, ADMIN_A);
    const { run: header, lines } = await payroll.getRun(run.id);
    const mine = lines.filter((l) => staff.includes(l.employeeId));
    // exact decimal sum of the stored line values, in integer cents
    const cents = (v: string | number) => Math.round(Number(v) * 100);
    const exactGrossCents = mine.reduce((s, l) => s + cents(l.grossPay), 0);
    const floatGross = mine.reduce((s, l) => s + Number(l.grossPay), 0);
    measured('PA-36', { lines: mine.length, exactGrossCents, floatGross, floatMinusExact: floatGross - exactGrossCents / 100, runTotalGross: (header as unknown as { totalGross?: string }).totalGross ?? null });
    expect(mine).toHaveLength(amounts.length);
    // line values themselves are stored to 2 decimals: each equals its fixture (no per-line rounding loss at this scale)
    expect(mine.map((l) => cents(l.grossPay)).sort((a, b) => a - b)).toEqual(amounts.map(cents).sort((a, b) => a - b));
  }, 180_000);
});
