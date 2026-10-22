'use strict';
/**
 * Stage B verification data (isolated DBs daii_test_biz_t96_vw_*): two drivers (company role `driver`), two vehicles created through the REAL API (custody warehouse + custody Treasury account
 * are provisioned by the product), shipments in every canonical state (SQL fixtures: the sales/fulfilment chain that normally creates them is covered by the regression suite), stock in
 * the vehicle's custody warehouse, and two COD collections recorded through the real API (one remitted by finance to the mapped bank account).
 */
const path = require('path');
const fs = require('fs');
const APP = process.env.RH_APP;
const nm = (p) => require(path.join(APP, 'node_modules', p));
const { Client } = nm('pg');
const bcrypt = nm('bcrypt');
const { randomUUID } = require('crypto');
const B = `http://127.0.0.1:${process.env.RH_PORT}/api`;
const j = async (m, p, body, tok) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d: d && d.data !== undefined ? d.data : d };
};
(async () => {
  const mk = (db) => new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: db });
  const cp = mk(process.env.RH_MAIN); await cp.connect();
  const co = mk(process.env.RH_CO); await co.connect();
  const companyId = (await cp.query('SELECT id FROM companies LIMIT 1')).rows[0].id;
  const driverRole = (await co.query("SELECT id FROM roles WHERE key = 'driver'")).rows[0].id;
  const creds = {};
  async function mkDriver(email, name) {
    const pw = 'Dr!' + randomUUID().replace(/-/g, '').slice(0, 12);
    const id = randomUUID();
    await cp.query('INSERT INTO users (id,"fullName",email,status) VALUES ($1,$2,$3,\'active\')', [id, name, email]);
    await cp.query('INSERT INTO credentials ("userId","passwordHash","passwordChangedAt") VALUES ($1,$2,now())', [id, await bcrypt.hash(pw, 10)]);
    await cp.query('INSERT INTO user_company_memberships (id,"userId","companyId","roleKey") VALUES ($1,$2,$3,\'driver\')', [randomUUID(), id, companyId]);
    await co.query('INSERT INTO users (id,"fullName",email,status) VALUES ($1,$2,$3,\'active\')', [id, name, email]);
    await co.query('INSERT INTO user_roles (id,"userId","roleId") VALUES ($1,$2,$3)', [randomUUID(), id, driverRole]);
    creds[email] = pw;
    return id;
  }
  const d1 = await mkDriver('driver1@daii.example', 'أحمد السائق');
  const d2 = await mkDriver('driver2@daii.example', 'محمود السائق');
  fs.writeFileSync(path.join(process.env.RH_SCRATCH, 'driver.cred'), Object.entries(creds).map(([k, v]) => `${k} ${v}`).join('\n'));

  const admin = await j('POST', '/auth/login', { email: 'admin@daii.example', password: process.env.RH_ADMIN_PASSWORD });
  const sel = await j('POST', '/auth/select-company', { companyId }, admin.d.accessToken);
  const A = sel.d.accessToken;
  const v1 = await j('POST', '/shipments/vehicles', { code: 'VH-101', plateNumber: 'ق ن ر 4821', driverUserId: d1, branch: 'فرع القاهرة' }, A);
  const v2 = await j('POST', '/shipments/vehicles', { code: 'VH-202', plateNumber: 'س ع د 7310', driverUserId: d2, branch: 'فرع الإسكندرية' }, A);
  if (v1.s !== 201 || v2.s !== 201) throw new Error('vehicle create failed ' + JSON.stringify([v1.s, v1.d, v2.s, v2.d]).slice(0, 300));
  const V1 = v1.d, V2 = v2.d;
  console.log('vehicles', V1.code, V1.custodyAccountId ? 'custody ok' : 'NO custody', V2.code);

  // master data fixtures
  const wh = (await co.query("SELECT id FROM warehouses WHERE code='WH-MAIN'")).rows[0].id;
  const prods = [];
  for (const [sku, name] of [['SKU-VW-1', 'مروحة سقف 56 بوصة'], ['SKU-VW-2', 'سخان مياه 50 لتر'], ['SKU-RH-1', null]]) {
    const ex = (await co.query('SELECT id FROM products WHERE sku=$1', [sku])).rows[0];
    if (ex) { prods.push(ex.id); continue; }
    const id = randomUUID();
    await co.query("INSERT INTO products (id,sku,name,\"unitPrice\",status) VALUES ($1,$2,$3,'250.00','active')", [id, sku, name]);
    prods.push(id);
  }
  const bank = (await co.query("SELECT id FROM treasury_accounts WHERE code='RH-BANK'")).rows[0].id;
  const adminUser = (await cp.query("SELECT id FROM users WHERE email='admin@daii.example'")).rows[0].id;
  // vehicle stock (custody warehouse): receipts into the vehicle's own warehouse
  for (const [pi, qty] of [[0, 12], [1, 6]]) await co.query("INSERT INTO stock_movements (id,\"warehouseId\",\"productId\",quantity,\"movementType\") VALUES ($1,$2,$3,$4,'receipt')", [randomUUID(), V1.warehouseId, prods[pi], qty]);

  const customers = [['CUST-VW1', 'شركة النور للتجهيزات', 'القاهرة'], ['CUST-VW2', 'مؤسسة الأمل التجارية', 'الجيزة'], ['CUST-VW3', 'مكتب الفجر الهندسي', 'القليوبية'], ['CUST-VW4', 'متجر السلام للأدوات', 'الإسكندرية']];
  const custIds = [];
  for (const [code, name] of customers) {
    const cid = randomUUID();
    await co.query("INSERT INTO customers (id,code,name,\"creditLimit\") VALUES ($1,$2,$3,'100000.00')", [cid, code, name]);
    custIds.push(cid);
  }
  let soSeq = 0;
  async function newOrder(ci) {
    const soId = randomUUID();
    const num = 'SO-VW-' + String(++soSeq).padStart(3, '0');
    await co.query("INSERT INTO sales_orders (id,\"orderNumber\",\"customerId\",\"salesRepUserId\",\"totalAmount\") VALUES ($1,$2,$3,$4,'1500.00')", [soId, num, custIds[ci], adminUser]);
    const lineId = randomUUID();
    await co.query("INSERT INTO sales_order_lines (id,\"salesOrderId\",\"productId\",quantity,\"unitPrice\",\"lineTotal\",\"discountAmount\",\"listPrice\") VALUES ($1,$2,$3,2,'250.00','500.00',0,'250.00')", [lineId, soId, prods[0]]);
    return { soId, num, lineId };
  }
  const states = [
    // vehicle, driver, state, cod, order index, age (hours)
    [V1, null, 'created', null, 0, 30],
    [V1, d1, 'assigned', null, 1, 26],
    [V1, d1, 'picked_up', '800.00', 2, 20],
    [V1, d1, 'in_transit', null, 3, 14],
    [V1, d1, 'out_for_delivery', '1200.00', 0, 10],
    [V1, d1, 'out_for_delivery', null, 1, 9],
    [V1, d1, 'delivered', '900.00', 2, 8],
    [V1, d1, 'delivered', '700.00', 3, 7],
    [V1, d1, 'failed', null, 0, 6],
    [V1, d1, 'returned', null, 1, 5],
    [V2, d2, 'assigned', null, 2, 4],
    [V2, d2, 'out_for_delivery', '450.00', 3, 3],
  ];
  const made = [];
  let n = 1;
  for (const [veh, drv, state, cod, oi, age] of states) {
    const sid = randomUUID(), fo = randomUUID();
    const o = await newOrder(oi);
    await co.query('INSERT INTO fulfillment_orders (id,"salesOrderId","warehouseId") VALUES ($1,$2,$3)', [fo, o.soId, wh]);
    const wb = 'WB-2026-' + String(100 + n).padStart(6, '0');
    await co.query(
      `INSERT INTO shipments (id,"fulfillmentOrderId","waybillNumber","driverUserId","vehicleId","codAmount","rshNumber","salesOrderId","salesOrderNumber","salesRepUserId","createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() - ($11 || ' hours')::interval)`,
      [sid, fo, wb, drv, veh.id, cod, 'RSH-2026-' + String(100 + n).padStart(6, '0'), o.soId, o.num, adminUser, String(age)],
    );
    await co.query("INSERT INTO process_instances (id,\"definitionKey\",\"entityType\",\"entityId\",\"currentState\") VALUES ($1,'shipment_lifecycle','shipment',$2,$3)", [randomUUID(), sid, state]);
    for (const [pi, q] of [[0, 2], [1, 1]]) {
      await co.query('INSERT INTO shipment_lines (id,"shipmentId","salesOrderLineId","productId",quantity,"unitPrice","lineTotal") VALUES ($1,$2,$3,$4,$5,\'250.00\',$6)', [randomUUID(), sid, o.lineId, prods[pi], q, String(q * 250) + '.00']);
    }
    made.push({ id: sid, wb, state, cod, driver: drv, vehicle: veh.code });
    n++;
  }
  // two real COD collections recorded through the product (custody cash_in into the vehicle's custody account); the first one is then remitted by finance
  const delivered = made.filter((m) => m.state === 'delivered');
  const c1 = await j('POST', '/delivery/collections', { shipmentId: delivered[0].id, amount: '900.00', method: 'cash' }, A);
  const c2 = await j('POST', '/delivery/collections', { shipmentId: delivered[1].id, amount: '700.00', method: 'cash' }, A);
  console.log('collections', c1.s, c2.s);
  if (c1.s === 201) console.log('remit', (await j('POST', `/delivery/collections/${c1.d.id}/remit`, { treasuryAccountId: bank }, A)).s);
  fs.writeFileSync(path.join(process.env.RH_SCRATCH, 'vw-seed.json'), JSON.stringify({ V1: { id: V1.id, code: V1.code }, V2: { id: V2.id, code: V2.code }, d1, d2, shipments: made }, null, 1));
  console.log('seeded', made.length, 'shipments; vehicle1', V1.id, 'vehicle2', V2.id);
  await cp.end(); await co.end();
})().catch((e) => { console.error(e); process.exit(1); });
