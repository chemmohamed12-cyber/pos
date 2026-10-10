import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { BizEnv, setUpBiz } from './biz-support';
import { TreasuryService } from '../../domains/treasury/application/treasury.service';
import { PaymentsService } from '../../domains/customer-finance/application/payments.service';
import { CustomersService } from '../../domains/crm/application/customers.service';
import { CustomerLedgerService } from '../../domains/customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../domains/customer-finance/application/invoices.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../domains/accounting/application/journal-entry.service';
import { FinancialEventService } from '../../domains/accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../domains/accounting/application/financial-events/handler-registry';
import { GLAccountService } from '../../domains/accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../domains/accounting/application/fiscal-period.service';
import { CurrencyService } from '../../domains/accounting/application/currency.service';
import { FinancialDimensionService } from '../../domains/accounting/application/financial-dimension.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { EventBusService } from '../events/event-bus.service';
import { ProcessEngineService } from '../process-engine/process-engine.service';
import { ConfigurationEngineService } from '../configuration-engine/configuration-engine.service';
import { IdempotencyService } from '../error-contract/idempotency.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';

/**
 * Finance wiring for the business-test program — the same real service graph the D2 / on-account specs build (real event bus, real
 * financial-event engine, real journal engine), on the biz disposable databases. Test infrastructure only.
 */
export interface FinEnv extends BizEnv {
  warehouseId: string;
  treasury: TreasuryService;
  payments: PaymentsService;
  idempotency: IdempotencyService;
  events: EventBusService;
  bankAccountId: string; // mapped to GL 1102
  /** the live accounting configuration the financial-event engine reads (fixture only — tests may unset a key to provoke a REJECTED event) */
  cfg: Record<string, unknown>;
  customerId: string;
}

export const FIN_TABLES_NOTE = 'fingerprints use the shared FINGERPRINT_TABLES list';

export async function setUpFinance(testId: string, prefix: string): Promise<FinEnv> {
  const base = await setUpBiz(testId, prefix);
  const { h, dsA, actor } = base;
  const inert = {} as never;
  const audit = new AuditService(h.controlPlane);
  const numbering = new NumberingService(h.controlPlane);
  const events = new EventBusService(inert, h.connections);
  const processEngine = new ProcessEngineService(h.controlPlane);
  // accounting configuration required by the cash-movement event handler: a postable, NON-control clearing account (fixture, not a criterion)
  const cfg: Record<string, unknown> = { 'accounting.cash_movement_clearing_account_code': '1199' };
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigurationEngineService;
  const currencies = new CurrencyService(h.controlPlane, audit);
  const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
  const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
  const dimensions = new FinancialDimensionService(h.controlPlane, audit);
  const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
  new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config).onModuleInit();

  // chart + fiscal calendar + journal numbering (as the D2 / on-account specs)
  const year = new Date().toISOString().slice(0, 4);
  for (const [code, name, type, normal, fn] of [
    ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'], ['1102', 'Bank', 'asset', 'debit', 'bank'], ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'], ['2101', 'Accounts Payable', 'liability', 'credit', 'ap'],
    ['1199', 'Cash Movement Clearing', 'asset', 'debit', null],
  ]) {
    await dsA.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`,
      [randomUUID(), code, name, type, normal, fn],
    );
  }
  const fy = randomUUID();
  const fpId = randomUUID();
  await dsA.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
  await dsA.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fpId, fy, `${year}-01-01`, `${year}-12-31`]);
  await dsA.query(
    `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
    [randomUUID(), fy, randomUUID(), fpId],
  );
  await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, dsA.manager);

  const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
  const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
  const customers = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
  const customerLedger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
  const invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, inert, customers, customerLedger, events, inert);
  const payments = new PaymentsService(h.controlPlane, numbering, audit, treasury, customerLedger, invoices, events, customers);
  const idempotency = new IdempotencyService(h.controlPlane);

  const types = await treasury.listAccountTypes(dsA.manager);
  const bankType = types.find((t) => t.code === 'bank')!;
  const acct = await treasury.createAccount('BIZ-BANK-1102', 'Biz Bank', bankType.id, actor, dsA.manager);
  await treasury.setAccountGlMapping(acct.id, '1102', actor, dsA.manager);

  const customerId = randomUUID();
  await dsA.query(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,$2,'Biz Customer','1000000.00')`, [customerId, `BIZ-CUST-${testId}`]);

  return Object.assign(base, { treasury, payments, idempotency, events, bankAccountId: acct.id, customerId, cfg }) as FinEnv;
}

/** A posted sales invoice for the customer (direct seed, same shape as the D2 spec) — returns its id. */
export async function seedPostedInvoice(env: FinEnv, ds: DataSource, amount: string, tag: string): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO "sales_invoices" ("id","invoiceNumber","customerId","salesOrderId","subtotal","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,$5,$5,$6)`,
    [id, `BIZ-INV-${tag}-${id.slice(0, 6)}`, env.customerId, randomUUID(), amount, env.actor],
  );
  await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'sales_invoice_lifecycle','sales_invoice',$2,'posted')`, [randomUUID(), id]);
  return id;
}

/** Journal lines of the financial event produced for a source entity, as `code D|C amount` (null when no event). */
export async function glLinesFor(ds: DataSource, sourceEntityId: string): Promise<{ status: string; lines: string[] } | null> {
  const ev: Array<{ status: string; journalEntryId: string | null }> = await ds.query(`SELECT status, "journalEntryId" FROM "accounting_financial_events" WHERE "sourceEntityId" = $1`, [sourceEntityId]);
  if (ev.length === 0) return null;
  if (!ev[0].journalEntryId) return { status: ev[0].status, lines: [] };
  const rows: Array<{ code: string; dr: string; cr: string }> = await ds.query(
    `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY jl."lineNumber"`,
    [ev[0].journalEntryId],
  );
  return { status: ev[0].status, lines: rows.map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`)) };
}

export const money = (n: number) => n.toFixed(2);
