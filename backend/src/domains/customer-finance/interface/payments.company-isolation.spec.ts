import { randomUUID } from 'crypto';
import { PaymentsService } from '../application/payments.service';
import { CustomersService } from '../../crm/application/customers.service';
import { CustomerLedgerService } from '../application/customer-ledger.service';
import { InvoiceService } from '../application/invoices.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { Payment } from '../infrastructure/payment.entity';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `payments.controller.ts`'s reads/writes are
 * genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct customer,
 * invoice, and payment, never mocked.
 *
 * `recordPayment` is the deep-chain proof: it transitively exercises
 * `TreasuryService.cashIn` (against each Company's own migration-seeded
 * `MAIN-CASH` account — the same pre-seeded-default precedent used
 * throughout this Matrix), `CustomerLedgerService.postEntry`,
 * `InvoiceService.getInvoiceRemaining`/`recomputeStatus`, and
 * `SalesCustomersContract.getCustomer` — the exact manager-threading
 * chain this retrofit's two concrete-gap fixes (`getCustomer`,
 * `registerDocumentType`) closed.
 */
describe('PaymentsController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: PaymentsService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { customerId: string; invoiceId: string; treasuryAccountId: string }> = {
    A: { customerId: '', invoiceId: '', treasuryAccountId: '' },
    B: { customerId: '', invoiceId: '', treasuryAccountId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', customerCode: string) {
    const ds = await h.connections.getDataSource(companyId);
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const salesOrderId = randomUUID();

    // Admin role for `actorUserId` — bypasses `CustomersService.getCustomer`'s
    // REVIEWER_ROLES Scope check, same precedent as
    // `customer-ledger.company-isolation.spec.ts`.
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Admin',
      `iso-admin-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      randomUUID(),
      actorUserId,
      role[0].id,
    ]);

    await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,$2,$3,'1000.00')`, [
      customerId,
      customerCode,
      `${customerCode} Customer`,
    ]);
    await ds.query(
      `INSERT INTO "sales_invoices" ("id","invoiceNumber","customerId","salesOrderId","subtotal","totalAmount","createdByUserId")
       VALUES ($1,$2,$3,$4,'200.00','200.00',$5)`,
      [invoiceId, `INV-${customerCode}`, customerId, salesOrderId, actorUserId],
    );
    // `SALES_INVOICE_PROCESS` starts every invoice at 'draft' — seed
    // 'posted' directly (raw insert, same precedent as the shipment/
    // fulfillment isolation tests seeding a migration-shaped row
    // directly) so `recomputeStatus` has a valid `posted -> *` transition
    // to make, without re-deriving `createDraftInvoice`'s full flow.
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'sales_invoice_lifecycle','sales_invoice',$2,'posted')`,
      [randomUUID(), invoiceId],
    );

    // `MAIN-CASH` — every Company database's own migration-seeded default
    // active treasury account (`SeedDefaultTreasuryAccount`), the same
    // "rely on the migration default, don't hand-roll a new account"
    // precedent `treasury.company-isolation.spec.ts` established.
    const account: Array<{ id: string }> = await ds.query(`SELECT id FROM "treasury_accounts" WHERE "code" = 'MAIN-CASH'`);

    // D2 (2026-10-04): a payment now requires the receiving Treasury account to be GL-mapped (rejected before any mutation otherwise).
    await ds.query(`UPDATE "treasury_accounts" SET "glAccountCode" = '1102' WHERE id = $1`, [account[0].id]);
    seeded[key] = { customerId, invoiceId, treasuryAccountId: account[0].id };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'payments_isolation', extraCompanyTags: ['sales', 'finance'] });
    await seedCompanyData(h.companyAId, 'A', 'CUST-PAY-A');
    await seedCompanyData(h.companyBId, 'B', 'CUST-PAY-B');

    const dsA = await h.connections.getDataSource(h.companyAId);
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const processEngine = new ProcessEngineService(h.controlPlane);
    // Fallback-only construction (every call below supplies its own
    // manager, which always wins) — same precedent as
    // `customer-ledger.company-isolation.spec.ts`.
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const customers = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
    const ledger = new CustomerLedgerService(h.controlPlane, numbering, audit, customers);
    const invoices = new InvoiceService(h.controlPlane, numbering, processEngine, audit, inert, customers, ledger, events, inert);
    const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    service = new PaymentsService(h.controlPlane, numbering, audit, treasury, ledger, invoices, events, customers);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("recordPayment for Company A posts against Company A's own invoice/account inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const payment = await service.recordPayment(
      seeded.A.customerId,
      seeded.A.invoiceId,
      '50.00',
      'cash',
      seeded.A.treasuryAccountId,
      null,
      actorUserId,
      dsA.manager,
    );
    expect(payment.customerId).toBe(seeded.A.customerId);

    const row = await dsA.getRepository(Payment).findOne({ where: { id: payment.id } });
    expect(row).toBeTruthy();
  });

  it("recordPayment for Company B posts independently in Company B's own database — no leakage of Company A's invoice/account", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const payment = await service.recordPayment(
      seeded.B.customerId,
      seeded.B.invoiceId,
      '75.00',
      'cash',
      seeded.B.treasuryAccountId,
      null,
      actorUserId,
      dsB.manager,
    );
    expect(payment.customerId).toBe(seeded.B.customerId);

    const rowInB = await dsB.getRepository(Payment).findOne({ where: { customerId: seeded.A.customerId } });
    expect(rowInB).toBeNull();
  });

  it("listPaymentsForCustomer via Company A resolves only Company A's own payment", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const payments = await service.listPaymentsForCustomer(seeded.A.customerId, dsA.manager);
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe('50.00');
  });

  it("listAllPayments via Company B resolves only Company B's own payment — no leakage of Company A's data", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const payments = await service.listAllPayments(actorUserId, dsB.manager);
    expect(payments.map((p) => p.customerId)).toEqual([seeded.B.customerId]);
  });

  it("Test F — resolving Company A's payments never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listPaymentsForCustomer(seeded.A.customerId, dsA.manager);
      await service.listAllPayments(actorUserId, dsA.manager);
    });
  });
});
