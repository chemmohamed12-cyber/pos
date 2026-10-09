// Immediate-revocation proof over real HTTP on the optimised build (3601, isolated env). A bearer token obtained BEFORE the change must be refused/filtered on the very next request.
const API = (p) => `http://127.0.0.1:${p}/api`; const J = { 'Content-Type': 'application/json' }; const PORT = 3601;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (tok, m, path, body) => { const r = await fetch(API(PORT) + path, { method: m, headers: { ...J, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, d: j.data !== undefined ? j.data : j }; };
const results = []; const ok = (n, c, x = '') => { results.push(c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' — ' + x : '')); };
(async () => {
  const { Client } = require('D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/node_modules/pg');
  const cp = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: 'bv_cp' }); await cp.connect();
  const v = (await cp.query("select id from companies where name='Verify Co'")).rows[0]; await cp.end();
  const login = async (email, pw) => (await call(null, 'POST', '/auth/login', { email, password: pw })).d.accessToken;
  const adm = (await call(await login('bv.approver@example.test', process.env.BV_TEST_PASSWORD), 'POST', '/auth/select-company', { companyId: v.id })).d.accessToken;
  const stamp = Date.now(); const NEW = 'Revoke-Proof-Pass#2026';
  const unit = (await call(adm, 'POST', '/organization/units', { type: 'branch', name: `Revoke Branch ${stamp}` })).d;
  const wh = (await call(adm, 'POST', '/inventory/warehouses', { code: `RV-${stamp}`.slice(0, 30), name: 'Revoke warehouse', orgUnitId: unit.id })).d;
  const role = (await call(adm, 'POST', '/company/roles', { nameEn: `Revoke Operator ${stamp}`, grants: [{ node: 'inventory', access: 'editable' }, { node: 'procurement', access: 'editable' }] })).d;
  const email = `revoke.${stamp}@perf.example.test`;
  const inv = (await call(adm, 'POST', '/company/users/invitations', { email, fullName: 'Revoke Proof', roleKeys: [role.key] })).d;
  await call(null, 'POST', '/invitations/register', { token: inv.token, fullName: 'Revoke Proof', password: NEW });
  const uid = (await call(adm, 'GET', '/company/users')).d.find((u) => u.email === email).userId;
  await call(adm, 'PUT', `/company/users/${uid}/scopes`, { grants: [{ orgUnitId: unit.id, includeDescendants: true }] });
  await sleep(65000); // login throttle window
  const T = (await call(await login(email, NEW), 'POST', '/auth/select-company', { companyId: v.id })).d.accessToken; // ONE token for the whole proof
  const listIds = async () => ((await call(T, 'GET', '/inventory/warehouses')).d || []).map((w) => w.id);
  for (let i = 0; i < 6; i++) { await call(T, 'GET', '/inventory/reports/stock'); await call(T, 'GET', '/procurement/purchase-requests'); } // warm the prepared statement on every pooled connection
  ok('baseline: permitted + scoped user reads purchase requests (200) and sees the linked warehouse', (await call(T, 'GET', '/procurement/purchase-requests')).s === 200 && (await listIds()).includes(wh.id));
  // 1. scope revoked -> the very next request no longer lists the warehouse (same token, same pooled connections)
  await call(adm, 'PUT', `/company/users/${uid}/scopes`, { grants: [] });
  const after = []; for (let i = 0; i < 8; i++) after.push((await listIds()).includes(wh.id));
  ok('scope revoked: warehouse hidden on the very next request and on the 7 after (no stale prepared plan/data)', after.every((x) => x === false), JSON.stringify(after));
  // 2. scope granted again -> visible on the very next request
  await call(adm, 'PUT', `/company/users/${uid}/scopes`, { grants: [{ orgUnitId: unit.id, includeDescendants: true }] });
  ok('scope re-granted: warehouse visible on the very next request', (await listIds()).includes(wh.id));
  // 3. permission revoked (role grants emptied) -> next request denied
  const upd = await call(adm, 'PUT', `/company/roles/${role.id}`, { grants: [{ node: 'sales.customer.view', access: 'read-only' }] });
  const denied = []; for (let i = 0; i < 6; i++) denied.push((await call(T, 'GET', '/procurement/purchase-requests')).s);
  ok('permission revoked (purchase-requests, a guarded read): refused on the very next request and on the 5 after', upd.s === 200 && denied.every((s) => s === 404 || s === 403), JSON.stringify(denied));
  // 4. permission restored -> allowed on the very next request
  await call(adm, 'PUT', `/company/roles/${role.id}`, { grants: [{ node: 'inventory', access: 'editable' }, { node: 'procurement', access: 'editable' }] });
  ok('permission restored: allowed on the very next request', (await call(T, 'GET', '/procurement/purchase-requests')).s === 200);
  // 5. membership removed -> next request refused
  await call(adm, 'DELETE', `/company/users/${uid}`);
  const gone = (await call(T, 'GET', '/inventory/reports/stock')).s;
  ok('membership removed: refused on the very next request', gone === 403 || gone === 401 || gone === 404, 'status ' + gone);
  await call(adm, 'POST', `/inventory/warehouses/${wh.id}/status`, { status: 'inactive' });
  await call(adm, 'DELETE', `/company/roles/${role.id}`);
  console.log(results.every(Boolean) ? 'ALL PASS' : 'FAILURES');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
