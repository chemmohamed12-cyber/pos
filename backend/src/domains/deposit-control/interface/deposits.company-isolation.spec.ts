import { randomUUID } from 'crypto';
import { DepositsService } from '../application/deposits.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { FinanceInvoiceContract } from '../../../foundation/module-registry/contracts/finance.contract';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { Deposit } from '../infrastructure/deposit.entity';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `deposits.controller.ts`'s reads/writes are
 * genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct customer,
 * Sales Order, and deposit, never mocked.
 *
 * `approveDeposit` is the deep-chain proof: it transitively exercises
 * `TreasuryService.createDepositTransaction` (the concrete gap this
 * retrofit found and fixed) against each Company's own migration-seeded
 * `MAIN-CASH` account, plus `CustomerLedgerService.postEntry`.
 * `SalesOrdersService` and `FinanceInvoiceContract` are stubbed — their
 * own Company-isolation is proven by §16's and §34's/§32's specs; this
 * spec's job is `DepositsService`'s own `deposits` table and its real
 * Treasury/Ledger integration.
 */
describe('DepositsController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: DepositsService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { customerId: string; salesOrderId: string; treasuryAccountId: string }> = {
    A: { customerId: '', salesOrderId: '', treasuryAccountId: '' },
    B: { customerId: '', salesOrderId: '', treasuryAccountId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    const customerId = randomUUID();
    const salesOrderId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Rep',
      `iso-rep-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "customers" ("id","code","name") VALUES ($1,$2,$3)`, [customerId, `CUST-${code}`, `${code} Customer`]);
    await ds.query(`INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount") VALUES ($1,$2,$3,$4,'500.00')`, [
      salesOrderId,
      `SO-DEP-${code}`,
      customerId,
      actorUserId,
    ]);
    const mainCash: Array<{ id: string }> = await ds.query(`SELECT id FROM "treasury_accounts" WHERE "code" = 'MAIN-CASH'`);
    seeded[key] = { customerId, salesOrderId, treasuryAccountId: mainCash[0].id };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'deposits_isolation', extraCompanyTags: ['sales', 'finance'] });
    await seedCompanyData(h.companyAId, 'A', 'A');
    await seedCompanyData(h.companyBId, 'B', 'B');

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    const ledger = new CustomerLedgerService(h.controlPlane, numbering, audit, inert);

    // Stubs — see the file-header note.
    const salesOrders = {
      getOrder: async (orderId: string, _user: string, manager?: { query: (sql: string, p: unknown[]) => Promise<Array<{ customerId: string }>> }) => {
        const rows = await manager!.query(`SELECT "customerId" FROM "sales_orders" WHERE "id" = $1`, [orderId]);
        return { id: orderId, customerId: rows[0].customerId };
      },
      getOrderStatus: async () => 'deposit_verification',
      releaseAfterDepositVerified: async () => 'released',
    } as unknown as SalesOrdersService;
    const invoices = {
      findOpenInvoiceForOrder: async () => null,
      getStatus: async () => 'void',
      recomputeStatus: async () => 'void',
    } as unknown as FinanceInvoiceContract;

    service = new DepositsService(h.controlPlane, salesOrders, treasury, audit, events, ledger, invoices);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("submitDeposit for Company A writes inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const deposit = await service.submitDeposit(seeded.A.salesOrderId, '100.00', 'cash', null, null, actorUserId, dsA.manager);
    expect(deposit.status).toBe('submitted');
    expect(await dsA.getRepository(Deposit).findOne({ where: { id: deposit.id } })).toBeTruthy();
  });

  it("submitDeposit for Company B writes independently in Company B's own database — no leakage of Company A's deposit", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const deposit = await service.submitDeposit(seeded.B.salesOrderId, '250.00', 'cash', null, null, actorUserId, dsB.manager);
    expect(deposit.salesOrderId).toBe(seeded.B.salesOrderId);
    expect(await dsB.getRepository(Deposit).findOne({ where: { salesOrderId: seeded.A.salesOrderId } })).toBeNull();
  });

  it("getLatestDepositForOrder via Company A resolves only Company A's own deposit", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const latest = await service.getLatestDepositForOrder(seeded.A.salesOrderId, actorUserId, dsA.manager);
    expect(latest?.amount).toBe('100.00');
  });

  it('T1: approving a deposit into an UNMAPPED Treasury account is refused before anything is written — deposit stays pending, no Treasury leg, no ledger credit, no outbox row', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const latest = await service.getLatestDepositForOrder(seeded.A.salesOrderId, actorUserId, dsA.manager);
    const count = async (sql: string) => Number((await dsA.query(sql))[0].n);
    const before = [await count(`SELECT count(*) AS n FROM "treasury_transactions"`), await count(`SELECT count(*) AS n FROM "customer_ledger_entries"`), await count(`SELECT count(*) AS n FROM "event_outbox"`)];
    await expect(service.approveDeposit(latest!.id, actorUserId, seeded.A.treasuryAccountId, dsA.manager)).rejects.toThrow(/not GL-mapped/);
    expect([await count(`SELECT count(*) AS n FROM "treasury_transactions"`), await count(`SELECT count(*) AS n FROM "customer_ledger_entries"`), await count(`SELECT count(*) AS n FROM "event_outbox"`)]).toEqual(before);
    expect((await service.getDeposit(latest!.id, actorUserId, dsA.manager)).status).not.toBe('approved');
    await dsA.query(`UPDATE "treasury_accounts" SET "glAccountCode" = '1101' WHERE id = $1`, [seeded.A.treasuryAccountId]); // map it; the next test approves normally
  });

  it("approveDeposit for Company A posts the Treasury deposit leg + Customer Ledger credit inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const latest = await service.getLatestDepositForOrder(seeded.A.salesOrderId, actorUserId, dsA.manager);
    const approved = await service.approveDeposit(latest!.id, actorUserId, seeded.A.treasuryAccountId, dsA.manager);
    expect(approved.status).toBe('approved');

    const ledger: Array<{ amount: string }> = await dsA.query(
      `SELECT "amount" FROM "customer_ledger_entries" WHERE "depositId" = $1 AND "entryType" = 'deposit'`,
      [latest!.id],
    );
    expect(ledger).toHaveLength(1);
    const txns: Array<{ id: string }> = await dsA.query(`SELECT id FROM "treasury_transactions" WHERE "depositId" = $1`, [latest!.id]);
    expect(txns).toHaveLength(1);
  });

  it("rejectDeposit for Company B rejects only Company B's own deposit", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const latest = await service.getLatestDepositForOrder(seeded.B.salesOrderId, actorUserId, dsB.manager);
    const rejected = await service.rejectDeposit(latest!.id, 'wrong amount', actorUserId, dsB.manager);
    expect(rejected.status).toBe('rejected');

    const dsA = await h.connections.getDataSource(h.companyAId);
    const aLatest = await service.getLatestDepositForOrder(seeded.A.salesOrderId, actorUserId, dsA.manager);
    expect(aLatest?.status).toBe('approved');
  });

  it("Test F — resolving Company A's deposits never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      const latest = await service.getLatestDepositForOrder(seeded.A.salesOrderId, actorUserId, dsA.manager);
      await service.getDeposit(latest!.id, actorUserId, dsA.manager);
    });
  });
});
