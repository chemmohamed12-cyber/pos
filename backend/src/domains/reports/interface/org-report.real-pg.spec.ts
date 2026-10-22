import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { OrgReportService } from '../application/org-report.service';
import { AccessScope, AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Org engine Stage 7 (real PostgreSQL) — the organizational report: every figure reconciles with an independent source total, a metric whose module is absent is `null`
 * (not 0), legacy records are an explicit Unassigned bucket, a restricted caller only sees the branches in their scope, a unit view shows that unit and its
 * descendants one by one, the cost-centre view and the period filter work, and Company B never leaks into Company A.
 */
describe('Organizational report (real Postgres)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ds: DataSource;
  let dsB: DataSource;
  let report: OrgReportService;
  let scope: AccessScope;
  const actor = randomUUID();
  const ids = { root: randomUUID(), x: randomUUID(), y: randomUUID(), dept: randomUUID(), customer: randomUUID(), account: randomUUID() };
  const req = (d: DataSource) => ({ user: { id: actor, email: 'x@test.local', companyId: 'c' }, companyContext: { companyId: 'c', dataSource: d } }) as unknown as CompanyScopedRequest;
  const unrestricted = (): AccessScope => ({ userId: actor, unrestricted: true, unitIds: new Set<string>() });
  const row = (r: Awaited<ReturnType<OrgReportService['overview']>>, name: string) => r.rows.find((x) => x.name === name)!;

  const order = (n: string, branch: string | null, total: string, created: string) =>
    ds.query(
      `INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","repSequenceNumber","createdByUserId","branchOrgUnitId","createdAt") VALUES ($1,$2,$3,$4,$5,1,$4,$6,$7)`,
      [randomUUID(), `SO-RPT-${n}`, ids.customer, actor, total, branch, created],
    );
  const journal = async (date: string, lines: Array<{ unit: string | null; debit?: string; credit?: string }>, entryUnit: string | null = null, posted = true) => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO accounting_journal_entries (id,"businessDate","sourceType","transactionCurrencyCode","functionalCurrencyCode","createdBy","orgUnitId","postedAt") VALUES ($1,$2,'MANUAL','EGP','EGP',$3,$4,$5)`,
      [id, date, actor, entryUnit, posted ? new Date() : null],
    );
    let n = 1;
    const lineIds: string[] = [];
    for (const l of lines) {
      const lid = randomUUID();
      lineIds.push(lid);
      await ds.query(
        `INSERT INTO accounting_journal_lines (id,"journalEntryId","lineNumber","accountId","debitTransaction","creditTransaction","debitBase","creditBase","exchangeRateDate","orgUnitId") VALUES ($1,$2,$3,$4,$5,$6,$5,$6,$7,$8)`,
        [lid, id, n++, ids.account, l.debit ?? '0', l.credit ?? '0', date, l.unit],
      );
    }
    return lineIds;
  };

  beforeAll(async () => {
    // no procurement tag on purpose: purchase_orders does not exist -> those metrics must be NULL, not 0
    h = await setUpTwoCompanyHarness({ namePrefix: 'org_report', extraCompanyTags: ['sales', 'inventory', 'finance', 'accounting', 'logistics'] });
    ds = await h.connections.getDataSource(h.companyAId);
    dsB = await h.connections.getDataSource(h.companyBId);
    const inert = {} as never;
    const scopes = new AccessScopeService(inert, inert);
    jest.spyOn(scopes, 'forRequest').mockImplementation(async () => scope);
    report = new OrgReportService(h.controlPlane, scopes);
    scope = unrestricted();
    await ds.query(`INSERT INTO org_units (id,type,name,"parentId") VALUES ($1,'company','Mother',NULL),($2,'branch','Branch X',$1),($3,'branch','Branch Y',$1),($4,'department','Dept D',$2)`, [ids.root, ids.x, ids.y, ids.dept]);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Rpt','rpt@test.local')`, [actor]);
    await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit","paymentTermsDays") VALUES ($1,'CUST-RPT','C','1000','30')`, [ids.customer]);
    await order('1', ids.x, '100.00', '2026-03-10T10:00:00Z');
    await order('2', ids.x, '50.00', '2026-04-10T10:00:00Z');
    await order('3', ids.y, '30.00', '2026-03-20T10:00:00Z');
    await order('4', null, '20.00', '2026-03-25T10:00:00Z'); // legacy: no branch
    await journal('2026-03-15', [{ unit: ids.x, debit: '40' }, { unit: ids.x, credit: '40' }]);
    await journal('2026-03-16', [{ unit: ids.dept, debit: '10' }, { unit: ids.dept, credit: '10' }]); // department line -> rolls up to Branch X
    await journal('2026-03-17', [{ unit: null, debit: '5' }, { unit: null, credit: '5' }], ids.y); // line without unit -> the entry's unit (Branch Y)
    await journal('2026-03-18', [{ unit: null, debit: '7' }, { unit: null, credit: '7' }]); // nothing -> Unassigned
    await journal('2026-03-19', [{ unit: ids.x, debit: '999' }, { unit: ids.x, credit: '999' }], null, false); // NOT posted -> never counted
  });
  afterAll(async () => h.teardown());

  it('rolls documents up to branches; legacy records are an explicit Unassigned bucket; totals reconcile with the source', async () => {
    const r = await report.overview(req(ds), {});
    expect(row(r, 'Branch X').metrics.sales_orders_count).toBe(2);
    expect(row(r, 'Branch X').metrics.sales_orders_value).toBe(150);
    expect(row(r, 'Branch Y').metrics.sales_orders_count).toBe(1);
    expect(row(r, 'unassigned').metrics.sales_orders_count).toBe(1);
    expect(r.totals.sales_orders_count).toBe(4);
    expect(r.reconciliation.filter((x) => x.reconciles !== true)).toEqual([]);
  });

  it('GL figures: posted lines only, a department line rolls up to its branch, the entry’s unit is the fallback, no unit = Unassigned', async () => {
    const r = await report.overview(req(ds), {});
    expect(row(r, 'Branch X').metrics.gl_debit_base).toBe(50); // 40 + 10 (department D rolls up); the 999 unposted entry is excluded
    expect(row(r, 'Branch Y').metrics.gl_debit_base).toBe(5);
    expect(row(r, 'unassigned').metrics.gl_debit_base).toBe(7);
    expect(r.totals.gl_debit_base).toBe(62);
    expect(r.totals.gl_credit_base).toBe(62);
  });

  it('zero is not missing: a branch without activity shows 0 and hasActivity=false; a module that is not installed shows NULL', async () => {
    const r = await report.overview(req(ds), { from: '2026-04-01', to: '2026-04-30' });
    expect(row(r, 'Branch Y').metrics.sales_orders_count).toBe(0);
    expect(row(r, 'Branch Y').hasActivity).toBe(false);
    expect(row(r, 'Branch X').metrics.sales_orders_count).toBe(1); // only the April order
    expect(row(r, 'Branch X').metrics.purchase_orders_count).toBeNull(); // procurement is not installed in this Company
    expect(r.totals.purchase_orders_count).toBeNull();
    expect(r.moduleAvailability.purchase_orders_count).toBe(false);
    expect(r.moduleAvailability.sales_orders_count).toBe(true);
  });

  it('the period filter is inclusive on both ends (UTC days) and rejects malformed or inverted ranges', async () => {
    const r = await report.overview(req(ds), { from: '2026-03-10', to: '2026-03-10' });
    expect(r.totals.sales_orders_count).toBe(1);
    await expect(report.overview(req(ds), { from: '2026/03/10' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(report.overview(req(ds), { from: '2026-04-01', to: '2026-03-01' })).rejects.toThrow(/must not be after/);
  });

  it('a restricted caller sees only the branches inside their scope (plus the explicit Unassigned bucket) and no Company-wide reconciliation', async () => {
    scope = { userId: actor, unrestricted: false, unitIds: new Set([ids.y]) };
    const r = await report.overview(req(ds), {});
    const names = r.rows.map((x) => x.name);
    expect(names).toContain('Branch Y');
    expect(names).not.toContain('Branch X');
    expect(r.reconciliation.every((x) => x.reconciles === null)).toBe(true);
    await expect(report.overview(req(ds), { unitId: ids.x })).rejects.toThrow(/Not Found/i); // asking for a unit outside the scope is a 404
    scope = unrestricted();
  });

  it('a unit view shows that unit and its descendants one by one (department detail), restricted to the selection', async () => {
    const r = await report.overview(req(ds), { unitId: ids.x });
    expect(r.rows.map((x) => x.name).sort()).toEqual(['Branch X', 'Dept D']);
    expect(row(r, 'Dept D').metrics.gl_debit_base).toBe(10);
    expect(row(r, 'Branch X').metrics.gl_debit_base).toBe(40);
    const only = await report.overview(req(ds), { unitId: ids.x, includeDescendants: false });
    expect(only.rows.map((x) => x.name)).toEqual(['Branch X']);
    await expect(report.overview(req(ds), { unitId: randomUUID() })).rejects.toThrow(/Unknown organization unit/);
  });

  it('cost-centre view: posted debits/credits per cost centre in the period', async () => {
    await ds.query(`INSERT INTO accounting_financial_dimension_types (id,code,name) VALUES ($1,'cost_center','Cost centre')`, [ids.account]).catch(() => undefined);
    const type = (await ds.query(`SELECT id FROM accounting_financial_dimension_types WHERE code = 'cost_center'`))[0].id;
    const value = randomUUID();
    await ds.query(`INSERT INTO accounting_financial_dimension_values (id,"dimensionTypeId",code,name,"orgUnitId") VALUES ($1,$2,'CC-1','CC one',$3)`, [value, type, ids.x]);
    const [debitLine] = await journal('2026-03-21', [{ unit: ids.x, debit: '12' }, { unit: ids.x, credit: '12' }]);
    await ds.query(`INSERT INTO accounting_journal_line_dimensions (id,"journalLineId","dimensionTypeId","dimensionValueId") VALUES ($1,$2,$3,$4)`, [randomUUID(), debitLine, type, value]);
    const r = await report.overview(req(ds), { from: '2026-03-01', to: '2026-03-31' });
    expect(r.costCenters).toEqual([expect.objectContaining({ code: 'CC-1', debitBase: 12, creditBase: 0, unitId: ids.x })]);
  });

  it('Company B is untouched: its report has no branch of A and no figures of A', async () => {
    scope = unrestricted();
    const r = await report.overview(req(dsB), {});
    expect(r.rows.map((x) => x.name)).not.toContain('Branch X');
    expect(r.totals.sales_orders_count).toBe(0);
  });
});

