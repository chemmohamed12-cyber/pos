import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { SupplierService } from '../application/supplier.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';

/**
 * D9 (2026-10-05, CTO register: supplier edit + auto-numbered code, no per-supplier GL account) — real PostgreSQL, Company A with
 * Company B as the witness. Proves: the code is issued by the numbering engine per Company (no year segment, never reused, an
 * explicit legacy code is still accepted and unique), master data is editable (code immutable, audited before/after, no-op =
 * no write), a foreign supplier is unknown to the other Company, and a supplier carries NO GL account (the sub-ledger → single AP
 * control account architecture is unchanged).
 */
describe('D9 — Supplier master: auto-numbered code + edit — real-Postgres, A/B', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let suppliers: SupplierService;
  let actor: string;
  const mgr = async (id: string) => (await h.connections.getDataSource(id)).manager;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'd9_supplier_master', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const approvals = new ApprovalEngineService(ambient, process, audit, events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    suppliers = new SupplierService(ambient, audit, approvals, new NumberingService(ambient));
    actor = (await h.createUserWithAdminRoleIn('Supplier Admin', h.companyAId)).id;
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('D9 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  let a1 = '';

  it('1. CODE is auto-numbered per Company (SUP-000001, no year), independently in A and B; never reused', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const s1 = await suppliers.create({ legalName: 'Alpha Trading' }, actor, mA);
    const s2 = await suppliers.create({ legalName: 'Beta Supplies', code: '  ' }, actor, mA); // blank = auto
    const b1 = await suppliers.create({ legalName: 'B-Co Supplier' }, actor, mB);
    expect([s1.code, s2.code]).toEqual(['SUP-000001', 'SUP-000002']);
    expect(b1.code).toBe('SUP-000001'); // B's own sequence
    a1 = s1.id;
  });

  it('2. an EXPLICIT code is still accepted (data migration) and must be unique; auto-numbering skips a colliding legacy code', async () => {
    const mA = await mgr(h.companyAId);
    const legacy = await suppliers.create({ legalName: 'Legacy', code: 'SUP-000003' }, actor, mA);
    expect(legacy.code).toBe('SUP-000003');
    await expect(suppliers.create({ legalName: 'Dup', code: 'SUP-000003' }, actor, mA)).rejects.toBeInstanceOf(ConflictException);
    const next = await suppliers.create({ legalName: 'After legacy' }, actor, mA);
    expect(next.code).toBe('SUP-000004'); // 000003 was taken — skipped, not reused or duplicated
  });

  it('3. EDIT: master data changes (legal/trading name, type, tax/VAT/commercial numbers, terms, credit limit); CODE and STATUS are untouched; audited before/after', async () => {
    const mA = await mgr(h.companyAId);
    const saved = await suppliers.updateSupplier(
      a1,
      {
        legalName: 'Alpha Trading LLC',
        tradingName: 'Alpha',
        supplierType: 'individual',
        taxRegistrationNumber: 'TAX-1',
        vatRegistrationNumber: 'VAT-1',
        commercialRegistrationNumber: 'CR-1',
        paymentTermsDays: 30,
        creditLimitBase: '50000.00',
        code: 'HACKED', // not part of the edit contract — must be ignored
      } as never,
      actor,
      mA,
    );
    expect(saved.code).toBe('SUP-000001');
    expect(saved.status).toBe('active');
    const fresh = (await suppliers.getById(a1, mA)).supplier;
    expect([fresh.legalName, fresh.tradingName, fresh.supplierType, fresh.taxRegistrationNumber, fresh.vatRegistrationNumber, fresh.commercialRegistrationNumber, fresh.paymentTermsDays]).toEqual([
      'Alpha Trading LLC', 'Alpha', 'individual', 'TAX-1', 'VAT-1', 'CR-1', 30,
    ]);
    expect(Number(fresh.creditLimitBase)).toBe(50000);
    const rows = await mA.query(`SELECT "before","after" FROM audit_records WHERE action = 'supplier.updated' AND "resourceId" = $1`, [a1]);
    expect(rows).toHaveLength(1);
    expect(rows[0].before.legalName).toBe('Alpha Trading');
    expect(rows[0].after.legalName).toBe('Alpha Trading LLC');
    expect(rows[0].after.code).toBeUndefined();
  });

  it('4. a no-op edit writes nothing (no audit noise); nullable fields can be cleared; an empty legal name is rejected', async () => {
    const mA = await mgr(h.companyAId);
    const count = async () => Number((await mA.query(`SELECT count(*) AS n FROM audit_records WHERE action = 'supplier.updated' AND "resourceId" = $1`, [a1]))[0].n);
    const before = await count();
    await suppliers.updateSupplier(a1, { legalName: 'Alpha Trading LLC', paymentTermsDays: 30 }, actor, mA);
    expect(await count()).toBe(before);
    await suppliers.updateSupplier(a1, { vatRegistrationNumber: '', tradingName: null, creditLimitBase: null }, actor, mA);
    const s = (await suppliers.getById(a1, mA)).supplier;
    expect([s.vatRegistrationNumber, s.tradingName, s.creditLimitBase]).toEqual([null, null, null]);
    expect(await count()).toBe(before + 1);
    await expect(suppliers.updateSupplier(a1, { legalName: '   ' }, actor, mA)).rejects.toBeInstanceOf(ConflictException);
  });

  it('5. a supplier carries NO GL account — the sub-ledger → single AP control account architecture is unchanged', async () => {
    const mA = await mgr(h.companyAId);
    const cols: Array<{ column_name: string }> = await mA.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'suppliers'`);
    expect(cols.map((c) => c.column_name).filter((n) => /gl|ledgeraccount|controlaccount|accountid/i.test(n))).toEqual([]);
  });

  it('6. ISOLATION: B cannot edit or read A\'s supplier; B\'s edits never touch A; the other Company\'s DataSource is never requested', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    await expect(suppliers.updateSupplier(a1, { legalName: 'Stolen' }, actor, mB)).rejects.toBeInstanceOf(NotFoundException);
    const bRow = (await mB.query(`SELECT id FROM suppliers WHERE code = 'SUP-000001'`))[0];
    await suppliers.updateSupplier(bRow.id, { legalName: 'B-Co Renamed' }, actor, mB);
    expect((await suppliers.getById(a1, mA)).supplier.legalName).toBe('Alpha Trading LLC');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await suppliers.updateSupplier(a1, { paymentTermsDays: 45 }, actor, mA);
      await suppliers.create({ legalName: 'Another A' }, actor, mA);
    });
    expect(Number((await mA.query(`SELECT count(*) AS n FROM suppliers`))[0].n)).toBe(5);
    expect(Number((await mB.query(`SELECT count(*) AS n FROM suppliers`))[0].n)).toBe(1);
  });
});
