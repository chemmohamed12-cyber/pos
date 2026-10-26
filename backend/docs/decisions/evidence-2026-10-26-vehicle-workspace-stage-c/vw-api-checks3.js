'use strict';
// Stage C acceptance over the REAL HTTP API of this worktree's build on the isolated verification DBs: driver-level authorization (direct API, other driver's vehicle), collections,
// handover, the separate expense float, reversal. Env as vw-prep-c.js. Writes pass/fail lines; exit 1 on any FAIL.
const fs = require('fs');
const B = 'http://127.0.0.1:' + process.env.RH_PORT + '/api';
const seed = JSON.parse(fs.readFileSync(process.env.RH_SCRATCH + '/vw-seed.json', 'utf8'));
const cred = Object.fromEntries(fs.readFileSync(process.env.RH_SCRATCH + '/driver.cred', 'utf8').split('\n').map((l) => l.split(' ')));
const checkerPw = fs.readFileSync(process.env.RH_SCRATCH + '/checker.cred', 'utf8').trim().split(/\s+/)[1];
const j = async (m, p, body, tok) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d: d && d.data !== undefined ? d.data : d, raw: d }; };
const out = []; let failed = 0;
const ok = (n, c, d = '') => { if (!c) failed++; const line = (c ? 'PASS ' : 'FAIL ') + n + (d ? ' :: ' + d : ''); out.push(line); console.log(line); };
const key = () => 'k' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
(async () => {
  const pg = require(process.env.RH_APP + '/node_modules/pg');
  const cp = new pg.Client({ host: process.env.DB_HOST, port: +process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.RH_MAIN }); await cp.connect();
  const companyId = (await cp.query('select id from companies limit 1')).rows[0].id; await cp.end();
  const login = async (email, pw) => { const l = await j('POST', '/auth/login', { email, password: pw }); return (await j('POST', '/auth/select-company', { companyId }, l.d.accessToken)).d.accessToken; };
  const D1 = await login('driver1@daii.example', cred['driver1@daii.example']);
  const D2 = await login('driver2@daii.example', cred['driver2@daii.example']);
  const A = await login('admin@daii.example', process.env.RH_ADMIN_PASSWORD);
  const C = await login('checker@daii.example', checkerPw);
  const fl = JSON.parse(fs.readFileSync(process.env.RH_SCRATCH + '/vw-float.json', 'utf8'));
  const ws = async (tok, v = seed.V1.id) => (await j('GET', `/vehicle-workspace/${v}`, undefined, tok));
  const w1 = (await ws(D1)).d;
  const cod = w1.shipments.find((s) => s.state === 'out_for_delivery' && Number(s.codAmount) > 0);
  const other = (await ws(A, seed.V2.id)).d.shipments.find((s) => s.driverUserId === seed.d2) || (await ws(A, seed.V2.id)).d.shipments[0];
  ok('setup: driver1 sees an out-for-delivery COD shipment on his vehicle and the float is assigned', !!cod && w1.reconciliation && w1.reconciliation.float.assigned, cod && cod.rshNumber);

  // ---- driver-level authorization (direct API, no UI)
  ok('AUTH driver1 -> driver2 vehicle workspace = 404', (await ws(D1, seed.V2.id)).s === 404);
  ok('AUTH driver2 -> driver1 vehicle workspace = 404', (await ws(D2, seed.V1.id)).s === 404);
  ok('AUTH driver1 -> driver2 vehicle reconciliation = 404', (await j('GET', `/delivery/custody-reconciliation/${seed.V2.id}`, undefined, D1)).s === 404);
  ok('AUTH driver1 may read his own reconciliation', (await j('GET', `/delivery/custody-reconciliation/${seed.V1.id}`, undefined, D1)).s === 200);
  if (other) {
    ok('AUTH driver1 cannot list another driver\'s shipment expenses', [403, 404].includes((await j('GET', `/delivery/custody-expenses?shipmentId=${other.id}`, undefined, D1)).s));
    ok('AUTH driver1 cannot read another driver\'s shipment line events', [403, 404].includes((await j('GET', `/delivery/line-events?shipmentId=${other.id}`, undefined, D1)).s));
    ok('AUTH driver1 cannot record a collection on another driver\'s shipment', [403, 404].includes((await j('POST', '/delivery/collections', { shipmentId: other.id, amount: '1.00', method: 'cash' }, D1)).s));
    ok('AUTH driver1 cannot claim an expense on another driver\'s shipment', [403, 404].includes((await j('POST', '/delivery/custody-expenses', { shipmentId: other.id, category: 'custody_fuel', amount: '1.00', reason: 'not mine' }, D1)).s));
  }
  ok('AUTH driver1 cannot declare a handover for another vehicle', [403, 404].includes((await j('POST', '/delivery/custody-handovers', { vehicleId: seed.V2.id, amount: '1.00' }, D1)).s));
  ok('AUTH driver1 cannot assign/unassign a float', [403, 404].includes((await j('POST', `/shipments/vehicles/${seed.V1.id}/expense-float`, {}, D1)).s));
  ok('AUTH driver1 cannot approve (decide) an expense', [403, 404].includes((await j('POST', '/delivery/custody-expenses/00000000-0000-4000-8000-000000000000/decide', { decision: 'approved' }, D1)).s));
  ok('AUTH driver1 cannot post an expense', [403, 404].includes((await j('POST', '/delivery/custody-expenses/00000000-0000-4000-8000-000000000000/post', {}, D1)).s));
  ok('AUTH driver1 cannot reverse an expense', [403, 404].includes((await j('POST', '/delivery/custody-expenses/00000000-0000-4000-8000-000000000000/reverse', { reason: 'nope' }, D1)).s));
  ok('AUTH driver1 cannot confirm/reject collections or handovers (finance permission)', [403, 404].includes((await j('POST', '/delivery/collections/00000000-0000-4000-8000-000000000000/confirm', {}, D1)).s) && [403, 404].includes((await j('POST', '/delivery/custody-handovers/00000000-0000-4000-8000-000000000000/decide', { decision: 'confirmed' }, D1)).s));
  ok('AUTH unauthenticated = 401', (await j('GET', `/vehicle-workspace/${seed.V1.id}`)).s === 401);

  // ---- collections: driver records, someone else confirms/rejects, idempotency, invariant
  const before = (await ws(D1)).d.shipments.find((s) => s.id === cod.id);
  const rem = Number(before.collectionTotals.remaining);
  const k1 = key();
  const c1 = await j('POST', '/delivery/collections', { shipmentId: cod.id, amount: '100.00', method: 'cash', clientKey: k1 }, D1);
  ok('COLL driver records an instalment', c1.s === 201 || c1.s === 200, c1.s + '');
  const c1b = await j('POST', '/delivery/collections', { shipmentId: cod.id, amount: '100.00', method: 'cash', clientKey: k1 }, D1);
  ok('COLL retry with the same clientKey returns the same collection (idempotent)', c1b.d.id === c1.d.id);
  const over = await j('POST', '/delivery/collections', { shipmentId: cod.id, amount: String(rem + 1), method: 'cash' }, D1);
  ok('COLL over-collection is refused by the server (409)', over.s === 409, JSON.stringify(over.d).slice(0, 120));
  ok('COLL the collector cannot confirm his own collection', [403].includes((await j('POST', `/delivery/collections/${c1.d.id}/confirm`, {}, D1)).s) || [403, 404].includes((await j('POST', `/delivery/collections/${c1.d.id}/confirm`, {}, D1)).s));
  const conf = await j('POST', `/delivery/collections/${c1.d.id}/confirm`, {}, C);
  ok('COLL a different finance user confirms it', conf.s < 300 && conf.d.verificationStatus === 'confirmed', conf.s + '');
  const c2 = await j('POST', '/delivery/collections', { shipmentId: cod.id, amount: '50.00', method: 'cash', clientKey: key() }, D1);
  const rej = await j('POST', `/delivery/collections/${c2.d.id}/reject`, { reason: 'cash was short at the counter' }, C);
  ok('COLL rejection (with reason) by a different user', rej.s < 300 && rej.d.verificationStatus === 'rejected');
  const after = (await ws(D1)).d.shipments.find((s) => s.id === cod.id);
  ok('COLL totals computed on the server: the rejected 50.00 does not count', Number(after.collectionTotals.counted) === Number(before.collectionTotals.counted) + 100, JSON.stringify(after.collectionTotals));

  // ---- handover
  const r0 = (await ws(D1)).d.reconciliation;
  const hv = await j('POST', '/delivery/custody-handovers', { vehicleId: seed.V1.id, amount: '60.00', clientKey: key() }, D1);
  ok('HANDOVER driver declares within the cash he is expected to carry', hv.s < 300, hv.s + ' ' + JSON.stringify(hv.d).slice(0, 100));
  const tooMuch = await j('POST', '/delivery/custody-handovers', { vehicleId: seed.V1.id, amount: String(Number(r0.derived.cashInDriverHand) + 1000) }, D1);
  ok('HANDOVER above the expected cash is refused (409)', tooMuch.s === 409);
  ok('HANDOVER the declarer cannot confirm his own handover', [403, 404].includes((await j('POST', `/delivery/custody-handovers/${hv.d.id}/decide`, { decision: 'confirmed' }, D1)).s));
  const hc = await j('POST', `/delivery/custody-handovers/${hv.d.id}/decide`, { decision: 'confirmed' }, C);
  ok('HANDOVER a different user confirms it', hc.s < 300 && hc.d.status === 'confirmed');

  // ---- expense float
  const rec0 = (await ws(D1)).d.reconciliation;
  const custodyBal0 = (await j('GET', `/shipments/vehicles/${seed.V1.id}/overview`, undefined, A)).d.custodyBalance;
  const noFloat = await j('POST', '/delivery/custody-expenses', { shipmentId: (await ws(A, seed.V2.id)).d.shipments[0].id, category: 'custody_fuel', amount: '10.00', reason: 'no float on this vehicle' }, A);
  ok('FLOAT a vehicle without a float cannot claim (409, fail closed)', noFloat.s === 409 && /No expense float/.test(JSON.stringify(noFloat.d)), JSON.stringify(noFloat.d).slice(0, 120));
  const badCat = await j('POST', '/delivery/custody-expenses', { shipmentId: cod.id, category: 'custody_unmapped', amount: '10.00', reason: 'category not mapped' }, D1);
  ok('FLOAT an unmapped category is refused (409)', badCat.s === 409);
  const ex = await j('POST', '/delivery/custody-expenses', { shipmentId: cod.id, category: 'custody_fuel', amount: '75.00', reason: 'Fuel for the trip', clientKey: key() }, D1);
  ok('FLOAT driver claims an expense (pending approval)', ex.s < 300 && ex.d.status === 'pending_approval' && ex.d.floatAccountId === fl.floatId, ex.s + '');
  ok('FLOAT the claimant cannot approve his own expense', [403, 404].includes((await j('POST', `/delivery/custody-expenses/${ex.d.id}/decide`, { decision: 'approved' }, D1)).s));
  ok('FLOAT posting before approval is refused', (await j('POST', `/delivery/custody-expenses/${ex.d.id}/post`, {}, A)).s === 409);
  const ap = await j('POST', `/delivery/custody-expenses/${ex.d.id}/decide`, { decision: 'approved' }, C);
  ok('FLOAT a separate approver approves', ap.s < 300 && ap.d.status === 'approved', ap.s + ' ' + JSON.stringify(ap.d).slice(0, 100));
  const po = await j('POST', `/delivery/custody-expenses/${ex.d.id}/post`, {}, A);
  ok('FLOAT explicit posting pays out of the float', po.s < 300 && po.d.status === 'posted', po.s + '');
  const rec1 = (await ws(A)).d.reconciliation;
  ok('FLOAT float balance fell by exactly 75.00', Number(rec1.float.balance) === Number(rec0.float.balance) - 75, rec0.float.balance + ' -> ' + rec1.float.balance);
  const custodyBal1 = (await j('GET', `/shipments/vehicles/${seed.V1.id}/overview`, undefined, A)).d.custodyBalance;
  ok('FLOAT customer-collection custody balance is untouched by the expense', Number(custodyBal1) === Number(custodyBal0), custodyBal0 + ' -> ' + custodyBal1);
  ok('FLOAT expense does not reduce the cash the driver must hand over', rec1.derived.cashInDriverHand === rec0.derived.cashInDriverHand);
  ok('FLOAT posting twice does not pay twice', (await j('POST', `/delivery/custody-expenses/${ex.d.id}/post`, {}, A)).d.treasuryTransactionId === po.d.treasuryTransactionId);
  const big = await j('POST', '/delivery/custody-expenses', { shipmentId: cod.id, category: 'custody_toll', amount: '99999.00', reason: 'larger than the float' }, D1);
  const big2 = await j('POST', `/delivery/custody-expenses/${big.d.id}/decide`, { decision: 'approved' }, C);
  const big3 = await j('POST', `/delivery/custody-expenses/${big.d.id}/post`, {}, A);
  ok('FLOAT an expense larger than the float is refused at posting (collections not used)', big3.s === 409 || big3.s >= 400, big3.s + ' ' + JSON.stringify(big3.d).slice(0, 110));
  await j('POST', `/delivery/custody-expenses/${big.d.id}/cancel`, { reason: 'cancelled after refusal' }, D1);
  const rv = await j('POST', `/delivery/custody-expenses/${ex.d.id}/reverse`, { reason: 'wrong shipment' }, A);
  ok('FLOAT finance reverses the posted expense', rv.s < 300 && rv.d.status === 'reversed', rv.s + '');
  const rec2 = (await ws(A)).d.reconciliation;
  ok('FLOAT float restored after the reversal', Number(rec2.float.balance) === Number(rec0.float.balance), rec2.float.balance);
  ok('FLOAT reconciliation difference is 0.00 (expected == actual)', rec2.float.difference === '0.00', JSON.stringify(rec2.float));

  fs.writeFileSync(process.env.RH_SCRATCH + '/vw-api-checks3.txt', out.join('\n') + '\n');
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
