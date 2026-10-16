import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CustomerProfileService } from '../application/customer-profile.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { AddCustomerProfileFields1790016000000 } from '../../../database/migrations/sales/1790016000000-AddCustomerProfileFields';
import { CreateCustomerAddressesAndContacts1790016100000 } from '../../../database/migrations/sales/1790016100000-CreateCustomerAddressesAndContacts';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Customer profile (master-data gap matrix §5, migrations M4/M5), real Postgres, two Companies. Proves: the schema is additive and
 * constrained; partial-update semantics (undefined = untouched, blank = clear, no-op = no write and no audit); every validation error is a
 * 400 that writes nothing; one primary contact / one default address even under concurrent writers; a contact or address of one customer
 * can never be changed through another; Company isolation; the customer's lifecycle/financial columns are never touched; and the
 * migrations roll back (`down`) and re-apply (`up`) cleanly.
 */
describe('Customer profile (M4/M5) — real-Postgres', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let svc: CustomerProfileService;
  const actor = randomUUID();
  const ids = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() };

  const dsA = () => h.connections.getDataSource(h.companyAId);
  const dsB = () => h.connections.getDataSource(h.companyBId);
  const count = async (table: string, where = 'true') => Number((await (await dsA()).query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`))[0].n);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'customer_profile', extraCompanyTags: ['sales', 'finance'] });
    for (const [companyId, rows] of [
      [h.companyAId, [[ids.a1, 'CUST-A-1', 'Alpha One'], [ids.a2, 'CUST-A-2', 'Alpha Two']]],
      [h.companyBId, [[ids.b1, 'CUST-B-1', 'Beta One']]],
    ] as Array<[string, string[][]]>) {
      const ds = await h.connections.getDataSource(companyId);
      await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Profile Tester',$2) ON CONFLICT DO NOTHING`, [actor, `profile-${companyId}@test.local`]);
      for (const [id, code, name] of rows) {
        await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit","paymentTermsDays","financialStatus") VALUES ($1,$2,$3,'5000.00',30,'on_hold')`, [id, code, name]);
      }
    }
    svc = new CustomerProfileService(h.controlPlane, new AuditService(h.controlPlane));
  });

  afterAll(async () => {
    await h.teardown();
  });

  it('M4/M5 schema: nine nullable columns (existing rows null), CHECK constraints refuse bad values, one default / one primary per customer is a database rule', async () => {
    const a = await dsA();
    const cols: Array<{ column_name: string; is_nullable: string }> = await a.query(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'customers' AND column_name = ANY($1)`,
      [['partyType', 'legalName', 'taxRegistrationNumber', 'vatRegistrationNumber', 'commercialRegistrationNumber', 'email', 'website', 'language', 'internalNotes']],
    );
    expect(cols).toHaveLength(9);
    expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);
    const row = (await a.query(`SELECT "partyType","legalName","email","language","internalNotes" FROM customers WHERE id = $1`, [ids.a1]))[0];
    expect(Object.values(row).every((v) => v === null)).toBe(true);

    await expect(a.query(`UPDATE customers SET "partyType" = 'robot' WHERE id = $1`, [ids.a1])).rejects.toThrow();
    await expect(a.query(`UPDATE customers SET "language" = 'fr' WHERE id = $1`, [ids.a1])).rejects.toThrow();

    const idx: Array<{ indexname: string }> = await a.query(`SELECT indexname FROM pg_indexes WHERE indexname IN ('UQ_customer_addresses_default','UQ_customer_contacts_primary')`);
    expect(idx).toHaveLength(2);
  });

  it('updateProfile: partial update leaves other fields alone, a blank clears, and a no-op writes nothing and adds no audit row', async () => {
    const a = await dsA();
    const updated = await svc.updateProfile(
      ids.a1,
      { partyType: 'company', legalName: '  Alpha One LLC ', taxRegistrationNumber: '100-200-300', email: 'info@alpha.test', language: 'ar', internalNotes: 'VIP' },
      actor,
      a.manager,
    );
    expect(updated).toMatchObject({ partyType: 'company', legalName: 'Alpha One LLC', taxRegistrationNumber: '100-200-300', email: 'info@alpha.test', language: 'ar', internalNotes: 'VIP' });

    const auditsBefore = await count('audit_records', `"action" = 'crm.customer.profile_updated'`);
    await svc.updateProfile(ids.a1, { website: 'https://alpha.test' }, actor, a.manager);
    const afterWebsite = (await a.query(`SELECT * FROM customers WHERE id = $1`, [ids.a1]))[0];
    expect(afterWebsite).toMatchObject({ website: 'https://alpha.test', legalName: 'Alpha One LLC', email: 'info@alpha.test', internalNotes: 'VIP' });
    expect(await count('audit_records', `"action" = 'crm.customer.profile_updated'`)).toBe(auditsBefore + 1);

    await svc.updateProfile(ids.a1, { internalNotes: '   ', language: '' }, actor, a.manager); // blank clears
    const cleared = (await a.query(`SELECT "internalNotes","language","email" FROM customers WHERE id = $1`, [ids.a1]))[0];
    expect(cleared).toEqual({ internalNotes: null, language: null, email: 'info@alpha.test' });

    const auditsMid = await count('audit_records', `"action" = 'crm.customer.profile_updated'`);
    await svc.updateProfile(ids.a1, { email: 'info@alpha.test', legalName: 'Alpha One LLC' }, actor, a.manager); // same values
    await svc.updateProfile(ids.a1, {}, actor, a.manager);
    expect(await count('audit_records', `"action" = 'crm.customer.profile_updated'`)).toBe(auditsMid);
  });

  it('updateProfile: every validation error is a 400 and writes nothing', async () => {
    const a = await dsA();
    const snapshot = JSON.stringify((await a.query(`SELECT * FROM customers WHERE id = $1`, [ids.a1]))[0]);
    const bad: Array<Record<string, string>> = [
      { email: 'not-an-email' },
      { partyType: 'robot' },
      { language: 'fr' },
      { name: '   ' },
      { legalName: 'x'.repeat(300) },
      { website: 'has spaces.test' },
    ];
    for (const input of bad) {
      await expect(svc.updateProfile(ids.a1, { ...input, internalNotes: 'must not be written' }, actor, a.manager)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(JSON.stringify((await a.query(`SELECT * FROM customers WHERE id = $1`, [ids.a1]))[0])).toBe(snapshot);
    await expect(svc.updateProfile(randomUUID(), { legalName: 'Nobody' }, actor, a.manager)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the customer's lifecycle and financial columns are never touched by a profile update", async () => {
    const a = await dsA();
    const keys = '"status","orderWorkflowPolicy","priceListId","creditLimit","paymentTermsDays","accountType","financialStatus","code","classification"';
    const before = (await a.query(`SELECT ${keys} FROM customers WHERE id = $1`, [ids.a1]))[0];
    await svc.updateProfile(ids.a1, { name: 'Alpha One Renamed', phone: '0100', managerName: 'Mona', legalName: 'Alpha One Renamed LLC' }, actor, a.manager);
    expect((await a.query(`SELECT ${keys} FROM customers WHERE id = $1`, [ids.a1]))[0]).toEqual(before);
    expect(before).toMatchObject({ creditLimit: '5000.00', paymentTermsDays: 30, financialStatus: 'on_hold' });
  });

  it('contacts: add needs a name; only one primary at a time; set-primary switches it; remove works; another customer\'s contact id is a 404', async () => {
    const a = await dsA();
    await expect(svc.addContact(ids.a1, { name: '  ' }, actor, a.manager)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.addContact(ids.a1, { name: 'Bad Mail', email: 'nope' }, actor, a.manager)).rejects.toBeInstanceOf(BadRequestException);
    expect(await count('customer_contacts', `"customerId" = '${ids.a1}'`)).toBe(0);

    const first = await svc.addContact(ids.a1, { name: 'Sara', title: 'Buyer', phone: '0111', email: 'sara@alpha.test', isPrimary: true }, actor, a.manager);
    const second = await svc.addContact(ids.a1, { name: 'Omar', isPrimary: true }, actor, a.manager);
    const primaries = async () => (await a.query(`SELECT name FROM customer_contacts WHERE "customerId" = $1 AND "isPrimary"`, [ids.a1])).map((r: { name: string }) => r.name);
    expect(await primaries()).toEqual(['Omar']);

    await svc.updateContact(ids.a1, first.id, { isPrimary: true }, actor, a.manager);
    expect(await primaries()).toEqual(['Sara']);
    const edited = await svc.updateContact(ids.a1, first.id, { title: 'Head buyer', phone: '' }, actor, a.manager);
    expect(edited).toMatchObject({ name: 'Sara', title: 'Head buyer', phone: null, email: 'sara@alpha.test' });

    // Customer A2 cannot touch customer A1's contact.
    await expect(svc.updateContact(ids.a2, second.id, { name: 'Hijack' }, actor, a.manager)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.removeContact(ids.a2, second.id, actor, a.manager)).rejects.toBeInstanceOf(NotFoundException);

    expect(await svc.removeContact(ids.a1, second.id, actor, a.manager)).toEqual({ removed: true });
    await expect(svc.removeContact(ids.a1, second.id, actor, a.manager)).rejects.toBeInstanceOf(NotFoundException);
    const profile = await svc.getProfile(ids.a1, a.manager);
    expect(profile.contacts.map((c) => c.name)).toEqual(['Sara']);
  });

  it('addresses: one default; billing/shipping flags; set-default switches it; the legacy single address on the customer is untouched', async () => {
    const a = await dsA();
    await svc.updateProfile(ids.a1, { address: 'Legacy line 1', governorate: 'Cairo' }, actor, a.manager);
    await expect(svc.addAddress(ids.a1, { addressLine: '' }, actor, a.manager)).rejects.toBeInstanceOf(BadRequestException);

    const hq = await svc.addAddress(ids.a1, { label: 'HQ', addressLine: '1 Nile St', city: 'Giza', isDefault: true, isBilling: true }, actor, a.manager);
    const wh = await svc.addAddress(ids.a1, { label: 'Warehouse', addressLine: '9 Ring Rd', isShipping: true, isDefault: true }, actor, a.manager);
    const defaults = async () => (await a.query(`SELECT label FROM customer_addresses WHERE "customerId" = $1 AND "isDefault"`, [ids.a1])).map((r: { label: string }) => r.label);
    expect(await defaults()).toEqual(['Warehouse']);
    await svc.updateAddress(ids.a1, hq.id, { isDefault: true }, actor, a.manager);
    expect(await defaults()).toEqual(['HQ']);
    expect(wh.isShipping).toBe(true);
    expect((await svc.getProfile(ids.a1, a.manager)).addresses.map((x) => x.label)).toEqual(['HQ', 'Warehouse']); // default first
    const legacy = (await a.query(`SELECT address, governorate FROM customers WHERE id = $1`, [ids.a1]))[0];
    expect(legacy).toEqual({ address: 'Legacy line 1', governorate: 'Cairo' });

    await expect(svc.updateAddress(ids.a2, hq.id, { city: 'Hijack' }, actor, a.manager)).rejects.toBeInstanceOf(NotFoundException);
    expect(await svc.removeAddress(ids.a1, wh.id, actor, a.manager)).toEqual({ removed: true });
    await expect(svc.removeAddress(ids.a1, wh.id, actor, a.manager)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('concurrency: two writers both claiming primary / default never leave two of them (one wins, the other is a clean conflict or also succeeds in order)', async () => {
    const a = await dsA();
    const outcomes = await Promise.allSettled([
      svc.addContact(ids.a2, { name: 'Racer 1', isPrimary: true }, actor, a.manager),
      svc.addContact(ids.a2, { name: 'Racer 2', isPrimary: true }, actor, a.manager),
      svc.addAddress(ids.a2, { addressLine: 'Race St 1', isDefault: true }, actor, a.manager),
      svc.addAddress(ids.a2, { addressLine: 'Race St 2', isDefault: true }, actor, a.manager),
    ]);
    for (const o of outcomes) {
      if (o.status === 'rejected') expect(o.reason).toBeInstanceOf(ConflictException); // never a raw 500
    }
    expect(await count('customer_contacts', `"customerId" = '${ids.a2}' AND "isPrimary"`)).toBeLessThanOrEqual(1);
    expect(await count('customer_addresses', `"customerId" = '${ids.a2}' AND "isDefault"`)).toBeLessThanOrEqual(1);
    expect(outcomes.filter((o) => o.status === 'fulfilled').length).toBeGreaterThanOrEqual(2); // at least one of each pair wins
  });

  it("Company isolation: Company B has its own profile; Company A's customer is unknown to B; the other Company's DataSource is never requested", async () => {
    const a = await dsA();
    const b = await dsB();
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await svc.getProfile(ids.a1, a.manager);
      await svc.updateProfile(ids.a1, { website: 'https://alpha2.test' }, actor, a.manager);
    });
    await expect(svc.getProfile(ids.a1, b.manager)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.updateProfile(ids.a1, { legalName: 'Leak' }, actor, b.manager)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.addContact(ids.a1, { name: 'Leak' }, actor, b.manager)).rejects.toBeInstanceOf(NotFoundException);

    await svc.addContact(ids.b1, { name: 'Beta Contact', isPrimary: true }, actor, b.manager);
    const beta = await svc.getProfile(ids.b1, b.manager);
    expect(beta.contacts.map((c) => c.name)).toEqual(['Beta Contact']);
    expect(beta.customer.legalName).toBeNull();
    expect(Number((await b.query(`SELECT COUNT(*) AS n FROM customer_addresses`))[0].n)).toBe(0);
    expect((await svc.getProfile(ids.a1, a.manager)).contacts.map((c) => c.name)).not.toContain('Beta Contact');
  });

  it('migrations roll back and re-apply: down drops exactly the new columns/tables (old data intact), up restores them', async () => {
    const a = await dsA();
    const qr = a.createQueryRunner();
    try {
      const oldColumns = async () => (await qr.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'customers' AND column_name = ANY($1)`, [['partyType', 'legalName', 'email', 'internalNotes']])).length;
      const tables = async () => Number((await qr.query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name IN ('customer_addresses','customer_contacts')`))[0].n);
      const nameBefore = (await qr.query(`SELECT name, code, "creditLimit" FROM customers WHERE id = $1`, [ids.a1]))[0];

      await new CreateCustomerAddressesAndContacts1790016100000().down(qr);
      await new AddCustomerProfileFields1790016000000().down(qr);
      expect(await tables()).toBe(0);
      expect(await oldColumns()).toBe(0);
      expect((await qr.query(`SELECT name, code, "creditLimit" FROM customers WHERE id = $1`, [ids.a1]))[0]).toEqual({ ...nameBefore, name: 'Alpha One Renamed' }); // the earlier rename is existing-column data, kept

      await new AddCustomerProfileFields1790016000000().up(qr);
      await new CreateCustomerAddressesAndContacts1790016100000().up(qr);
      expect(await tables()).toBe(2);
      expect(await oldColumns()).toBe(4);
    } finally {
      await qr.release();
    }
  });
});
