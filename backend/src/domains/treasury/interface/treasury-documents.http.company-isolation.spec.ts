import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TreasuryService } from '../application/treasury.service';
import { TreasuryDocumentService } from '../application/treasury-document.service';
import { TreasuryController } from './treasury.controller';
import { TreasuryDocumentsController } from './treasury-documents.controller';
import { BankStatementsController, CashSessionsController } from './bank-statements.controller';
import { BankStatementService } from '../application/bank-statement.service';
import { CashSessionService } from '../application/cash-session.service';
import { PaymentsController } from '../../customer-finance/interface/payments.controller';
import { PaymentsService } from '../../customer-finance/application/payments.service';
import { CustomersService } from '../../crm/application/customers.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../accounting/application/journal-entry.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../accounting/application/financial-events/handler-registry';
import { GLAccountService } from '../../accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../accounting/application/fiscal-period.service';
import { CurrencyService } from '../../accounting/application/currency.service';
import { FinancialDimensionService } from '../../accounting/application/financial-dimension.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard } from '../../../foundation/company/company-context.guard';
import { AllExceptionsFilter } from '../../../foundation/error-contract/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from '../../../foundation/error-contract/response-envelope.interceptor';
import { IdempotencyService } from '../../../foundation/error-contract/idempotency.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuthorizationContextService } from '../../../foundation/authorization/authorization-context.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { RolePermission } from '../../../foundation/permission/role-permission.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
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
import { FINANCE_COLLECTION_CONTRACT } from '../../../foundation/module-registry/contracts/collection.contract';
import { SALES_CUSTOMERS_CONTRACT } from '../../../foundation/module-registry/contracts/sales.contract';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/* eslint-disable @typescript-eslint/no-require-imports */
const request = require('supertest');

/**
 * T4/T6 (2026-10-20) — the Treasury Documents, generic cash and payment-reversal routes exercised OVER HTTP through the real controllers, the real PermissionGuard (real
 * role grants in a real PostgreSQL), the production ValidationPipe settings (whitelist + forbidNonWhitelisted), the AllExceptionsFilter and the response envelope.
 * Only authentication and Company-context resolution are test doubles (headers choose the user and the Company) — the same boundary the T-09 HTTP spec uses.
 * Proves: the per-stage permissions are enforced SERVER-side (a missing grant is a 404, never a silently allowed action), invalid / unknown body fields are refused,
 * separation of duties holds through the API, the idempotency header and the status machine make replays harmless, and Company B cannot see Company A's documents.
 */
