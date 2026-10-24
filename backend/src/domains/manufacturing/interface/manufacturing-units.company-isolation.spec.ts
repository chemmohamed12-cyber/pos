import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { UnitConversionService } from '../application/unit-conversion.service';
import { ProductsService } from '../../commerce/application/products.service';
import { BomService } from '../../commerce/application/bom.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Manufacturing Engine S2 (decision D-ME-2) — units and pack conversion by integer base-unit scaling, real PostgreSQL, Company B is the untouched witness.
 * Proves exact decimal conversion to whole base units, refusal of anything that is not exact (never rounded), pack hierarchies (unit -> pack -> carton), the reverse
 * display conversion, recipe lines typed in a larger unit landing as integer base units in the real BOM, and per-Company isolation of the conversion table.
 */
describe('Manufacturing Engine S2 — units & pack conversion — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let units: UnitConversionService;
  let bom: BomService;
  const actor = randomUUID();
  const ids = { flour: '', screw: '', lamp: '', packed: '' };
  const dsA = () => h.connections.getDataSource(h.companyAId);
  const dsB = () => h.connections.getDataSource(h.companyBId);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'mfg_s2', extraCompanyTags: ['sales', 'inventory', 'logistics', 'finance', 'procurement', 'accounting', 'manufacturing'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const events = new EventBusService(inert, h.connections);
    const products = new ProductsService(h.controlPlane, audit, events);
    bom = new BomService(h.controlPlane, audit, products);
    units = new UnitConversionService();
    const a = (await dsA()).manager;
    await (await dsA()).query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'MFG Operator','mfg-s2@test.local') ON CONFLICT DO NOTHING`, [actor]);
    ids.flour = (await products.createProduct('S2-FLOUR', 'Flour', '1.00', actor, 'g', a)).id;
    ids.screw = (await products.createProduct('S2-SCREW', 'Screw', '1.00', actor, 'pcs', a)).id;
    ids.lamp = (await products.createProduct('S2-LAMP', 'Lamp', '100.00', actor, 'pcs', a)).id;
    ids.packed = (await products.createProduct('S2-PACKED', 'Packed lamp', '100.00', actor, 'unit', a)).id;
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('MFG S2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const m = async () => (await dsA()).manager;

  it('S2-1 a larger unit converts exactly to whole base units (0.25 kg = 250 g, 1.5 kg = 1500 g); no unit means the base unit', async () => {
    await units.set(ids.flour, 'kg', 1000, actor, await m());
    expect(await units.toBase(ids.flour, '0.25', 'kg', await m())).toBe(250);
    expect(await units.toBase(ids.flour, '1.5', 'KG', await m())).toBe(1500);
    expect(await units.toBase(ids.flour, '3', null, await m())).toBe(3);
    expect(await units.toBase(ids.flour, 7, 'g', await m())).toBe(7);
  });

  it('S2-2 anything that is not an exact whole number of base units is refused, never rounded', async () => {
    await expect(units.toBase(ids.flour, '0.0005', 'kg', await m())).rejects.toBeInstanceOf(ConflictException); // 0.5 g
    await expect(units.toBase(ids.flour, '2.5', null, await m())).rejects.toBeInstanceOf(ConflictException);
    await expect(units.toBase(ids.flour, '1', 'ton', await m())).rejects.toBeInstanceOf(ConflictException); // unknown unit
    await expect(units.toBase(ids.flour, '0', 'kg', await m())).rejects.toThrow();
    await expect(units.toBase(ids.flour, 'abc', 'kg', await m())).rejects.toThrow();
    await expect(units.set(ids.flour, 'g', 1000, actor, await m())).rejects.toBeInstanceOf(ConflictException); // base unit itself
    await expect(units.set(ids.flour, 'dozen', 1, actor, await m())).rejects.toThrow(); // factor must be >= 2
  });

  it('S2-3 re-defining a unit (case-insensitive) updates the factor instead of duplicating it', async () => {
    await units.set(ids.flour, 'KG', 1000, actor, await m());
    const list = await units.list(ids.flour, await m());
    expect(list.baseUnit).toBe('g');
    expect(list.conversions.filter((c) => c.unitCode.toLowerCase() === 'kg')).toHaveLength(1);
  });

  it('S2-4 pack hierarchy: unit -> pack (12) -> carton (240); fractional packs are exact only when whole units', async () => {
    await units.set(ids.packed, 'pack', 12, actor, await m());
    await units.set(ids.packed, 'carton', 240, actor, await m());
    expect(await units.toBase(ids.packed, '2', 'carton', await m())).toBe(480);
    expect(await units.toBase(ids.packed, '1.5', 'pack', await m())).toBe(18);
    await expect(units.toBase(ids.packed, '0.1', 'pack', await m())).rejects.toBeInstanceOf(ConflictException); // 1.2 units
  });

  it('S2-5 reverse display conversion is exact (250 g = 0.25 kg, 1500 = 1.5, 3000 = 3, 25 = 0.025)', async () => {
    expect(await units.fromBase(ids.flour, 250, 'kg', await m())).toBe('0.25');
    expect(await units.fromBase(ids.flour, 1500, 'kg', await m())).toBe('1.5');
    expect(await units.fromBase(ids.flour, 3000, 'kg', await m())).toBe('3');
    expect(await units.fromBase(ids.flour, 25, 'kg', await m())).toBe('0.025');
    expect(await units.fromBase(ids.flour, 25, null, await m())).toBe('25');
  });

  it('S2-6 a recipe line typed as 0.25 kg lands in the real BOM as 250 base units (g); a plain line stays as given', async () => {
    const lines = [
      { componentProductId: ids.flour, quantityPerUnit: await units.toBase(ids.flour, '0.25', 'kg', await m()) },
      { componentProductId: ids.screw, quantityPerUnit: await units.toBase(ids.screw, '3', null, await m()) },
    ];
    await bom.defineBom(ids.lamp, lines, actor, await m());
    const got = await bom.getBom(ids.lamp, await m());
    const byProduct = Object.fromEntries((got!.components as Array<{ componentProductId: string; quantityPerUnit: number }>).map((c) => [c.componentProductId, c.quantityPerUnit]));
    expect(byProduct[ids.flour]).toBe(250);
    expect(byProduct[ids.screw]).toBe(3);
  });

  it('S2-7 Company B (the witness) holds no conversions and cannot see Company A\'s', async () => {
    const b = await dsB();
    const n = await b.query(`SELECT count(*)::int AS n FROM "product_unit_conversions"`);
    expect(n[0].n).toBe(0);
    await expect(units.toBase(ids.flour, '1', 'kg', b.manager)).rejects.toThrow(); // product does not exist in B
  });
});
