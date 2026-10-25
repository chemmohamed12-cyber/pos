import Decimal from 'decimal.js';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { buildPayrollFixture, PayrollFixture } from '../../../foundation/testing/payroll-company-fixture';

/**
 * Payroll gap closure (CTO mandate 2026-10-25) — real-Postgres proof, two disposable Company databases, real HR / Attendance / Commission / Payroll / Approval /
 * Process / Numbering / Audit engines and the real company-scope approval subscribers. Never mocked.
 *
 *  R-PAY-02 effective-dated compensation   R-PAY-03 exact decimal money   R-PAY-01/07 periods (overlap, close)   R-PAY-04 exceptions (classes, fingerprint, carry-over)
 *  R-PAY-05 separation of duties from recorded actors (standard + strict, direct service calls AND the generic approvals route)   R-PAY-06 rejection path
 *  R-PAY-08 revisions / supplementary run   R-SEC-01 Company isolation of every new table
 */
describe('Payroll gap closure — compensation, decimals, periods, exceptions, SoD, rejection, revisions (real PG, A/B)', () => {
  jest.setTimeout(580_000);
  let f: PayrollFixture;
  const u = () => f.users.A;

  beforeAll(async () => {
    f = await buildPayrollFixture('payroll_gap');
  });

  afterAll(async () => {
    await f.teardown();
  });

  const lineOf = async (runId: string, employeeId: string) => {
    const { lines } = await f.payroll.getRun(runId, await f.mgr('A'));
    return lines.find((l) => l.employeeId === employeeId);
  };
  const exceptionsOf = async (runId: string, code?: string) => (await f.payroll.listExceptions(runId, await f.mgr('A'))).filter((e) => !code || e.code === code);

  // -------------------------------------------------------------------------------------------------------------------------------------------------
  it('R-PAY-02 — the compensation EFFECTIVE for the period is used; a change needs a later date and a reason; history is never rewritten; a change inside the period is an exception', async () => {
    const mA = await f.mgr('A');
    const emp = await f.employee('A', 'Eff One', '1000.00');
    await f.payroll.createCompensation({ employeeId: emp, earnings: [{ componentCode: 'basic', amount: '1500.00' }], effectiveFrom: '2026-04-01', reason: 'annual raise' }, u().prep, mA);

    // refusals
    await expect(f.payroll.createCompensation({ employeeId: emp, earnings: [{ componentCode: 'basic', amount: '1600.00' }], effectiveFrom: '2026-04-01', reason: 'same day' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.payroll.createCompensation({ employeeId: emp, earnings: [{ componentCode: 'basic', amount: '1600.00' }], effectiveFrom: '2026-02-01', reason: 'backdated before current start' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.payroll.createCompensation({ employeeId: emp, earnings: [{ componentCode: 'basic', amount: '1600.00' }], effectiveFrom: '2026-06-01', reason: '' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.payroll.createCompensation({ employeeId: emp, earnings: [{ componentCode: 'basic', amount: 'abc' }], effectiveFrom: '2026-06-01', reason: 'bad amount' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.payroll.createCompensation({ employeeId: emp, earnings: [{ componentCode: 'basic', amount: '10.123' }], effectiveFrom: '2026-06-01', reason: 'three decimals' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.payroll.createCompensation({ employeeId: emp, earnings: [{ componentCode: 'basic', amount: '10' }, { componentCode: 'basic', amount: '20' }], effectiveFrom: '2026-06-01', reason: 'dup component' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);

    const feb = await f.period('A', '2026-02', '2026-02-01', '2026-02-28');
    const apr = await f.period('A', '2026-04', '2026-04-01', '2026-04-30');
    const febRun = await f.payroll.calculate(feb, u().prep, mA);
    const aprRun = await f.payroll.calculate(apr, u().prep, mA);
    expect((await lineOf(febRun.id, emp))!.grossPay).toBe('1000.00'); // the rate in force in February
    expect((await lineOf(aprRun.id, emp))!.grossPay).toBe('1500.00'); // the new rate from its first day
    expect(await exceptionsOf(aprRun.id, 'COMPENSATION_CHANGE_IN_PERIOD')).toHaveLength(0); // a change on the first day is not "inside" the period

    // a third rate that starts mid-May: the May run uses the rate in force on its LAST day and flags the change (no proration rule exists)
    await f.payroll.createCompensation({ employeeId: emp, earnings: [{ componentCode: 'basic', amount: '2000.00' }], effectiveFrom: '2026-05-15', reason: 'promotion' }, u().prep, mA);
    const may = await f.period('A', '2026-05', '2026-05-01', '2026-05-31');
    const mayRun = await f.payroll.calculate(may, u().prep, mA);
    expect((await lineOf(mayRun.id, emp))!.grossPay).toBe('2000.00');
    const change = await exceptionsOf(mayRun.id, 'COMPENSATION_CHANGE_IN_PERIOD');
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({ impactClass: 'A_DOC', status: 'open', employeeId: emp });

    // recalculating February after the later raises still gives February's rate (history is by effective date, not by "latest")
    const febAgain = await f.payroll.calculate(feb, u().prep, mA);
    expect(febAgain.id).toBe(febRun.id);
    expect((await lineOf(febAgain.id, emp))!.grossPay).toBe('1000.00');
    // the closed interval of the superseded row
    const rows = await mA.query(`SELECT "effectiveFrom"::date::text AS f, "effectiveTo"::date::text AS t, status, reason FROM payroll_compensations WHERE "employeeId" = $1 ORDER BY "effectiveFrom"`, [emp]);
    expect(rows.map((r: { f: string; t: string | null; status: string }) => [r.f, r.t, r.status])).toEqual([
      ['2026-01-01', '2026-04-01', 'superseded'],
      ['2026-04-01', '2026-05-15', 'superseded'],
      ['2026-05-15', null, 'active'],
    ]);
  });

  it('R-PAY-03 — money is exact: cent-valued salaries add up to the exact decimal sum (no floating-point drift), stored totals equal the sum of the lines', async () => {
    const mA = await f.mgr('A');
    const amounts = ['0.10', '0.20', '1000.07', '333.33', '7777.77', '5555.55', '1.01', '2.02', '4321.09', '999.99'];
    const ids: string[] = [];
    for (const a of amounts) ids.push(await f.employee('A', `Dec ${a}`, a));
    const p = await f.period('A', '2026-06', '2026-06-01', '2026-06-30');
    const run = await f.payroll.calculate(p, u().prep, mA);
    const { run: header, lines } = await f.payroll.getRun(run.id, mA);
    const mine = lines.filter((l) => ids.includes(l.employeeId));
    expect(mine).toHaveLength(amounts.length);
    expect(mine.reduce((s, l) => s.plus(l.grossPay), new Decimal(0)).toFixed(2)).toBe(amounts.reduce((s, a) => s.plus(a), new Decimal(0)).toFixed(2));
    // the stored header totals are exactly the sum of the stored lines (lines of employees from earlier tests included)
    const all = (v: 'grossPay' | 'netPay') => lines.reduce((s, l) => s.plus(l[v]), new Decimal(0)).toFixed(2);
    expect(header.totalGross).toBe(all('grossPay'));
    expect(header.totalNet).toBe(all('netPay'));
    expect(header.totalDeductions).toBe('0.00');
  });

  it('R-PAY-07 — periods never overlap (service pre-check AND database trigger); adjacent periods are fine; an unposted period cannot be closed', async () => {
    const mA = await f.mgr('A');
    await expect(f.payroll.createPeriod({ code: 'OVERLAP', startDate: '2026-06-15', endDate: '2026-07-15' }, u().prep, mA)).rejects.toThrow(/overlaps/i);
    await expect(f.payroll.createPeriod({ code: 'BACKWARDS', startDate: '2026-08-10', endDate: '2026-08-01' }, u().prep, mA)).rejects.toBeInstanceOf(ConflictException);
    const jul = await f.period('A', '2026-07', '2026-07-01', '2026-07-31'); // adjacent to June
    expect(jul).toBeTruthy();
    // the database refuses it even when the service is bypassed
    await expect(mA.query(`INSERT INTO payroll_periods (code, "startDate", "endDate") VALUES ('RAW', '2026-07-10', '2026-07-20')`)).rejects.toThrow(/overlaps an existing payroll period/);
    await expect(f.payroll.closePeriod(jul, u().prep, mA)).rejects.toThrow(/not "posted"|missing/);
  });

  it('R-PAY-04 — exceptions: no silent skip; classes; documented acknowledgement; B_APPROVE cannot be acknowledged; carry-over only for identical facts; stale inputs block submission; reviewed run recalculates as a NEW revision', async () => {
    const mA = await f.mgr('A');
    const paid = await f.employee('A', 'Ex Paid', '1200.00');
    const noComp = await f.employee('A', 'Ex NoComp', null);
    const terminated = await f.employee('A', 'Ex Terminated', '900.00');
    await f.hr.terminate(terminated, u().prep, 'left', '2026-08-10', mA);
    const onLeave = await f.employee('A', 'Ex OnLeave', '900.00');
    await f.hr.setStatus(onLeave, 'on_leave', u().prep, 'long leave', mA);
    const contractor = await f.employee('A', 'Ex Contractor', '900.00', { employmentType: 'contractor' });

    const p = await f.period('A', '2026-08', '2026-08-01', '2026-08-31');
    const run = await f.payroll.calculate(p, u().prep, mA);
    const { lines } = await f.payroll.getRun(run.id, mA);
    const paidIds = new Set(lines.map((l) => l.employeeId));
    expect(paidIds.has(paid)).toBe(true);
    for (const x of [noComp, terminated, onLeave, contractor]) expect(paidIds.has(x)).toBe(false); // not paid ...
    const byCode = async (code: string) => (await exceptionsOf(run.id, code)).filter((e) => e.employeeId !== null);
    expect((await byCode('NO_COMPENSATION')).map((e) => e.employeeId)).toContain(noComp); // ... and never silently
    expect((await byCode('TERMINATED_IN_PERIOD')).map((e) => e.employeeId)).toContain(terminated);
    expect((await byCode('EMPLOYEE_ON_LEAVE_STATUS')).map((e) => e.employeeId)).toContain(onLeave);
    const everything = await exceptionsOf(run.id);
    expect(everything.some((e) => e.employeeId === contractor)).toBe(false); // contractors are outside the population (ADR-067 §I) — no row, no exception
    expect((await byCode('NO_ATTENDANCE_COVERAGE')).map((e) => e.employeeId)).toContain(paid);

    // blocked: review is allowed, submission is not
    await f.payroll.review(run.id, u().rev, mA).catch(() => undefined);
    // (review needs state "calculated" — it is; so the run is now reviewed)
    await expect(f.payroll.submitForApproval(run.id, u().sub, mA)).rejects.toThrow(/unresolved exception/i);

    // acknowledgement rules
    await expect(f.payroll.acknowledgeExceptions(run.id, { code: 'NO_COMPENSATION' }, '', u().rev, mA)).rejects.toBeInstanceOf(ConflictException); // a decision reference is mandatory
    await expect(f.payroll.acknowledgeExceptions(run.id, { code: 'NO_COMPENSATION' }, 'DEC-1', u().prep, mA)).rejects.toBeInstanceOf(ForbiddenException); // the preparer cannot acknowledge (standard profile)
    const acked = await f.payroll.acknowledgeExceptions(run.id, { code: 'NO_COMPENSATION' }, 'DEC-1', u().rev, mA);
    expect(acked.every((e) => e.status === 'acknowledged' && e.decisionRef === 'DEC-1' && e.acknowledgedByUserId === u().rev)).toBe(true);

    // stale-input protection: a compensation changes after the review -> submission refused until the run is recalculated
    await f.payroll.createCompensation({ employeeId: paid, earnings: [{ componentCode: 'basic', amount: '1250.00' }], effectiveFrom: '2026-08-01', reason: 'correction' }, u().prep, mA);
    await f.acknowledgeAll('A', run.id);
    await expect(f.payroll.submitForApproval(run.id, u().sub, mA)).rejects.toThrow(/changed after the calculation|recalculate/i);

    // calculating again after review = a NEW revision that supersedes the reviewed one
    const rev2 = await f.payroll.calculate(p, u().prep, mA);
    expect(rev2.id).not.toBe(run.id);
    expect(rev2.revision).toBe(2);
    expect(rev2.supersedesRunId).toBe(run.id);
    const old = (await f.payroll.getRun(run.id, mA)).run;
    expect(old.status).toBe('superseded');
    expect((await lineOf(rev2.id, paid))!.grossPay).toBe('1250.00');
    expect(await mA.query(`SELECT 1 FROM payroll_runs WHERE "payrollPeriodId" = $1 AND kind = 'regular' AND status <> 'superseded'`, [p])).toHaveLength(1);
    // the database refuses a second live regular run for the period
    await expect(
      mA.query(`INSERT INTO payroll_runs (code, "payrollPeriodId", status, "createdByUserId", revision, kind) VALUES ('DUP-X', $1, 'draft', $2, 9, 'regular')`, [p, u().prep]),
    ).rejects.toThrow(/UQ_payroll_runs_period_active_regular|duplicate key/);

    // carry-over: an acknowledgement survives an in-place recalculation only for IDENTICAL facts
    await f.payroll.acknowledgeExceptions(rev2.id, { code: 'NO_ATTENDANCE_COVERAGE' }, 'DEC-ATT', u().rev, mA);
    const before = (await exceptionsOf(rev2.id, 'NO_ATTENDANCE_COVERAGE')).find((e) => e.employeeId === paid)!;
    expect(before.status).toBe('acknowledged');
    await f.payroll.createCompensation({ employeeId: noComp, earnings: [{ componentCode: 'basic', amount: '700.00' }], effectiveFrom: '2026-01-01', reason: 'now has a salary' }, u().prep, mA);
    const rev2b = await f.payroll.calculate(p, u().prep, mA); // run is "calculated" -> recalculated in place
    expect(rev2b.id).toBe(rev2.id);
    const after = await exceptionsOf(rev2.id);
    expect(after.find((e) => e.code === 'NO_COMPENSATION' && e.employeeId === noComp)).toBeUndefined(); // the cause is gone -> the exception is gone
    expect(after.find((e) => e.code === 'NO_ATTENDANCE_COVERAGE' && e.employeeId === paid)).toMatchObject({ id: before.id, status: 'acknowledged', decisionRef: 'DEC-ATT' }); // identical facts -> acknowledgement kept
    expect(after.find((e) => e.code === 'NO_ATTENDANCE_COVERAGE' && e.employeeId === noComp)).toMatchObject({ status: 'open' }); // new fact -> new, open exception
  });

  it('R-PAY-04 — B_APPROVE (accounting not ready) cannot be acknowledged; it clears only after the cause is fixed and the run recalculated', async () => {
    const mB = await f.mgr('B');
    const dsB = await f.dsOf('B');
    await f.employee('B', 'B Employee', '500.00');
    const p = await f.period('B', '2026-09', '2026-09-01', '2026-09-30');
    await dsB.query(`UPDATE accounting_gl_accounts SET "isActive" = false WHERE code = '2150'`);
    const run = await f.payroll.calculate(p, f.users.B.prep, mB);
    const blocking = await f.payroll.listExceptions(run.id, mB);
    expect(blocking.find((e) => e.code === 'WAGES_PAYABLE_ACCOUNT_MISSING')).toMatchObject({ impactClass: 'B_APPROVE', status: 'open' });
    await expect(f.payroll.acknowledgeExceptions(run.id, { code: 'WAGES_PAYABLE_ACCOUNT_MISSING' }, 'DEC-X', f.users.B.rev, mB)).rejects.toThrow(/cannot be acknowledged|No matching open exception/);
    await f.acknowledgeAll('B', run.id);
    await f.payroll.review(run.id, f.users.B.rev, mB);
    await expect(f.payroll.submitForApproval(run.id, f.users.B.sub, mB)).rejects.toThrow(/unresolved exception/i);
    await dsB.query(`UPDATE accounting_gl_accounts SET "isActive" = true WHERE code = '2150'`);
    // reviewed -> a corrected calculation is a new revision
    const rev2 = await f.payroll.calculate(p, f.users.B.prep, mB);
    expect(rev2.revision).toBe(2);
    expect((await f.payroll.listExceptions(rev2.id, mB)).some((e) => e.code === 'WAGES_PAYABLE_ACCOUNT_MISSING')).toBe(false);
  });

  it('R-PAY-05 — separation of duties from recorded actors: the approver cannot be the preparer or the submitter — through the Payroll route AND through the generic approvals route; nothing is posted on a refusal', async () => {
    const mA = await f.mgr('A');
    const emp = await f.employee('A', 'Sod One', '800.00');
    const p = await f.period('A', '2026-10', '2026-10-01', '2026-10-31');
    const run = await f.payroll.calculate(p, u().prep, mA);
    await f.acknowledgeAll('A', run.id);
    await f.payroll.review(run.id, u().rev, mA);
    const submitted = await f.payroll.submitForApproval(run.id, u().sub, mA);

    // 1) the Payroll route: the preparer is refused with a clear code, before any decision exists
    const e1 = await f.payroll.decide(submitted.approvalRequestId!, u().prep, 'approved', null, mA).catch((e) => e);
    expect(e1).toBeInstanceOf(ForbiddenException);
    expect((e1 as ForbiddenException).getResponse()).toMatchObject({ code: 'SOD_VIOLATION', conflictsWith: 'prepare' });

    // 2) the generic approvals route (the engine only compares the maker) lets the preparer decide — the handler refuses to post
    await f.approvals.decide(submitted.approvalRequestId!, u().prep, 'approved', null, mA);
    await f.drain('A');
    const refused = (await f.payroll.getRun(run.id, mA)).run;
    expect(refused.status).toBe('calculated');
    expect(refused.approvalRequestId).toBeNull();
    expect(refused.rejectionReason).toMatch(/refused by policy/i);
    expect((await mA.query(`SELECT count(*)::int AS n FROM event_outbox WHERE topic = 'payroll.run.posted' AND payload->>'payrollRunId' = $1`, [run.id]))[0].n).toBe(0);
    expect((await mA.query(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'payroll.run.approval_refused_by_policy' AND "resourceId" = $1`, [run.id]))[0].n).toBe(1);
    expect((await mA.query(`SELECT count(*)::int AS n FROM payroll_input_consumptions WHERE "payrollRunId" = $1 AND state = 'consumed'`, [run.id]))[0].n).toBe(0);

    // 3) a legitimate resubmission by a different submitter and a different approver posts exactly once
    await f.payroll.review(run.id, u().rev, mA);
    const again = await f.payroll.submitForApproval(run.id, u().sub, mA);
    expect(again.approvalRequestId).not.toBe(submitted.approvalRequestId);
    await f.payroll.decide(again.approvalRequestId!, u().appr, 'approved', null, mA);
    await f.drain('A');
    expect((await f.payroll.getRun(run.id, mA)).run.status).toBe('posted');
    expect((await mA.query(`SELECT count(*)::int AS n FROM event_outbox WHERE topic = 'payroll.run.posted' AND payload->>'payrollRunId' = $1`, [run.id]))[0].n).toBe(1);
    const actors = (await f.payroll.listStageActors(run.id, mA)).map((a) => `${a.stage}:${a.userId}`);
    expect(actors).toEqual(expect.arrayContaining([`prepare:${u().prep}`, `review:${u().rev}`, `submit:${u().sub}`, `approve:${u().appr}`, `acknowledge_exception:${u().rev}`]));
    void emp;
  });

  it('R-PAY-05 — the strict profile adds: reviewer, submitter and acknowledger differ from the preparer, and the approver did not review or acknowledge', async () => {
    const mA = await f.mgr('A');
    expect(await f.payroll.getSodProfile(mA)).toBe('standard');
    await f.payroll.setSodProfile('strict', u().extra, mA);
    try {
      await f.employee('A', 'Strict One', '600.00');
      const p = await f.period('A', '2026-11', '2026-11-01', '2026-11-30');
      const run = await f.payroll.calculate(p, u().prep, mA);
      await expect(f.payroll.acknowledgeExceptions(run.id, { code: 'NO_ATTENDANCE_COVERAGE' }, 'DEC-S', u().prep, mA)).rejects.toBeInstanceOf(ForbiddenException);
      await f.acknowledgeAll('A', run.id, u().rev);
      await expect(f.payroll.review(run.id, u().prep, mA)).rejects.toBeInstanceOf(ForbiddenException); // reviewer = preparer
      await f.payroll.review(run.id, u().rev, mA);
      await expect(f.payroll.submitForApproval(run.id, u().prep, mA)).rejects.toBeInstanceOf(ForbiddenException); // submitter = preparer
      const submitted = await f.payroll.submitForApproval(run.id, u().sub, mA);
      const e = await f.payroll.decide(submitted.approvalRequestId!, u().rev, 'approved', null, mA).catch((x) => x); // approver = reviewer/acknowledger
      expect(e).toBeInstanceOf(ForbiddenException);
      await f.payroll.decide(submitted.approvalRequestId!, u().appr, 'approved', null, mA);
      await f.drain('A');
      expect((await f.payroll.getRun(run.id, mA)).run.status).toBe('posted');
    } finally {
      await f.payroll.setSodProfile('standard', u().extra, mA);
    }
    expect(await f.payroll.getSodProfile(mA)).toBe('standard');
  });

  it('R-PAY-06 — a rejected approval returns the run to "calculated" with who/why recorded; the request history is kept; resubmission is a new request; nothing posts twice', async () => {
    const mA = await f.mgr('A');
    await f.employee('A', 'Reject One', '650.00');
    const p = await f.period('A', '2026-12', '2026-12-01', '2026-12-31');
    const run = await f.payroll.calculate(p, u().prep, mA);
    await f.acknowledgeAll('A', run.id);
    await f.payroll.review(run.id, u().rev, mA);
    const first = await f.payroll.submitForApproval(run.id, u().sub, mA);
    await f.payroll.decide(first.approvalRequestId!, u().appr, 'rejected', 'wrong overtime assumption', mA);
    await f.drain('A');
    const back = (await f.payroll.getRun(run.id, mA)).run;
    expect(back).toMatchObject({ status: 'calculated', approvalRequestId: null, rejectedByUserId: u().appr, rejectionReason: 'wrong overtime assumption' });
    expect((await mA.query(`SELECT "currentState" FROM process_instances WHERE "entityType" = 'ApprovalRequest' AND "entityId" = $1`, [first.approvalRequestId]))[0].currentState).toBe('rejected'); // history kept
    // correct and resubmit
    await f.payroll.review(run.id, u().rev, mA);
    const second = await f.payroll.submitForApproval(run.id, u().sub, mA);
    expect(second.approvalRequestId).not.toBe(first.approvalRequestId);
    await f.payroll.decide(second.approvalRequestId!, u().appr, 'approved', null, mA);
    await f.drain('A');
    expect((await f.payroll.getRun(run.id, mA)).run.status).toBe('posted');
    expect((await mA.query(`SELECT count(*)::int AS n FROM event_outbox WHERE topic = 'payroll.run.posted' AND payload->>'payrollRunId' = $1`, [run.id]))[0].n).toBe(1);
  });

  it('R-PAY-08 / R-PAY-07 — posted history is never rewritten: recalculation of a posted period is refused (supplementary run instead, deltas only); a closed period accepts only a supplementary run; close needs a posted run', async () => {
    const mA = await f.mgr('A');
    const emp = await f.employee('A', 'Supp One', '1000.00');
    const p = await f.period('A', '2027-01', '2027-01-01', '2027-01-31');
    const regular = await f.postRun('A', p);
    expect(regular.status).toBe('posted');
    const baseline = (await lineOf(regular.id, emp))!;
    expect(baseline.grossPay).toBe('1000.00');

    await expect(f.payroll.calculate(p, u().prep, mA)).rejects.toThrow(/supplementary/i); // no in-place recalculation of a posted run

    // a retroactive raise that reaches into the posted period
    await f.payroll.createCompensation({ employeeId: emp, earnings: [{ componentCode: 'basic', amount: '1200.00' }], effectiveFrom: '2027-01-10', reason: 'retroactive correction' }, u().prep, mA);
    const supp = await f.payroll.calculateSupplementary(p, u().prep, mA);
    expect(supp).toMatchObject({ kind: 'supplementary', revision: 2 });
    const { lines } = await f.payroll.getRun(supp.id, mA);
    expect(lines).toHaveLength(1); // only the employee whose pay changed
    expect(lines[0]).toMatchObject({ employeeId: emp, grossPay: '200.00', netPay: '200.00' }); // the delta, not the full pay
    expect((await f.payroll.getRun(regular.id, mA)).lines.find((l) => l.employeeId === emp)!.grossPay).toBe('1000.00'); // posted line untouched
    await f.acknowledgeAll('A', supp.id);
    await f.payroll.review(supp.id, u().rev, mA);
    const sub = await f.payroll.submitForApproval(supp.id, u().sub, mA);
    await f.payroll.decide(sub.approvalRequestId!, u().appr, 'approved', null, mA);
    await f.drain('A');
    expect((await f.payroll.getRun(supp.id, mA)).run.status).toBe('posted');
    const eventStatus = await f.payroll.getFinancialEventStatus(supp.id, mA);
    expect(eventStatus?.status.toUpperCase()).toBe('POSTED');

    // closing the period
    await f.payroll.closePeriod(p, u().extra, mA);
    expect((await mA.query(`SELECT status FROM payroll_periods WHERE id = $1`, [p]))[0].status).toBe('closed');
    await expect(f.payroll.calculate(p, u().prep, mA)).rejects.toThrow(/closed/i);
    await f.payroll.createCompensation({ employeeId: emp, earnings: [{ componentCode: 'basic', amount: '1300.00' }], effectiveFrom: '2027-01-20', reason: 'second retroactive correction' }, u().prep, mA);
    const supp2 = await f.payroll.calculateSupplementary(p, u().prep, mA); // post-close correction path
    expect(supp2).toMatchObject({ kind: 'supplementary', revision: 3 });
    expect((await f.payroll.getRun(supp2.id, mA)).lines[0]).toMatchObject({ grossPay: '100.00' }); // 1300 - (1000 + 200) already paid
    await expect(f.payroll.closePeriod(p, u().extra, mA)).rejects.toThrow(/already closed/i);
  });

  it('R-SEC-01 — every new table is Company-local: nothing of Company A leaked into Company B', async () => {
    const mA = await f.mgr('A');
    const mB = await f.mgr('B');
    const aRuns: Array<{ id: string }> = await mA.query(`SELECT id FROM payroll_runs`);
    expect(aRuns.length).toBeGreaterThan(5);
    const ids = aRuns.map((r) => r.id);
    for (const [table, col] of [
      ['payroll_runs', 'id'],
      ['payroll_run_stage_actors', '"payrollRunId"'],
      ['payroll_exceptions', '"payrollRunId"'],
      ['payroll_input_consumptions', '"payrollRunId"'],
      ['payroll_payout_batches', '"payrollRunId"'],
    ] as Array<[string, string]>) {
      expect((await mB.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = ANY($1::uuid[])`, [ids]))[0].n).toBe(0);
    }
    expect(await f.payroll.getSodProfile(mB)).toBe('standard'); // A's strict/standard toggling did not touch B's settings
    await expect(f.payroll.getRun(ids[0], mB)).rejects.toThrow(/not found/i);
  });
});
