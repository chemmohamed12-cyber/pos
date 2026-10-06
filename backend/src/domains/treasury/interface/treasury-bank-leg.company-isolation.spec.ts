import { randomUUID } from 'crypto';
import { SupplierPaymentService } from '../../procurement/application/supplier-payment.service';
import { SupplierLedgerService } from '../../procurement/application/supplier-ledger.service';
import { SupplierInvoiceService } from '../../procurement/application/supplier-invoice.service';
import { PaymentsService } from '../../customer-finance/application/payments.service';
import { CustomersService } from '../../crm/application/customers.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';
import { TreasuryService } from '../application/treasury.service';
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
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * D2 (2026-10-04, CTO-approved) — real-Postgres proof of the bank-leg policy for payments:
 *   • the GL bank leg is the PAYING/RECEIVING Treasury account's OWN mapped GL account (never "the first
 *     `bank` control account"; both 1101 and 1102 carry the `bank` control function in every chart below, so a
 *     fallback would be visible immediately);
 *   • an UNMAPPED account is rejected BEFORE any mutation (zero treasury / ledger / payment / event / journal rows);
 *   • per-Company: Company A's payments post only in A, Company B untouched, B's DataSource never requested.
 * The full GL pipeline is real (D10 `dispatchAfterCommit` flushes each Company's outbox into that Company's GL).
 */