describe('Treasury Documents — HTTP, real guards, real PostgreSQL, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const cfg: Record<string, unknown> = {};
  const year = new Date().toISOString().slice(0, 4);
  const u = { stmtImporter: '', stmtMatcher: '', sessOpener: '', sessCloser: '', viewerNone: '', prep: '', approver: '', makerApprover: '', exec: '', canceller: '', reverser: '', payRev: '', payCreate: '' };
  let acc = { cash: '', bank: '', customerId: '' };
  let dsA: DataSource;

  async function mkUser(name: string, nodes: Array<[string, 'read-only' | 'editable']>): Promise<string> {
    const id = randomUUID();
    await dsA.query(`INSERT INTO users (id, "fullName", email) VALUES ($1,$2,$3)`, [id, name, `${name}-${id.slice(0, 6)}@http.local`]);
    if (nodes.length > 0) {
      const roleId = randomUUID();
      await dsA.query(`INSERT INTO roles (id, key) VALUES ($1,$2)`, [roleId, `r-${name}-${id.slice(0, 6)}`]);
      for (const [node, access] of nodes) await dsA.query(`INSERT INTO role_permissions (id, "roleId", "nodeKey", access) VALUES ($1,$2,$3,$4)`, [randomUUID(), roleId, node, access]);
      await dsA.query(`INSERT INTO user_roles (id, "userId", "roleId") VALUES ($1,$2,$3)`, [randomUUID(), id, roleId]);
    }
    return id;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 't4_http', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
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
    const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const customers = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
    const customerLedger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    const invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, inert, customers, customerLedger, events, inert);
    const payments = new PaymentsService(h.controlPlane, numbering, audit, treasury, customerLedger, invoices, events, customers);
    const approvals = new ApprovalEngineService(ambient, new ProcessEngineService(ambient), new AuditService(ambient), events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    const docs = new TreasuryDocumentService(h.controlPlane, treasury, numbering, audit, events, approvals, config, payments);
    await docs.onModuleInit();
    const idempotency = new IdempotencyService(h.controlPlane);

    // ---- chart, period, accounts, customer (Company A)
    for (const [code, name, type, normal, fn] of [
      ['1101', 'Cash', 'asset', 'debit', 'bank'], ['1102', 'Bank', 'asset', 'debit', 'bank'], ['1110', 'AR', 'asset', 'debit', 'ar'], ['4900', 'Other income', 'revenue', 'credit', null], ['3999', 'Clearing', 'asset', 'debit', null],
    ] as const) {
      await dsA.query(`INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`, [randomUUID(), code, name, type, normal, fn]);
    }
    const fy = randomUUID(); const fp = randomUUID();
    await dsA.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await dsA.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await dsA.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`, [randomUUID(), fy, randomUUID(), fp]);
    await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, dsA.manager);
    const sys = randomUUID();
    await dsA.query(`INSERT INTO users (id, "fullName", email) VALUES ($1,'sys',$2)`, [sys, `sys-${sys.slice(0, 6)}@http.local`]);
    const types = await treasury.listAccountTypes(dsA.manager);
    const mk = async (code: string, type: string, gl: string) => { const a = await treasury.createAccount(code, code, types.find((t) => t.code === type)!.id, sys, dsA.manager); await treasury.setAccountGlMapping(a.id, gl, sys, dsA.manager); return a.id; };
    acc = { cash: await mk('HCASH', 'cash', '1101'), bank: await mk('HBANK', 'bank', '1102'), customerId: randomUUID() };
    await dsA.query(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,'HTTP-C','HTTP Customer','100000.00')`, [acc.customerId]);
    cfg['accounting.treasury_receipt_reason_accounts'] = { OTHER_INCOME: '4900' };
    cfg['accounting.cash_movement_clearing_account_code'] = '3999';

    // ---- users with exactly the grants a real role would carry (nothing inherited from `finance` here: each node is granted explicitly)
    u.viewerNone = await mkUser('viewer-none', []);
    u.prep = await mkUser('prep', [['finance.cash_document.view', 'read-only'], ['finance.cash_document.create', 'editable'], ['finance.cash_document.submit', 'editable']]);
    u.approver = await mkUser('approver', [['finance.cash_document.view', 'read-only'], ['finance.cash_document.approve', 'editable']]);
    u.makerApprover = await mkUser('maker-approver', [['finance.cash_document.view', 'read-only'], ['finance.cash_document.create', 'editable'], ['finance.cash_document.submit', 'editable'], ['finance.cash_document.approve', 'editable']]);
    u.exec = await mkUser('exec', [['finance.cash_document.view', 'read-only'], ['finance.cash_document.execute', 'editable']]);
    u.canceller = await mkUser('canceller', [['finance.cash_document.view', 'read-only'], ['finance.cash_document.cancel', 'editable']]);
    u.reverser = await mkUser('reverser', [['finance.cash_document.view', 'read-only'], ['finance.cash_document.reverse', 'editable']]);
    u.stmtImporter = await mkUser('stmt-importer', [['finance.bank_statement.view', 'read-only'], ['finance.bank_statement.import', 'editable']]);
    u.stmtMatcher = await mkUser('stmt-matcher', [['finance.bank_statement.view', 'read-only'], ['finance.bank_statement.match', 'editable']]);
    u.sessOpener = await mkUser('sess-opener', [['finance.cash_session.view', 'read-only'], ['finance.cash_session.open', 'editable']]);
    u.sessCloser = await mkUser('sess-closer', [['finance.cash_session.view', 'read-only'], ['finance.cash_session.close', 'editable']]);
    u.payRev = await mkUser('payrev', [['finance.payment.reverse', 'editable']]);
    u.payCreate = await mkUser('paycreate', [['finance.payment.create', 'editable'], ['finance.cash.post', 'editable']]);
    // the customer-scope lookup of the payment routes passes through the admin role (their negative permission cases use users that are NOT admin)
    await dsA.query(`INSERT INTO roles (id, key) VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const adminRole: Array<{ id: string }> = await dsA.query(`SELECT id FROM roles WHERE key = 'admin'`);
    for (const uid of [u.payCreate, u.payRev]) await dsA.query(`INSERT INTO user_roles (id, "userId", "roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), uid, adminRole[0].id]);

    const contexts = new AuthorizationContextService(h.controlPlane);
    const permission = new PermissionService(h.controlPlane.getRepository(RolePermission), authorization);
    const moduleRef = await Test.createTestingModule({
      controllers: [TreasuryController, TreasuryDocumentsController, PaymentsController, BankStatementsController, CashSessionsController],
      providers: [
        { provide: TreasuryService, useValue: treasury },
        { provide: TreasuryDocumentService, useValue: docs },
        { provide: BankStatementService, useValue: new BankStatementService(h.controlPlane, treasury, numbering, audit) },
        { provide: CashSessionService, useValue: new CashSessionService(h.controlPlane, treasury, docs, numbering, audit) },
        { provide: PaymentsService, useValue: payments },
        { provide: FINANCE_COLLECTION_CONTRACT, useValue: payments },
        { provide: SALES_CUSTOMERS_CONTRACT, useValue: customers },
        { provide: IdempotencyService, useValue: idempotency },
        { provide: EventBusService, useValue: events },
        { provide: PermissionService, useValue: permission },
        { provide: AuthorizationContextService, useValue: contexts },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue({
        canActivate: (ctx: { switchToHttp(): { getRequest(): any } }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const req = ctx.switchToHttp().getRequest();
          const uid = req.headers['x-test-user'];
          if (!uid) return false;
          req.user = { id: uid, email: `${uid}@http.local` };
          return true;
        },
      })
      .overrideGuard(CompanyContextGuard).useValue({
        canActivate: (ctx: { switchToHttp(): { getRequest(): any } }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const req = ctx.switchToHttp().getRequest();
          const company = req.headers['x-test-company'] === 'B' ? { id: h.companyBId, ds: dsB } : { id: h.companyAId, ds: dsA };
          req.companyContext = { companyId: company.id, dataSource: company.ds };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('HTTP teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const call = (method: 'get' | 'post' | 'put', path: string, user: string, body?: unknown, extra: Record<string, string> = {}) => {
    let r = request(http)[method](`/api${path}`).set('x-test-user', user).set('x-test-company', extra['x-test-company'] ?? 'A');
    for (const [k, v] of Object.entries(extra)) if (k !== 'x-test-company') r = r.set(k, v);
    return body === undefined ? r : r.send(body);
  };
  const receipt = (amount = '40.00') => ({ kind: 'misc_receipt', treasuryAccountId: acc.cash, amount, reasonCode: 'OTHER_INCOME', reference: 'HTTP-1', purpose: 'HTTP receipt' });
  async function count(sql: string): Promise<number> { return Number((await dsA.query(sql))[0].n); }

  it('H1 a user with NO grant is refused on every Treasury Documents route (404, the guard never reveals the route) and nothing is written', async () => {
    const before = await count(`SELECT count(*) AS n FROM treasury_documents`);
    for (const [m, p] of [['get', '/treasury/documents'], ['get', '/treasury/documents/reason-codes'], ['post', '/treasury/documents']] as const) {
      const r = await call(m, p, u.viewerNone, m === 'post' ? receipt() : undefined);
      expect(r.status).toBe(404);
    }
    expect(await count(`SELECT count(*) AS n FROM treasury_documents`)).toBe(before);
  });

  it('H2 preparer: valid draft is created (envelope), unknown fields / bad amount / missing purpose are refused with 400; reason codes expose codes only', async () => {
    const ok = await call('post', '/treasury/documents', u.prep, receipt());
    expect(ok.status).toBe(201);
    expect(ok.body.success).toBe(true);
    expect(ok.body.data.status).toBe('draft');
    expect(ok.body.data.documentNumber).toMatch(/^TD/);
    expect((await call('post', '/treasury/documents', u.prep, { ...receipt(), glAccountCode: '4900' })).status).toBe(400); // an account can never be supplied
    expect((await call('post', '/treasury/documents', u.prep, { ...receipt(), amount: 'abc' })).status).toBe(400);
    const noPurpose = await call('post', '/treasury/documents', u.prep, { ...receipt(), purpose: '' });
    expect(noPurpose.status).toBe(400);
    expect(noPurpose.body.error.message).toMatch(/purpose/i);
    const codes = await call('get', '/treasury/documents/reason-codes', u.prep);
    expect(codes.status).toBe(200);
    expect(codes.body.data).toEqual({ receipt: ['OTHER_INCOME'], disbursement: [] });
  });

  it('H3 lifecycle over HTTP with separate people: submit (preparer) → decide (approver) → execute (executor); each action refused for a user who lacks THAT node', async () => {
    const created = (await call('post', '/treasury/documents', u.prep, receipt('55.00'))).body.data;
    expect((await call('post', `/treasury/documents/${created.id}/execute`, u.exec, {})).status).toBe(409); // not approved yet
    expect((await call('post', `/treasury/documents/${created.id}/submit`, u.approver, {})).status).toBe(404); // approver has no submit node
    const sub = await call('post', `/treasury/documents/${created.id}/submit`, u.prep, { expectedVersion: created.version });
    expect(sub.status).toBe(201);
    expect(sub.body.data.status).toBe('submitted');
    expect((await call('post', `/treasury/documents/${created.id}/decide`, u.prep, { decision: 'approved' })).status).toBe(404); // preparer lacks the approve node
    const dec = await call('post', `/treasury/documents/${created.id}/decide`, u.approver, { decision: 'approved' });
    expect(dec.status).toBe(201);
    expect(dec.body.data.status).toBe('approved');
    expect((await call('post', `/treasury/documents/${created.id}/execute`, u.prep, {})).status).toBe(404); // preparer lacks the execute node
    const before = await count(`SELECT count(*) AS n FROM treasury_transactions`);
    const ex = await call('post', `/treasury/documents/${created.id}/execute`, u.exec, { expectedVersion: dec.body.data.version });
    expect(ex.status).toBe(201);
    expect(ex.body.data.status).toBe('executed');
    expect(await count(`SELECT count(*) AS n FROM treasury_transactions`)).toBe(before + 1);
    const again = await call('post', `/treasury/documents/${created.id}/execute`, u.exec, {}, { 'idempotency-key': 'http-exec-1' });
    expect(again.status).toBe(201); // already executed: replay is harmless
    expect(await count(`SELECT count(*) AS n FROM treasury_transactions`)).toBe(before + 1);
    const effect = await call('get', `/treasury/documents/${created.id}/effect`, u.exec);
    expect(effect.status).toBe(200);
    expect(effect.body.data.lines.map((l: { side: string; glAccountCode: string }) => `${l.side}:${l.glAccountCode}`)).toEqual(['debit:1101', 'credit:4900']);
  });

  it('H4 separation of duties through the API: a user who holds BOTH create and approve cannot approve their own document (403); stale version and extra fields are refused', async () => {
    const created = (await call('post', '/treasury/documents', u.makerApprover, receipt('21.00'))).body.data;
    await call('post', `/treasury/documents/${created.id}/submit`, u.makerApprover, {});
    const self = await call('post', `/treasury/documents/${created.id}/decide`, u.makerApprover, { decision: 'approved' });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toMatch(/maker of an approval request/);
    expect((await call('post', `/treasury/documents/${created.id}/cancel`, u.canceller, { reason: 'x', expectedVersion: 1 })).status).toBe(400); // unknown field is refused by the API
    const stale = (await call('post', '/treasury/documents', u.prep, receipt('22.00'))).body.data;
    expect((await call('post', `/treasury/documents/${stale.id}/submit`, u.prep, { expectedVersion: stale.version + 3 })).status).toBe(409);
    const rejected = await call('post', `/treasury/documents/${created.id}/decide`, u.approver, { decision: 'rejected', note: 'unclear' });
    expect(rejected.status).toBe(201);
    expect(rejected.body.data.status).toBe('rejected');
  });

  it('H5 cancel and reverse: own node each; reverse needs a reason; the UI payload shape ({reason}) is accepted', async () => {
    const d = (await call('post', '/treasury/documents', u.prep, receipt('33.00'))).body.data;
    expect((await call('post', `/treasury/documents/${d.id}/cancel`, u.prep, { reason: 'mistake' })).status).toBe(404); // preparer has no cancel node
    const c = await call('post', `/treasury/documents/${d.id}/cancel`, u.canceller, { reason: 'mistake' });
    expect(c.status).toBe(201);
    expect(c.body.data.status).toBe('cancelled');
    expect((await call('post', `/treasury/documents/${d.id}/cancel`, u.canceller, {})).status).toBe(400); // reason is mandatory

    const e = (await call('post', '/treasury/documents', u.prep, receipt('44.00'))).body.data;
    await call('post', `/treasury/documents/${e.id}/submit`, u.prep, {});
    await call('post', `/treasury/documents/${e.id}/decide`, u.approver, { decision: 'approved' });
    await call('post', `/treasury/documents/${e.id}/execute`, u.exec, {});
    expect((await call('post', `/treasury/documents/${e.id}/reverse`, u.exec, { reason: 'dup' })).status).toBe(404);
    const rev = await call('post', `/treasury/documents/${e.id}/reverse`, u.reverser, { reason: 'duplicate entry' });
    expect(rev.status).toBe(201);
    expect(rev.body.data.status).toBe('reversed');
  });

  it('H6 generic cash-in over HTTP: a customer label is 422, missing reason/reference 400, a compliant call is 201 and the SAME Idempotency-Key replays without a second leg', async () => {
    const base = { accountId: acc.cash, amount: '9.00', reason: 'Petty cash top-up', reference: 'PC-1' };
    expect((await call('post', '/treasury/cash-in', u.payCreate, { ...base, customerId: acc.customerId })).status).toBe(422);
    expect((await call('post', '/treasury/cash-in', u.payCreate, { ...base, reason: undefined })).status).toBe(400);
    const before = await count(`SELECT count(*) AS n FROM treasury_transactions`);
    const first = await call('post', '/treasury/cash-in', u.payCreate, base, { 'idempotency-key': 'http-cashin-1' });
    const second = await call('post', '/treasury/cash-in', u.payCreate, base, { 'idempotency-key': 'http-cashin-1' });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await count(`SELECT count(*) AS n FROM treasury_transactions`)).toBe(before + 1);
    expect((await call('post', '/treasury/cash-in', u.viewerNone, base)).status).toBe(404); // no finance.cash.post
  });

  it('H7 payment reversal over HTTP needs finance.payment.reverse; a second reversal is 409; the raw Treasury reverse of the payment leg is 409', async () => {
    const ds = dsA;
    const invId = randomUUID();
    await ds.query(`INSERT INTO "sales_invoices" ("id","invoiceNumber","customerId","salesOrderId","subtotal","totalAmount","createdByUserId") VALUES ($1,'HTTP-INV',$2,$3,'100.00','100.00',$4)`, [invId, acc.customerId, randomUUID(), u.payCreate]);
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'sales_invoice_lifecycle','sales_invoice',$2,'posted')`, [randomUUID(), invId]);
    const pay = await call('post', '/payments', u.payCreate, { customerId: acc.customerId, invoiceId: invId, amount: '100.00', method: 'cash', treasuryAccountId: acc.cash });
    expect(pay.status).toBe(201);
    const pid = pay.body.data.id;
    expect((await call('post', `/payments/${pid}/reverse`, u.canceller, { reason: 'wrong customer' })).status).toBe(404); // holds other Treasury nodes but not finance.payment.reverse
    const rev = await call('post', `/payments/${pid}/reverse`, u.payRev, { reason: 'wrong customer' });
    expect(rev.status).toBe(201);
    expect(rev.body.data.reversalNumber).toMatch(/^PREV/);
    const twice = await call('post', `/payments/${pid}/reverse`, u.payRev, { reason: 'again' });
    expect(twice.status).toBe(409);
    expect((await call('post', `/payments/${pid}/reverse`, u.payRev, {})).status).toBe(400);
  });

  it('H8 Company isolation over HTTP: Company A\'s document is invisible under Company B (404) and Company B cannot act on it', async () => {
    const d = (await call('post', '/treasury/documents', u.prep, receipt('12.00'))).body.data;
    const asB = await call('get', `/treasury/documents/${d.id}`, u.prep, undefined, { 'x-test-company': 'B' });
    expect([404]).toContain(asB.status);
    const listB = await call('get', '/treasury/documents', u.prep, undefined, { 'x-test-company': 'B' });
    expect([200, 404]).toContain(listB.status);
    if (listB.status === 200) expect(listB.body.data).toEqual([]);
  });
  it('H9 bank statements over HTTP: import needs its own node, the body is validated (unknown field / bad amount 400), a duplicate file is 409, matching and reconciling need THEIR nodes', async () => {
    const body = { treasuryAccountId: acc.bank, statementNumber: 'HTTP-1', periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalance: '0.00', closingBalance: '100.00', lines: [{ valueDate: '2026-01-15', reference: 'X-1', description: 'deposit', amount: '100.00' }] };
    expect((await call('post', '/treasury/bank-statements', u.viewerNone, body)).status).toBe(404);
    expect((await call('post', '/treasury/bank-statements', u.stmtMatcher, body)).status).toBe(404); // may match, may not import
    expect((await call('post', '/treasury/bank-statements', u.stmtImporter, { ...body, internalNote: 'x' })).status).toBe(400);
    expect((await call('post', '/treasury/bank-statements', u.stmtImporter, { ...body, lines: [{ ...body.lines[0], amount: 'abc' }] })).status).toBe(400);
    const sumWrong = await call('post', '/treasury/bank-statements', u.stmtImporter, { ...body, closingBalance: '99.00' });
    expect(sumWrong.status).toBe(400);
    expect(sumWrong.body.error.message).toMatch(/does not add up/);
    const ok = await call('post', '/treasury/bank-statements', u.stmtImporter, body, { 'idempotency-key': 'http-stmt-1' });
    expect(ok.status).toBe(201);
    const again = await call('post', '/treasury/bank-statements', u.stmtImporter, body);
    expect(again.status).toBe(409);
    const id = ok.body.data.id;
    expect((await call('post', `/treasury/bank-statements/${id}/suggest`, u.stmtImporter, {})).status).toBe(404); // importer cannot match
    expect((await call('post', `/treasury/bank-statements/${id}/suggest`, u.stmtMatcher, {})).status).toBe(201);
    expect((await call('post', `/treasury/bank-statements/${id}/reconcile`, u.stmtMatcher, {})).status).toBe(404); // matcher cannot reconcile
    const view = await call('get', `/treasury/bank-statements/${id}/reconciliation`, u.stmtMatcher);
    expect(view.status).toBe(200);
    expect(view.body.data.unmatchedLines).toHaveLength(1);
  });

  it('H10 cash sessions over HTTP: open and close are separate permissions; a count with a variance needs a reason (400); the response is the envelope', async () => {
    expect((await call('post', '/treasury/cash-sessions', u.sessCloser, { treasuryAccountId: acc.cash })).status).toBe(404);
    const opened = await call('post', '/treasury/cash-sessions', u.sessOpener, { treasuryAccountId: acc.cash });
    expect(opened.status).toBe(201);
    expect(opened.body.data.status).toBe('open');
    const id = opened.body.data.id;
    expect((await call('post', `/treasury/cash-sessions/${id}/close`, u.sessOpener, { countedAmount: '1.00' })).status).toBe(404);
    const variance = await call('post', `/treasury/cash-sessions/${id}/close`, u.sessCloser, { countedAmount: '999.00' });
    expect(variance.status).toBe(400);
    expect(variance.body.error.message).toMatch(/reason for the variance is required/);
    const bal = (await dsA.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('cash_in','transfer_in') THEN amount ELSE -amount END),0)::numeric(20,2)::text AS b FROM treasury_transactions WHERE "treasuryAccountId" = $1`, [acc.cash]))[0].b;
    const closed = await call('post', `/treasury/cash-sessions/${id}/close`, u.sessCloser, { countedAmount: bal });
    expect(closed.status).toBe(201);
    expect(closed.body.data).toMatchObject({ status: 'closed', variance: '0.00' });
    expect((await call('get', '/treasury/cash-sessions', u.viewerNone)).status).toBe(404);
  });
});
