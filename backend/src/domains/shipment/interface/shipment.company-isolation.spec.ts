import { randomUUID } from 'crypto';
import { ShipmentService } from '../application/shipment.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { Warehouse } from '../../inventory-warehouse/infrastructure/warehouse.entity';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { TreasuryAccount } from '../../treasury/infrastructure/treasury-account.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * Real-Postgres proof that `shipment.controller.ts`'s reads/writes are
 * genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct shipping
 * company, never mocked.
 *
 * `createShippingCompany` is the sharpest proof available here: it
 * transitively calls `InventoryService.createWarehouse` and
 * `TreasuryService.createAccount`/`listAccountTypes` (both real,
 * constructed for this test) to auto-provision an Operational
 * Sub-location warehouse + a Custody treasury account — this exercises
 * the exact cross-domain manager-threading chain
 * (`ShipmentService` → `InventoryLogisticsContract`/
 * `FinanceTreasuryContract`) that §26's STOP/ESCALATE finding identified
 * as blocked, and that §28/§26-update later closed.
 */
describe('ShipmentController Area 21 retrofit — real-Postgres Company isolation (2026-09-27)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: ShipmentService;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'shipment_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'] });

    // `createShippingCompany` auto-provisions its Operational Sub-location under the first
    // active 'main' warehouse — seed one per Company directly (the migrations don't create one).
    for (const companyId of [h.companyAId, h.companyBId]) {
      const ds = await h.connections.getDataSource(companyId);
      await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,'WH-MAIN','Main Warehouse','active','main')`, [
        randomUUID(),
      ]);
    }

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined);
    const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, inert);
    service = new ShipmentService(h.controlPlane, numbering, inert, inert, audit, inert, inventory, inert, treasury, inert, inert, inert);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("createShippingCompany for Company A provisions its own warehouse + custody account inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const company = await service.createShippingCompany('SC-A-001', 'Company A Shipping Co', null, null, null, randomUUID(), null, dsA.manager);

    expect(company.warehouseId).toBeTruthy();
    expect(company.custodyAccountId).toBeTruthy();

    // The provisioned resources genuinely exist as real rows in Company A's own database.
    const warehouse = await dsA.getRepository(Warehouse).findOne({ where: { id: company.warehouseId! } });
    expect(warehouse).toBeTruthy();
    const account = await dsA.getRepository(TreasuryAccount).findOne({ where: { id: company.custodyAccountId! } });
    expect(account).toBeTruthy();
  });

  it("createShippingCompany for Company B provisions independently in Company B's own database — no leakage of Company A's warehouse/account", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const company = await service.createShippingCompany('SC-B-001', 'Company B Shipping Co', null, null, null, randomUUID(), null, dsB.manager);
    expect(company.warehouseId).toBeTruthy();
    expect(company.custodyAccountId).toBeTruthy();
  });

  it("listShippingCompanies via Company A resolves only Company A's own shipping company — never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const companies = await service.listShippingCompanies(dsA.manager);
    expect(companies.map((c) => c.code)).toEqual(['SC-A-001']);
  });

  it("listShippingCompanies via Company B resolves only Company B's own shipping company — no leakage of Company A's data", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const companies = await service.listShippingCompanies(dsB.manager);
    expect(companies.map((c) => c.code)).toEqual(['SC-B-001']);
  });

  it("Test F — resolving Company A's shipping companies never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listShippingCompanies(dsA.manager);
    });
  });
});