describe('D2 — Treasury account → mapped GL bank leg (supplier + customer payments) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let supplierPayments: SupplierPaymentService;
  let customerPayments: PaymentsService;
  let treasury: TreasuryService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';

  const ctx: Record<Key, { supplierId: string; supplierInvoiceId: string; customerId: string; salesInvoiceId: string; mappedTo1102: string; mappedTo1101: string; unmapped: string; dangling: string }> = {
    A: { supplierId: '', supplierInvoiceId: '', customerId: '', salesInvoiceId: '', mappedTo1102: '', mappedTo1101: '', unmapped: '', dangling: '' },
    B: { supplierId: '', supplierInvoiceId: '', customerId: '', salesInvoiceId: '', mappedTo1102: '', mappedTo1101: '', unmapped: '', dangling: '' },
  };
  const idOf = (k: Key) => (k === 'A' ? h.companyAId : h.companyBId);
  const dsOf = (k: Key) => h.connections.getDataSource(idOf(k));

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'D2 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `d2-${idOf(k)}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);

    // chart: TWO accounts carry the `bank` control function on purpose
    for (const [code, name, type, normal, fn] of [
      ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'],
      ['1102', 'Bank', 'asset', 'debit', 'bank'],
      ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'],
      ['2101', 'Accounts Payable', 'liability', 'credit', 'ap'],
    ]) {
      await ds.query(
        `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`,
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
    await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);

    // treasury accounts: mapped→1102, mapped→1101, unmapped, mapped→a code NOT in the chart (dangling)
    const types = await treasury.listAccountTypes(ds.manager);
    const bankType = types.find((t) => t.code === 'bank')!;
    const mk = async (code: string, gl: string | null) => {
      const a = await treasury.createAccount(`${code}-${k}`, `${code} ${k}`, bankType.id, actor, ds.manager);
      if (gl) await treasury.setAccountGlMapping(a.id, gl, actor, ds.manager);
      await treasury.cashIn(a.id, '5000.00', null, null, null, 'D2 funding', actor, ds.manager); // non-emitting funding
      return a.id;
    };
    ctx[k].mappedTo1102 = await mk('BANK1102', '1102');
    ctx[k].mappedTo1101 = await mk('CASH1101', '1101');
    ctx[k].unmapped = await mk('UNMAPPED', null);
    ctx[k].dangling = await mk('DANGLING', '9999');

    // AP side: supplier + received PO + posted supplier invoice (1,500.00)
    const warehouseId = randomUUID();
    const supplierId = randomUUID();
    const poId = randomUUID();
    const invoiceId = randomUUID();
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,'D2 WH','active')`, [warehouseId, `D2-${k}`]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,$2,'D2 Supplier')`, [supplierId, `D2-SUP-${k}`]);
    await ds.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId") VALUES ($1,$2,$3,$4)`, [poId, `D2-PO-${k}`, supplierId, warehouseId]);
    await ds.query(`INSERT INTO "supplier_invoices" ("id","invoiceNumber","supplierId","purchaseOrderId","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,'1500.00',$5)`, [invoiceId, `D2-SINV-${k}`, supplierId, poId, actor]);
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'supplier_invoice_lifecycle','supplier_invoice',$2,'posted')`, [randomUUID(), invoiceId]);
    ctx[k].supplierId = supplierId;
    ctx[k].supplierInvoiceId = invoiceId;

    // AR side: customer + posted sales invoice (900.00)
    const customerId = randomUUID();
    const salesInvoiceId = randomUUID();
    await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,$2,'D2 Customer','100000.00')`, [customerId, `D2-CUST-${k}`]);
    await ds.query(
      `INSERT INTO "sales_invoices" ("id","invoiceNumber","customerId","salesOrderId","subtotal","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,'900.00','900.00',$5)`,
      [salesInvoiceId, `D2-INV-${k}`, customerId, randomUUID(), actor],
    );
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'sales_invoice_lifecycle','sales_invoice',$2,'posted')`, [randomUUID(), salesInvoiceId]);
    ctx[k].customerId = customerId;
    ctx[k].salesInvoiceId = salesInvoiceId;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'd2_bank_leg', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const config = { get: () => undefined } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
    new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config).onModuleInit();

    treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    const supplierLedger = new SupplierLedgerService(h.controlPlane, numbering, audit);
    const supplierInvoices = new SupplierInvoiceService(h.controlPlane, numbering, processEngine, audit, supplierLedger, events);
    supplierPayments = new SupplierPaymentService(h.controlPlane, numbering, audit, treasury, supplierLedger, supplierInvoices, events);

    const dsA = await dsOf('A');
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const customers = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
    const customerLedger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    const invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, inert, customers, customerLedger, events, inert);
    customerPayments = new PaymentsService(h.controlPlane, numbering, audit, treasury, customerLedger, invoices, events, customers);

    await seed('A');
    await seed('B');
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('D2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  /** Every row a payment could leave behind, per Company — the "zero side effects" fingerprint. */
  async function fingerprint(k: Key) {
    const ds = await dsOf(k);
    const n = async (sql: string) => Number((await ds.query(sql))[0].n);
    return {
      treasuryTxns: await n(`SELECT count(*) AS n FROM "treasury_transactions"`),
      supplierPayments: await n(`SELECT count(*) AS n FROM "supplier_payments"`),
      supplierLedger: await n(`SELECT count(*) AS n FROM "supplier_ledger_entries"`),
      customerPayments: await n(`SELECT count(*) AS n FROM "customer_payments"`),
      customerLedger: await n(`SELECT count(*) AS n FROM "customer_ledger_entries"`),
      financialEvents: await n(`SELECT count(*) AS n FROM "accounting_financial_events"`),
      journals: await n(`SELECT count(*) AS n FROM "accounting_journal_entries"`),
      outbox: await n(`SELECT count(*) AS n FROM "event_outbox"`),
    };
  }

  /** The GL lines the financial event for a given source entity produced, as `code D/C amount` strings. */
  async function glLines(k: Key, sourceEntityId: string): Promise<{ status: string; lines: string[] } | null> {
    const ds = await dsOf(k);
    const ev: Array<{ status: string; journalEntryId: string | null }> = await ds.query(`SELECT status, "journalEntryId" FROM "accounting_financial_events" WHERE "sourceEntityId" = $1`, [sourceEntityId]);
    if (ev.length === 0) return null;
    if (!ev[0].journalEntryId) return { status: ev[0].status, lines: [] };
    const rows: Array<{ code: string; dr: string; cr: string }> = await ds.query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [ev[0].journalEntryId],
    );
    return { status: ev[0].status, lines: rows.map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`)) };
  }

  const paySupplier = async (k: Key, accountId: string, amount: string) => {
    const ds = await dsOf(k);
    return supplierPayments.recordPayment(ctx[k].supplierId, ctx[k].supplierInvoiceId, amount, 'bank_transfer', accountId, null, actor, ds.manager);
  };
  const payCustomer = async (k: Key, accountId: string, amount: string) => {
    const ds = await dsOf(k);
    return customerPayments.recordPayment(ctx[k].customerId, ctx[k].salesInvoiceId, amount, 'bank_transfer', accountId, null, actor, ds.manager);
  };

  it('SUPPLIER payment from an account mapped to 1102 credits 1102 (NOT the first bank control account 1101) and debits AP — in Company A only', async () => {
    const bBefore = await fingerprint('B');
    let p!: { id: string };
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      p = await paySupplier('A', ctx.A.mappedTo1102, '100.00');
    });
    expect(await glLines('A', p.id)).toEqual({ status: 'POSTED', lines: ['1102 C 100.00', '2101 D 100.00'] });
    expect(await fingerprint('B')).toEqual(bBefore); // Company B untouched
  });

  it('SUPPLIER payment from an account mapped to 1101 credits 1101 — the account follows the paying Treasury account, not DB order', async () => {
    const p = await paySupplier('A', ctx.A.mappedTo1101, '50.00');
    expect(await glLines('A', p.id)).toEqual({ status: 'POSTED', lines: ['1101 C 50.00', '2101 D 50.00'] });
  });

  it('SUPPLIER payment from an UNMAPPED account is rejected BEFORE any mutation — zero treasury / payment / ledger / event / journal / outbox rows, invoice state unchanged', async () => {
    const before = await fingerprint('A');
    const stateBefore = (await (await dsOf('A')).query(`SELECT "currentState" FROM "process_instances" WHERE "entityId" = $1 AND "entityType" = 'supplier_invoice'`, [ctx.A.supplierInvoiceId]))[0].currentState;

    await expect(paySupplier('A', ctx.A.unmapped, '10.00')).rejects.toThrow(/not GL-mapped/);

    expect(await fingerprint('A')).toEqual(before);
    const stateAfter = (await (await dsOf('A')).query(`SELECT "currentState" FROM "process_instances" WHERE "entityId" = $1 AND "entityType" = 'supplier_invoice'`, [ctx.A.supplierInvoiceId]))[0].currentState;
    expect(stateAfter).toBe(stateBefore);
  });

  it('Company B: its own mapped account posts in B only; A is unchanged (A/B isolation of the bank leg)', async () => {
    const aBefore = await fingerprint('A');
    const p = await paySupplier('B', ctx.B.mappedTo1102, '70.00');
    expect(await glLines('B', p.id)).toEqual({ status: 'POSTED', lines: ['1102 C 70.00', '2101 D 70.00'] });
    expect(await fingerprint('A')).toEqual(aBefore);
  });

  it('CUSTOMER payment into an account mapped to 1102 debits 1102 (not 1101) and credits AR; an UNMAPPED account is rejected with zero side effects', async () => {
    const p = await payCustomer('A', ctx.A.mappedTo1102, '200.00');
    expect(await glLines('A', p.id)).toEqual({ status: 'POSTED', lines: ['1102 D 200.00', '1110 C 200.00'] });

    const before = await fingerprint('A');
    await expect(payCustomer('A', ctx.A.unmapped, '10.00')).rejects.toThrow(/not GL-mapped/);
    expect(await fingerprint('A')).toEqual(before);
  });

  it('a mapped code that is NOT in the chart fails closed at the Financial Event (REJECTED, no journal) — never silently falls back to another bank account', async () => {
    const p = await paySupplier('A', ctx.A.dangling, '5.00');
    const event = await glLines('A', p.id);
    expect(event).toEqual({ status: 'REJECTED', lines: [] });
    const reason = (await (await dsOf('A')).query(`SELECT "rejectionReason" FROM "accounting_financial_events" WHERE "sourceEntityId" = $1`, [p.id]))[0].rejectionReason as string;
    expect(reason).toMatch(/not GL-mapped to an active chart account/);
  });

  it('the Platform/control-plane DB was never used (no outbox rows there)', async () => {
    expect(Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n)).toBe(0);
  });
});

