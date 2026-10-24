import { randomUUID } from 'crypto';
import { CustomerStatementService } from '../application/customer-statement.service';
import { CustomerStatementExportService } from '../application/customer-statement-export.service';
import { CustomerLedgerService } from '../application/customer-ledger.service';
import { CustomersService } from '../../crm/application/customers.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Customer statement (D2/D3/D5/D6) — real-Postgres proof of the READ side: opening balance before the period, the whole last day included, deterministic order for equal
 * timestamps, reversal separation, closing = engine balance, exports built from the same payload, and Company A/B isolation. Ledger rows are inserted with explicit
 * dates so every figure below is exact and reproducible.
 */
describe('Customer statement — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let statements: CustomerStatementService;
  let exporter: CustomerStatementExportService;
  const actor = randomUUID();
  type Key = 'A' | 'B';
  const cust: Record<Key, string> = { A: randomUUID(), B: randomUUID() };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  let seq = 0;

  async function entry(k: Key, o: { type: string; dir: 'debit' | 'credit'; amount: string; at: string; createdAt?: string; status?: string; reversalOf?: string | null; reason?: string; number?: string }): Promise<string> {
    const ds = await dsOf(k);
    const id = randomUUID();
    seq += 1;
    await ds.query(
      `INSERT INTO "customer_ledger_entries" ("id","entryNumber","customerId","entryType","direction","amount","reason","entryDate","createdByUserId","reversalOfEntryId","status","createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,COALESCE($12::timestamptz, $8::timestamptz))`,
      [id, o.number ?? `CLE-T-${String(seq).padStart(6, '0')}`, cust[k], o.type, o.dir, o.amount, o.reason ?? null, o.at, actor, o.reversalOf ?? null, o.status ?? 'posted', o.createdAt ?? null],
    );
    return id;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'cust_stmt', extraCompanyTags: ['sales', 'inventory', 'logistics', 'finance', 'procurement', 'accounting'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const dsA = await dsOf('A');
    for (const k of ['A', 'B'] as Key[]) {
      const ds = await dsOf(k);
      await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Stmt Operator',$2) ON CONFLICT DO NOTHING`, [actor, `stmt-${k}@test.local`]);
      await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
      const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
      await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
      await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit","taxRegistrationNumber","address") VALUES ($1,$2,$3,'5000.00','TAX-123','12 Test Street')`, [cust[k], `ST-CUST-${k}`, `Statement Customer ${k}`]);
    }
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const customers = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
    const ledger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    statements = new CustomerStatementService(h.controlPlane, customers, ledger);
    exporter = new CustomerStatementExportService();

    // --- Company A ledger (all amounts exact) ---
    await entry('A', { type: 'opening_balance', dir: 'debit', amount: '100.00', at: '2026-09-10T08:00:00Z', reason: 'AR opening_balance: migrated' });
    await entry('A', { type: 'payment', dir: 'credit', amount: '30.00', at: '2026-09-20T09:00:00Z', reason: 'On-account payment (cash)' });
    await entry('A', { type: 'sales_invoice', dir: 'debit', amount: '50.00', at: '2026-10-05T10:00:00Z', reason: 'Sales invoice posted' });
    await entry('A', { type: 'deposit', dir: 'credit', amount: '5.00', at: '2026-10-05T23:59:59Z', reason: 'Customer deposit (wallet)' }); // last second of Oct 5
    await entry('A', { type: 'payment', dir: 'credit', amount: '7.00', at: '2026-10-06T00:00:00Z', reason: 'Payment (cash)' }); // first second of Oct 6
    await entry('A', { type: 'cod_collection', dir: 'credit', amount: '10.00', at: '2026-10-31T23:30:00Z', reason: 'COD remitted (cash)' }); // late on the LAST day
    await entry('A', { type: 'sales_invoice', dir: 'debit', amount: '20.00', at: '2026-11-02T10:00:00Z', reason: 'Sales invoice posted' }); // after the period
    // Company B: a different customer with its own entries
    await entry('B', { type: 'sales_invoice', dir: 'debit', amount: '999.00', at: '2026-10-05T10:00:00Z', reason: 'Sales invoice posted' });
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('statement teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const stmt = async (from?: string, to?: string, extra: { entryType?: string; status?: string } = {}) => statements.getStatement(cust.A, actor, { from, to, ...extra }, (await dsOf('A')).manager);

  it('S1 opening balance is everything BEFORE the period, never just the period', async () => {
    const s = await stmt('2026-10-01', '2026-10-31');
    expect(s.openingBalance).toBe('70.00'); // 100 − 30
    expect(s.rows.map((r) => r.entryType)).toEqual(['sales_invoice', 'deposit', 'payment', 'cod_collection']);
    expect(s.rows.map((r) => r.balance)).toEqual(['120.00', '115.00', '108.00', '98.00']);
    expect(s.totals).toEqual({ debit: '50.00', credit: '22.00' });
    expect(s.closingBalance).toBe('98.00');
  });

  it('S2 the period end includes the WHOLE last day; the first second of the next day is excluded', async () => {
    const octFifth = await stmt('2026-10-05', '2026-10-05');
    expect(octFifth.rows.map((r) => r.entryType)).toEqual(['sales_invoice', 'deposit']); // 10:00 and 23:59:59
    expect(octFifth.closingBalance).toBe('115.00');
    const lastDay = await stmt('2026-10-31', '2026-10-31');
    expect(lastDay.rows.map((r) => r.entryType)).toEqual(['cod_collection']); // 23:30 on the last day is inside
    expect(lastDay.openingBalance).toBe('108.00');
    const none = await stmt('2026-10-07', '2026-10-30');
    expect(none.rows).toHaveLength(0);
    expect(none.openingBalance).toBe(none.closingBalance);
  });

  it('S3 the closing balance equals the ledger engine balance as of the period end (reconciliation), and the open-ended statement equals getCustomerBalance', async () => {
    const s = await stmt('2026-10-01', '2026-10-31');
    expect(s.reconciliation).toEqual({ ledgerBalanceAtPeriodEnd: '98.00', matches: true });
    const all = await stmt();
    expect(all.openingBalance).toBe('0.00');
    expect(all.closingBalance).toBe('118.00'); // 100 − 30 + 50 − 5 − 7 − 10 + 20
    expect(all.reconciliation.matches).toBe(true);
    expect(all.rows).toHaveLength(7);
  });

  it('S4 equal timestamps are ordered deterministically (entryDate, createdAt, entryNumber) and the running balance is stable across calls', async () => {
    const same = '2026-12-01T12:00:00Z';
    await entry('A', { type: 'adjustment', dir: 'debit', amount: '3.00', at: same, number: 'CLE-T-ZZ3' });
    await entry('A', { type: 'adjustment', dir: 'credit', amount: '1.00', at: same, number: 'CLE-T-ZZ1' });
    await entry('A', { type: 'adjustment', dir: 'debit', amount: '2.00', at: same, number: 'CLE-T-ZZ2' });
    const a = await stmt('2026-12-01', '2026-12-01');
    const b = await stmt('2026-12-01', '2026-12-01');
    expect(a.rows.map((r) => r.entryNumber)).toEqual(['CLE-T-ZZ1', 'CLE-T-ZZ2', 'CLE-T-ZZ3']);
    expect(a.rows.map((r) => r.balance)).toEqual(['117.00', '119.00', '122.00']);
    expect(b.rows.map((r) => r.balance)).toEqual(a.rows.map((r) => r.balance));
    expect(b.reference.split('-').pop()).toBe(a.reference.split('-').pop()); // same content → same digest
  });

  it('S5 a reversed entry and its reversal leg are shown and counted in the ledger totals, but excluded from "net of reversals"; filters never change the totals', async () => {
    const orig = await entry('A', { type: 'payment', dir: 'credit', amount: '40.00', at: '2027-01-10T10:00:00Z', reason: 'Payment (cash)', status: 'reversed', number: 'CLE-T-R1' });
    await entry('A', { type: 'payment', dir: 'debit', amount: '40.00', at: '2027-01-10T11:00:00Z', reason: 'Reversal: wrong customer', reversalOf: orig, number: 'CLE-T-R2' });
    await entry('A', { type: 'sales_invoice', dir: 'debit', amount: '15.00', at: '2027-01-11T10:00:00Z', reason: 'Sales invoice posted', number: 'CLE-T-R3' });
    const s = await stmt('2027-01-01', '2027-01-31');
    expect(s.totals).toEqual({ debit: '55.00', credit: '40.00' });
    expect(s.totalsExcludingReversals).toEqual({ debit: '15.00', credit: '0.00' });
    expect(s.reversedCount).toBe(1);
    expect(s.rows.find((r) => r.entryNumber === 'CLE-T-R1')?.nettedOut).toBe(true);
    expect(s.rows.find((r) => r.entryNumber === 'CLE-T-R2')?.isReversalLeg).toBe(true);
    expect(s.closingBalance).toBe((Number(s.openingBalance) + 15).toFixed(2)); // the pair nets to zero
    const filtered = await stmt('2027-01-01', '2027-01-31', { entryType: 'sales_invoice' });
    expect(filtered.isComplete).toBe(false);
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.totals).toEqual(s.totals); // official totals are unchanged by a view filter
    expect(filtered.filteredTotals).toEqual({ debit: '15.00', credit: '0.00' });
    expect(filtered.rows[0].balance).toBe(s.rows.find((r) => r.entryNumber === 'CLE-T-R3')!.balance); // running balance stays the true ledger balance
    const onlyReversed = await stmt('2027-01-01', '2027-01-31', { status: 'reversed' });
    expect(onlyReversed.rows.map((r) => r.entryNumber)).toEqual(['CLE-T-R1']);
  });

  it('S6 historical English reasons are shown as business Arabic/English descriptions at read time; the stored rows are untouched', async () => {
    const s = await stmt('2026-10-01', '2026-10-31');
    const dep = s.rows.find((r) => r.entryType === 'deposit')!;
    expect(dep.description.ar).toBe('عربون عميل (محفظة إلكترونية)');
    expect(dep.description.en).toBe('Customer deposit (wallet)');
    expect(s.rows.find((r) => r.entryType === 'cod_collection')!.description.ar).toBe('تحصيل عند التسليم (نقدًا) — مورَّد');
    const ds = await dsOf('A');
    const raw = await ds.query(`SELECT reason FROM "customer_ledger_entries" WHERE "entryType" = 'deposit' AND "customerId" = $1`, [cust.A]);
    expect(raw[0].reason).toBe('Customer deposit (wallet)');
  });

  it('S7 company isolation: Company B data is invisible to A and the other way round; an unknown/foreign customer id is a 404, not an empty statement', async () => {
    const dsA = await dsOf('A');
    await expect(statements.getStatement(cust.B, actor, {}, dsA.manager)).rejects.toThrow(/not found/i);
    const dsB = await dsOf('B');
    const sb = await statements.getStatement(cust.B, actor, {}, dsB.manager);
    expect(sb.closingBalance).toBe('999.00');
    expect(sb.rows).toHaveLength(1);
    await expect(statements.getEntryDetails(randomUUID(), actor, dsA.manager)).rejects.toThrow(/not found/i);
  });

  it('S8 exports are built from the same payload: CSV (BOM, header block, opening/closing rows), XLSX (valid workbook) and PDF (valid, multi-language) all render', async () => {
    const s = await stmt('2026-10-01', '2026-10-31');
    const csv = await exporter.render(s, 'csv', 'ar', 'شركة A');
    const text = csv.buffer.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain(s.reference);
    expect(text).toContain('الرصيد الافتتاحي');
    expect(text.trim().split('\r\n').length).toBeGreaterThanOrEqual(s.rows.length + 20);
    const en = (await exporter.render(s, 'csv', 'en', 'Company A')).buffer.toString('utf8');
    expect(en).toContain('Opening balance');
    expect(en).toContain('Customer deposit (wallet)');
    const x = await exporter.render(s, 'xlsx', 'ar', 'Company A');
    expect(x.buffer.subarray(0, 2).toString()).toBe('PK');
    for (const lang of ['ar', 'en'] as const) {
      const pdf = await exporter.render(s, 'pdf', lang, 'Company A');
      expect(pdf.buffer.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.buffer.length).toBeGreaterThan(5000);
      expect(pdf.contentType).toBe('application/pdf');
    }
  });

  it('S10 indicators: returns count only the return credit itself (not its later application), payment applications never count as collections, advances stay out of "invoiced"', async () => {
    const ds = await dsOf('A');
    await entry('A', { type: 'return_credit_note', dir: 'credit', amount: '12.00', at: '2026-10-10T10:00:00Z', reason: 'Sales return credit', number: 'CLE-T-RT1' });
    await entry('A', { type: 'return_credit_note', dir: 'credit', amount: '12.00', at: '2026-10-11T10:00:00Z', reason: 'Return credit applied to invoice', number: 'CLE-T-RT2' });
    await entry('A', { type: 'payment_application', dir: 'debit', amount: '9.00', at: '2026-10-12T10:00:00Z', reason: 'Application of PAY-1', number: 'CLE-T-AP1' });
    await entry('A', { type: 'payment_application', dir: 'credit', amount: '9.00', at: '2026-10-12T10:00:01Z', reason: 'Application of PAY-1', number: 'CLE-T-AP2' });
    const sum = await statements.getAccountSummary(cust.A, actor, { asOf: '2026-10-31', from: '2026-10-01', to: '2026-10-31' }, ds.manager);
    expect(sum.returnsInPeriod).toBe('12.00');
    expect(sum.invoicedInPeriod).toBe('50.00'); // only the 2026-10-05 invoice
    expect(sum.collectedInPeriod).toBe('22.00'); // deposit 5 + payment 7 + COD 10; the application pair (debit 9 / credit 9) is excluded
    const st = await statements.getStatement(cust.A, actor, { from: '2026-10-01', to: '2026-10-31' }, ds.manager);
    expect(st.currency.code).toBe('EGP');
    expect(st.currency.note.en).toMatch(/no mixed currencies/);
    expect(st.rows.find((r) => r.entryNumber === 'CLE-T-RT1')!.description.en).toBe('Credit note — sales return');
    expect(st.reconciliation.matches).toBe(true);
  });

  it('S9 the statement reads only: no ledger, treasury or event row changed while every screen/export above was produced', async () => {
    const ds = await dsOf('A');
    const n = async (sql: string) => Number((await ds.query(sql))[0].n);
    const before = { le: await n(`SELECT count(*) AS n FROM "customer_ledger_entries"`), ev: await n(`SELECT count(*) AS n FROM "accounting_financial_events"`), tt: await n(`SELECT count(*) AS n FROM "treasury_transactions"`) };
    await stmt('2026-10-01', '2026-10-31');
    await statements.getAccountSummary(cust.A, actor, {}, ds.manager);
    expect({ le: await n(`SELECT count(*) AS n FROM "customer_ledger_entries"`), ev: await n(`SELECT count(*) AS n FROM "accounting_financial_events"`), tt: await n(`SELECT count(*) AS n FROM "treasury_transactions"`) }).toEqual(before);
  });
});
