import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SupplierService } from '../application/supplier.service';
import { SupplierProfileService } from '../application/supplier-profile.service';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AddSupplierProfileFields1790016300000 } from '../../../database/migrations/procurement/1790016300000-AddSupplierProfileFields';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

/**
 * Supplier profile (master-data gap matrix §5, migration M6) — real Postgres, Company A with Company B as the witness. Proves: four nullable
 * columns + CHECK; the new profile fields go through the existing update (validated before any write, blank clears, no-op = no audit, the
 * existing fields/code/status untouched); exactly one primary contact / default address; contacts and addresses can be corrected and
 * removed but never through another supplier; the purchase-order list can be narrowed by supplier (and still respects the warehouse
 * filter); Company isolation; and the migration rolls back and re-applies.
 */
describe('Supplier profile (M6) — real-Postgres, A/B', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let suppliers: SupplierService;
  let profile: SupplierProfileService;
  let orders: PurchaseOrderService;
  let actor: string;
  const mgr = async (id: string) => (await h.connections.getDataSource(id)).manager;
  const ids = { s1: '', s2: '', sB: '' };
  const wh = { w1: randomUUID(), w2: randomUUID() };

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'supplier_profile', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const approvals = new ApprovalEngineService(ambient, process, audit, events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    const numbering = new NumberingService(ambient);
    suppliers = new SupplierService(ambient, audit, approvals, numbering);
    profile = new SupplierProfileService(ambient, audit);
    orders = new PurchaseOrderService(ambient, process, numbering, audit, inert, inert); // only `list` is exercised
    actor = (await h.createUserWithAdminRoleIn('Supplier Profile Admin', h.companyAId)).id;
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    ids.s1 = (await suppliers.create({ legalName: 'Alpha Trading' }, actor, mA)).id;
    ids.s2 = (await suppliers.create({ legalName: 'Beta Supplies' }, actor, mA)).id;
    ids.sB = (await suppliers.create({ legalName: 'B-Co Supplier' }, actor, mB)).id;
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('supplier profile teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const q = async (sql: string, params: unknown[] = []) => (await (await h.connections.getDataSource(h.companyAId)).query(sql, params)) as Array<Record<string, unknown>>;

  it('M6 schema: four nullable columns (existing suppliers null), CHECK refuses a bad language', async () => {
    const cols = await q(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'suppliers' AND column_name = ANY($1)`, [['email', 'website', 'language', 'internalNotes']]);
    expect(cols).toHaveLength(4);
    expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);
    const row = (await q(`SELECT email, website, language, "internalNotes" FROM suppliers WHERE id = $1`, [ids.s1]))[0];
    expect(Object.values(row).every((v) => v === null)).toBe(true);
    await expect(q(`UPDATE suppliers SET language = 'fr' WHERE id = $1`, [ids.s1])).rejects.toThrow();
  });

  it('update: profile fields are set, a blank clears, a no-op writes no audit, and the code / status / existing fields stay put', async () => {
    const mA = await mgr(h.companyAId);
    const before = (await q(`SELECT code, status, "legalName", "paymentTermsDays" FROM suppliers WHERE id = $1`, [ids.s1]))[0];
    const saved = await suppliers.updateSupplier(ids.s1, { email: ' buyer@alpha.test ', website: 'https://alpha.test', language: 'ar', internalNotes: 'Prefers Sunday delivery' }, actor, mA);
    expect(saved).toMatchObject({ email: 'buyer@alpha.test', website: 'https://alpha.test', language: 'ar', internalNotes: 'Prefers Sunday delivery' });
    expect((await q(`SELECT code, status, "legalName", "paymentTermsDays" FROM suppliers WHERE id = $1`, [ids.s1]))[0]).toEqual(before);

    const audits = async () => Number((await q(`SELECT COUNT(*)::int AS n FROM audit_records WHERE action = 'supplier.updated'`))[0].n);
    const a0 = await audits();
    await suppliers.updateSupplier(ids.s1, { email: 'buyer@alpha.test', language: 'ar' }, actor, mA); // same values
    expect(await audits()).toBe(a0);
    await suppliers.updateSupplier(ids.s1, { internalNotes: '  ', language: '' }, actor, mA); // blank clears
    expect((await q(`SELECT language, "internalNotes", email FROM suppliers WHERE id = $1`, [ids.s1]))[0]).toEqual({ language: null, internalNotes: null, email: 'buyer@alpha.test' });
    expect(await audits()).toBe(a0 + 1);
  });

  it('update: every profile validation error is a 400 and nothing is written (even the valid fields sent with it)', async () => {
    const mA = await mgr(h.companyAId);
    const snapshot = JSON.stringify((await q(`SELECT * FROM suppliers WHERE id = $1`, [ids.s1]))[0]);
    for (const bad of [{ email: 'nope' }, { language: 'fr' }, { website: 'has spaces.test' }, { internalNotes: 'x'.repeat(5000) }]) {
      await expect(suppliers.updateSupplier(ids.s1, { ...bad, tradingName: 'MUST NOT BE WRITTEN' }, actor, mA)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(JSON.stringify((await q(`SELECT * FROM suppliers WHERE id = $1`, [ids.s1]))[0])).toBe(snapshot);
  });

  it('contacts: exactly one primary (add and update switch it); edit, correct and remove; another supplier\'s contact is a 404', async () => {
    const mA = await mgr(h.companyAId);
    const sara = await suppliers.addContact(ids.s1, { name: 'Sara', isPrimary: true }, mA);
    const omar = await suppliers.addContact(ids.s1, { name: 'Omar', isPrimary: true }, mA);
    const primaries = async () => (await q(`SELECT name FROM supplier_contacts WHERE "supplierId" = $1 AND "isPrimary"`, [ids.s1])).map((r) => r.name);
    expect(await primaries()).toEqual(['Omar']);
    await profile.updateContact(ids.s1, sara.id, { isPrimary: true }, actor, mA);
    expect(await primaries()).toEqual(['Sara']);
    const edited = await profile.updateContact(ids.s1, sara.id, { title: 'Buyer', phone: '0100', email: '' }, actor, mA);
    expect(edited).toMatchObject({ name: 'Sara', title: 'Buyer', phone: '0100', email: null });
    await expect(profile.updateContact(ids.s1, sara.id, { email: 'bad' }, actor, mA)).rejects.toBeInstanceOf(BadRequestException);
    await expect(profile.updateContact(ids.s1, sara.id, { name: '  ' }, actor, mA)).rejects.toBeInstanceOf(BadRequestException);

    await expect(profile.updateContact(ids.s2, omar.id, { name: 'Hijack' }, actor, mA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(profile.removeContact(ids.s2, omar.id, actor, mA)).rejects.toBeInstanceOf(NotFoundException);
    expect(await profile.removeContact(ids.s1, omar.id, actor, mA)).toEqual({ removed: true });
    await expect(profile.removeContact(ids.s1, omar.id, actor, mA)).rejects.toBeInstanceOf(NotFoundException);
    expect((await suppliers.getById(ids.s1, mA)).contacts.map((c) => c.name)).toEqual(['Sara']);
  });

  it('addresses: exactly one default (add and update switch it); correct and remove; cross-supplier 404', async () => {
    const mA = await mgr(h.companyAId);
    const hq = await suppliers.addAddress(ids.s1, { label: 'HQ', addressLine: '1 Nile St', isDefault: true }, mA);
    const wh2 = await suppliers.addAddress(ids.s1, { label: 'Depot', addressLine: '9 Ring Rd', isDefault: true }, mA);
    const defaults = async () => (await q(`SELECT label FROM supplier_addresses WHERE "supplierId" = $1 AND "isDefault"`, [ids.s1])).map((r) => r.label);
    expect(await defaults()).toEqual(['Depot']);
    await profile.updateAddress(ids.s1, hq.id, { isDefault: true, city: 'Giza' }, actor, mA);
    expect(await defaults()).toEqual(['HQ']);
    await expect(profile.updateAddress(ids.s1, hq.id, { addressLine: '' }, actor, mA)).rejects.toBeInstanceOf(BadRequestException);
    await expect(profile.updateAddress(ids.s2, hq.id, { city: 'Hijack' }, actor, mA)).rejects.toBeInstanceOf(NotFoundException);
    expect(await profile.removeAddress(ids.s1, wh2.id, actor, mA)).toEqual({ removed: true });
    await expect(profile.removeAddress(ids.s1, wh2.id, actor, mA)).rejects.toBeInstanceOf(NotFoundException);
    expect((await suppliers.getById(ids.s1, mA)).addresses.map((a) => a.label)).toEqual(['HQ']);
  });

  it('purchase-order list: narrowed by supplierId, the F6 warehouse filter still applies on top, and no filter = unchanged', async () => {
    const mA = await mgr(h.companyAId);
    const insert = (supplierId: string, number: string, warehouseId: string) =>
      q(`INSERT INTO purchase_orders ("id","poNumber","supplierId","warehouseId","totalAmountBase") VALUES ($1,$2,$3,$4,'10.00')`, [randomUUID(), number, supplierId, warehouseId]);
    await insert(ids.s1, 'PO-T-1', wh.w1);
    await insert(ids.s1, 'PO-T-2', wh.w2);
    await insert(ids.s2, 'PO-T-3', wh.w1);
    const numbers = async (supplierId?: string, visible?: string[]) => (await orders.list(mA, visible, supplierId)).map((p) => p.poNumber).sort();
    expect(await numbers()).toEqual(['PO-T-1', 'PO-T-2', 'PO-T-3']);
    expect(await numbers(ids.s1)).toEqual(['PO-T-1', 'PO-T-2']);
    expect(await numbers(ids.s2)).toEqual(['PO-T-3']);
    expect(await numbers(ids.s1, [wh.w1])).toEqual(['PO-T-1']); // both filters
    expect(await numbers(undefined, [wh.w2])).toEqual(['PO-T-2']);
    expect(await numbers(randomUUID())).toEqual([]);
  });

  it("Company isolation: Company A's supplier is unknown to B (profile ops 404, PO list empty); B has its own empty profile data", async () => {
    const mB = await mgr(h.companyBId);
    const mA = await mgr(h.companyAId);
    await expect(profile.updateContact(ids.s1, randomUUID(), { name: 'Leak' }, actor, mB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(profile.removeAddress(ids.s1, randomUUID(), actor, mB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(suppliers.updateSupplier(ids.s1, { internalNotes: 'Leak' }, actor, mB)).rejects.toBeInstanceOf(NotFoundException);
    expect(await orders.list(mB, undefined, ids.s1)).toEqual([]);
    const b = await suppliers.getById(ids.sB, mB);
    expect(b.supplier.email).toBeNull();
    expect(b.contacts).toEqual([]);
    expect((await suppliers.getById(ids.s1, mA)).supplier.email).toBe('buyer@alpha.test');
  });

  it('migration rolls back and re-applies: down drops exactly the four columns (old data intact), up restores them', async () => {
    const a = await h.connections.getDataSource(h.companyAId);
    const qr = a.createQueryRunner();
    try {
      const count = async () => (await qr.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'suppliers' AND column_name = ANY($1)`, [['email', 'website', 'language', 'internalNotes']])).length;
      const legal = (await qr.query(`SELECT "legalName", code FROM suppliers WHERE id = $1`, [ids.s1]))[0];
      await new AddSupplierProfileFields1790016300000().down(qr);
      expect(await count()).toBe(0);
      expect((await qr.query(`SELECT "legalName", code FROM suppliers WHERE id = $1`, [ids.s1]))[0]).toEqual(legal);
      await new AddSupplierProfileFields1790016300000().up(qr);
      expect(await count()).toBe(4);
    } finally {
      await qr.release();
    }
  });
});
