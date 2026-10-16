import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProductMasterDataService } from '../application/product-master-data.service';
import { ProductsService } from '../application/products.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Master data step 1 (approved 2026-10-15 — MASTER-DATA-AUDIT-AND-GAP-MATRIX-2026-10-15.md §1/§2/§10; M1–M3; D-MD2, D-MD11),
 * real PostgreSQL, Company A with Company B as the isolation witness: categories, the additive item master fields, the primary
 * default warehouse (owned by the Inventory domain) and barcodes + SKU/barcode lookup. Every refusal is a controlled 4xx and
 * leaves the data unchanged.
 */
describe('Master data step 1 — item master (categories, fields, default warehouse, barcodes) — real-Postgres, A/B', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let master: ProductMasterDataService;
  let products: ProductsService;
  let inventory: InventoryService;
  const actor = randomUUID();
  const ids = { p1: randomUUID(), p2: randomUUID(), pB: randomUUID(), whMain: randomUUID(), whOther: randomUUID(), whOff: randomUUID() };

  const a = async () => (await h.connections.getDataSource(h.companyAId)).manager;
  const b = async () => (await h.connections.getDataSource(h.companyBId)).manager;
  async function expectError(p: Promise<unknown>, type: new (...args: never[]) => Error, fragment?: string) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(type);
    if (fragment) expect((err as Error).message).toContain(fragment);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'item_master', extraCompanyTags: ['sales', 'inventory'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    products = new ProductsService(h.controlPlane, audit, new EventBusService(inert, h.connections));
    master = new ProductMasterDataService(h.controlPlane, audit);
    inventory = new InventoryService(h.controlPlane, audit, products, inert, inert, inert, undefined);

    const dsA = await h.connections.getDataSource(h.companyAId);
    await dsA.query(
      `INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'LB-000142','Lamp 9W','45.00','active'), ($2,'CMP-LED','LED chip','12.00','active')`,
      [ids.p1, ids.p2],
    );
    await dsA.query(
      `INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-FG','Finished goods','active'), ($2,'WH-RAW','Raw','active'), ($3,'WH-OFF','Closed','inactive')`,
      [ids.whMain, ids.whOther, ids.whOff],
    );
    const dsB = await h.connections.getDataSource(h.companyBId);
    await dsB.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'B-1','B item','5.00','active')`, [ids.pB]);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it('migrations: existing items default to finished_good with every new field empty; the DB enforces item type and reorder level', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const [row] = await dsA.query(`SELECT "itemType","categoryId","defaultWarehouseId","reorderLevel","description" FROM products WHERE id = $1`, [ids.p1]);
    expect(row).toEqual({ itemType: 'finished_good', categoryId: null, defaultWarehouseId: null, reorderLevel: null, description: null });
    await expect(dsA.query(`UPDATE products SET "itemType" = 'gadget' WHERE id = $1`, [ids.p1])).rejects.toThrow(/CHK_products_itemType/);
    await expect(dsA.query(`UPDATE products SET "reorderLevel" = -1 WHERE id = $1`, [ids.p1])).rejects.toThrow(/CHK_products_reorderLevel/);
  });

  it('categories: create, duplicate / invalid code refused, parent must be active, no cycles, status change', async () => {
    const m = await a();
    const lamps = await master.createCategory({ code: 'LAMPS', name: 'Lamps' }, actor, m);
    const led = await master.createCategory({ code: 'LED', name: 'LED lamps', parentId: lamps.id }, actor, m);
    expect(led.parentId).toBe(lamps.id);
    await expectError(master.createCategory({ code: 'LAMPS', name: 'Again' }, actor, m), ConflictException, 'already exists');
    await expectError(master.createCategory({ code: 'bad code!', name: 'x' }, actor, m), BadRequestException);
    await expectError(master.updateCategory(lamps.id, { parentId: led.id }, actor, m), ConflictException, 'under itself');
    const off = await master.createCategory({ code: 'OLD', name: 'Old' }, actor, m);
    await master.setCategoryStatus(off.id, 'inactive', actor, m);
    await expectError(master.createCategory({ code: 'UNDER-OLD', name: 'x', parentId: off.id }, actor, m), ConflictException, 'inactive');
    expect((await master.listCategories(m)).map((c) => c.code)).toEqual(['LAMPS', 'LED', 'OLD']);
    expect(await master.listCategories(await b())).toEqual([]); // Company B sees none of A's categories
  });

  it('item master fields: update, partial update, clear with null; invalid values refused with nothing written', async () => {
    const m = await a();
    const led = (await master.listCategories(m)).find((c) => c.code === 'LED')!;
    const updated = await master.updateMasterData(ids.p1, { itemType: 'finished_good', categoryId: led.id, reorderLevel: '100', description: 'Warm white 9W LED lamp' }, actor, m);
    expect([updated.itemType, updated.categoryId, Number(updated.reorderLevel), updated.description]).toEqual(['finished_good', led.id, 100, 'Warm white 9W LED lamp']);

    // Partial: only the reorder level changes; untouched fields and the existing name/price stay.
    const partial = await master.updateMasterData(ids.p1, { reorderLevel: '12.5' }, actor, m);
    expect([partial.categoryId, Number(partial.reorderLevel), partial.description, partial.name, partial.unitPrice]).toEqual([led.id, 12.5, 'Warm white 9W LED lamp', 'Lamp 9W', '45.00']);

    const before = await (await h.connections.getDataSource(h.companyAId)).query(`SELECT "itemType","categoryId","reorderLevel","description" FROM products WHERE id = $1`, [ids.p1]);
    await expectError(master.updateMasterData(ids.p1, { itemType: 'gadget' }, actor, m), BadRequestException, 'Unknown item type');
    await expectError(master.updateMasterData(ids.p1, { reorderLevel: '-1' }, actor, m), BadRequestException);
    await expectError(master.updateMasterData(ids.p1, { reorderLevel: '1.2345' }, actor, m), BadRequestException);
    await expectError(master.updateMasterData(ids.p1, { categoryId: randomUUID() }, actor, m), NotFoundException);
    const old = (await master.listCategories(m)).find((c) => c.code === 'OLD')!;
    await expectError(master.updateMasterData(ids.p1, { categoryId: old.id }, actor, m), ConflictException, 'inactive');
    await expectError(master.updateMasterData(ids.p1, { description: 'x'.repeat(2001) }, actor, m), BadRequestException);
    await expectError(master.updateMasterData(randomUUID(), { itemType: 'service' }, actor, m), NotFoundException);
    const after = await (await h.connections.getDataSource(h.companyAId)).query(`SELECT "itemType","categoryId","reorderLevel","description" FROM products WHERE id = $1`, [ids.p1]);
    expect(after).toEqual(before);

    // Company isolation: Company A's category id is unknown in Company B.
    await expectError(master.updateMasterData(ids.pB, { categoryId: led.id }, actor, await b()), NotFoundException);

    const cleared = await master.updateMasterData(ids.p2, { itemType: 'raw_material', reorderLevel: null, description: '' }, actor, m);
    expect([cleared.itemType, cleared.reorderLevel, cleared.description]).toEqual(['raw_material', null, null]);
  });

  it('default warehouse (Inventory domain): must be an active warehouse the item is assigned to; null clears; unassigning clears it', async () => {
    const m = await a();
    await expectError(inventory.setDefaultWarehouse(ids.p1, ids.whMain, actor, m), ConflictException, 'not assigned');
    await inventory.assignItems(ids.whMain, [ids.p1], actor, m);
    await inventory.assignItems(ids.whOff, [ids.p1], actor, m);
    await expectError(inventory.setDefaultWarehouse(ids.p1, ids.whOff, actor, m), ConflictException, 'inactive');
    await expectError(inventory.setDefaultWarehouse(ids.p1, randomUUID(), actor, m), NotFoundException);
    await expectError(inventory.setDefaultWarehouse(randomUUID(), ids.whMain, actor, m), NotFoundException);

    expect(await inventory.setDefaultWarehouse(ids.p1, ids.whMain, actor, m)).toEqual({ productId: ids.p1, defaultWarehouseId: ids.whMain });
    expect((await products.getProduct(ids.p1, m)).defaultWarehouseId).toBe(ids.whMain);

    // Unassigning a different warehouse leaves the default; unassigning the default warehouse clears it.
    await inventory.assignItems(ids.whOther, [ids.p1], actor, m);
    await inventory.unassignItem(ids.whOther, ids.p1, actor, m);
    expect((await products.getProduct(ids.p1, m)).defaultWarehouseId).toBe(ids.whMain);
    await inventory.unassignItem(ids.whMain, ids.p1, actor, m);
    expect((await products.getProduct(ids.p1, m)).defaultWarehouseId).toBeNull();

    await inventory.assignItems(ids.whMain, [ids.p1], actor, m);
    await inventory.setDefaultWarehouse(ids.p1, ids.whMain, actor, m);
    await inventory.setDefaultWarehouse(ids.p1, null, actor, m);
    expect((await products.getProduct(ids.p1, m)).defaultWarehouseId).toBeNull();
  });

  it('barcodes: many per item, first is primary, primary moves; unique per Company; never equal to a SKU (both ways)', async () => {
    const m = await a();
    const first = await master.addBarcode(ids.p1, { barcode: '6287000142915' }, actor, m);
    expect(first.isPrimary).toBe(true);
    const carton = await master.addBarcode(ids.p1, { barcode: '16287000142912', packLabel: 'Carton of 12' }, actor, m);
    expect([carton.isPrimary, carton.packLabel]).toEqual([false, 'Carton of 12']);
    await master.addBarcode(ids.p1, { barcode: 'LB142-ALT', isPrimary: true }, actor, m);
    const list = await master.listBarcodes(ids.p1, m);
    expect(list.filter((x) => x.isPrimary).map((x) => x.barcode)).toEqual(['LB142-ALT']);
    expect(list).toHaveLength(3);

    await expectError(master.addBarcode(ids.p2, { barcode: '6287000142915' }, actor, m), ConflictException, 'another item');
    await expectError(master.addBarcode(ids.p1, { barcode: '6287000142915' }, actor, m), ConflictException, 'this item');
    await expectError(master.addBarcode(ids.p2, { barcode: 'LB-000142' }, actor, m), ConflictException, 'item code');
    await expectError(master.addBarcode(ids.p2, { barcode: 'ab' }, actor, m), BadRequestException);
    await expectError(master.addBarcode(ids.p2, { barcode: 'has space' }, actor, m), BadRequestException);
    await expectError(master.addBarcode(randomUUID(), { barcode: '12345678' }, actor, m), NotFoundException);
    // A new item's SKU may not equal an existing barcode.
    await expectError(products.createProduct('6287000142915', 'Clash', '1.00', actor, null, m), ConflictException, 'barcode');

    // The same barcode in Company B is a different Company's catalogue: allowed.
    expect((await master.addBarcode(ids.pB, { barcode: '6287000142915' }, actor, await b())).isPrimary).toBe(true);

    await master.removeBarcode(ids.p1, carton.id, actor, m);
    expect((await master.listBarcodes(ids.p1, m)).map((x) => x.barcode).sort()).toEqual(['6287000142915', 'LB142-ALT']);
    await expectError(master.removeBarcode(ids.p2, first.id, actor, m), NotFoundException); // barcode of another item
  });

  it('lookup: exact SKU first, then exact barcode; unknown code is a 404; Company-scoped', async () => {
    const m = await a();
    expect(await master.lookup('LB-000142', m)).toMatchObject({ matchedBy: 'sku', barcode: null, product: { id: ids.p1, sku: 'LB-000142' } });
    expect(await master.lookup(' 6287000142915 ', m)).toMatchObject({ matchedBy: 'barcode', barcode: '6287000142915', product: { id: ids.p1 } });
    await expectError(master.lookup('16287000142912', m), NotFoundException); // removed above
    await expectError(master.lookup('', m), BadRequestException);
    expect(await master.lookup('6287000142915', await b())).toMatchObject({ matchedBy: 'barcode', product: { id: ids.pB } });
    await expectError(master.lookup('LB-000142', await b()), NotFoundException);
  });
});
