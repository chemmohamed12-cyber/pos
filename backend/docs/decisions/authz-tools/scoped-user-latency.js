require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard-register')); // DB guard (M-R2 §11): default deny, all layers — no connection to an unapproved database
// Scoped-user latency benchmark (CTO Phase 3): ADMINISTRATOR vs SCOPED USER on the same build, same environment, same endpoints, interleaved, plus the pre-F1 build
// (port 3602) as the approved baseline. Per endpoint: N requests per session (default 100), P50 / P95 / P99, every non-200 counted (a run with any is discarded by the
// aggregator), and EXACT DB statements per request, counted at the application's `pg` client on a separate measurement-only backend instance (3603, started with the
// scratchpad preload `count-queries.js`, counter on 127.0.0.1:3699). The Throttler (300 requests/minute/IP PER HANDLER) is respected: ≤ 210 requests per handler per session
// and a 61 s pause between endpoints that share a handler (list / page). Test identities only (@perf.example.test). usage: node scoped-user-latency.js <out.json>
const API = (port) => `http://127.0.0.1:${port}/api`;
const J = { 'Content-Type': 'application/json' };
const base = 'D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/';
const { Client } = require(base + 'node_modules/pg');
const N = Number(process.env.PERF_N || 100);
const PW = process.env.BV_TEST_PASSWORD;
const NEW_PW = 'Perf-Scoped-Pass#2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(port, tok, method, path, body) {
  const r = await fetch(API(port) + path, { method, headers: { ...J, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch { /* none */ }
  return { s: r.status, d: j.data !== undefined ? j.data : j };
}
const login = async (port, email, password) => (await call(port, null, 'POST', '/auth/login', { email, password })).d.accessToken;
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
(async () => {
  const out = process.argv[2];
  if (!out) throw new Error('out file required');
  const cp = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: 'bv_cp' }); await cp.connect();
  const verify = (await cp.query(`SELECT c.id, d."databaseName" db FROM companies c JOIN database_registries d ON d."companyId" = c.id WHERE c.name = 'Verify Co'`)).rows[0];
  const co = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: verify.db }); await co.connect();
  const stamp = Date.now();
  const adminTok = async (port) => {
    const l = await login(port, 'bv.approver@example.test', PW);
    return (await call(port, l, 'POST', '/auth/select-company', { companyId: verify.id })).d.accessToken;
  };
  const adm = await adminTok(3601);
  // scoped fixture: a branch, a warehouse linked to it, an operator role, one user holding an explicit grant on the branch
  const unit = (await call(3601, adm, 'POST', '/organization/units', { type: 'branch', name: `Perf Branch ${stamp}` })).d;
  const wh = (await call(3601, adm, 'POST', '/inventory/warehouses', { code: `PERF-${stamp}`.slice(0, 30), name: 'Perf warehouse', orgUnitId: unit.id })).d;
  const role = (await call(3601, adm, 'POST', '/company/roles', { nameEn: `Perf Operator ${stamp}`, grants: [{ node: 'inventory', access: 'editable' }, { node: 'procurement', access: 'editable' }, { node: 'sales', access: 'editable' }, { node: 'wf.sales.order.list_all', access: 'editable' }, { node: 'wf.sales.order.read_any', access: 'editable' }] })).d;
  const email = `perf.scoped.${stamp}@perf.example.test`;
  const inv = (await call(3601, adm, 'POST', '/company/users/invitations', { email, fullName: 'Perf Scoped', roleKeys: [role.key] })).d;
  await call(3601, null, 'POST', '/invitations/register', { token: inv.token, fullName: 'Perf Scoped', password: NEW_PW });
  const uid = (await call(3601, adm, 'GET', '/company/users')).d.find((u) => u.email === email).userId;
  await call(3601, adm, 'PUT', `/company/users/${uid}/scopes`, { grants: [{ orgUnitId: unit.id, includeDescendants: true }] });
  await sleep(65000); // login throttle window
  const scTok = (await call(3601, await login(3601, email, NEW_PW), 'POST', '/auth/select-company', { companyId: verify.id })).d.accessToken;
  const pre = await adminTok(3602);
  const orderId = (await call(3601, adm, 'GET', '/sales-orders')).d[0].id;
  const eps = [
    ['sales-orders list', '/sales-orders'],
    ['sales-orders page', '/sales-orders?page=1&pageSize=50'],
    ['sales-orders/:id (record guard)', `/sales-orders/${orderId}`],
    ['purchase-orders', '/procurement/purchase-orders'],
    ['purchase-requests', '/procurement/purchase-requests'],
    ['inventory/warehouses', '/inventory/warehouses'],
    ['inventory/stock (query guard)', `/inventory/stock?warehouseId=${wh.id}&productId=${(await call(3601, adm, 'GET', '/products')).d[0].id}`],
    ['inventory/reports/stock', '/inventory/reports/stock'],
    ['warehouse-transactions page', '/warehouse-transactions?page=1&pageSize=50'],
    ['warehouse-transactions/overview', '/warehouse-transactions/overview'],
  ];
  const sessions = { preAdmin: { port: 3602, tok: pre }, curAdmin: { port: 3601, tok: adm }, curScoped: { port: 3601, tok: scTok } };
  const time = async (s, p) => { const t = process.hrtime.bigint(); const r = await fetch(API(s.port) + p, { headers: { Authorization: 'Bearer ' + s.tok } }); await r.text(); return [Number(process.hrtime.bigint() - t) / 1e6, r.status]; };
  const counter = async (reset) => Number(await (await fetch('http://127.0.0.1:3699/' + (reset ? 'reset' : ''))).text());
  const cnt = { admin: await adminTok(3603), scoped: (await call(3603, await login(3603, email, NEW_PW), 'POST', '/auth/select-company', { companyId: verify.id })).d.accessToken };
  const result = [];
  for (const [name, p] of eps) {
    if (name === 'sales-orders page') await sleep(61000); // the list and the page share ONE handler and so ONE throttler bucket
    for (let i = 0; i < 5; i++) for (const s of Object.values(sessions)) await time(s, p); // warm-up
    const lat = { preAdmin: [], curAdmin: [], curScoped: [] }; const bad = { preAdmin: 0, curAdmin: 0, curScoped: 0 };
    const order = Object.keys(sessions);
    for (let i = 0; i < N; i++) {
      const rot = order.slice(i % 3).concat(order.slice(0, i % 3)); // rotate who goes first: no session is systematically warm/cold
      for (const k of rot) { const [ms, st] = await time(sessions[k], p); lat[k].push(ms); if (st !== 200) bad[k]++; }
    }
    // exact statements per request: 20 serial requests per identity on the counting instance (3603); the median of three batches
    const stm = {};
    for (const k of ['admin', 'scoped']) {
      const per = [];
      for (let b = 0; b < 3; b++) {
        await time({ port: 3603, tok: cnt[k] }, p); // warm
        await counter(true);
        for (let i = 0; i < 20; i++) await time({ port: 3603, tok: cnt[k] }, p);
        per.push((await counter(false)) / 20);
      }
      stm[k] = per.sort((x, y) => x - y)[1];
    }
    const row = { name, bad, stmPerRequest: { curAdmin: +stm.admin.toFixed(2), curScoped: +stm.scoped.toFixed(2) } };
    for (const k of order) row[k] = { p50: +pct(lat[k], 0.5).toFixed(1), p95: +pct(lat[k], 0.95).toFixed(1), p99: +pct(lat[k], 0.99).toFixed(1) };
    result.push(row);
  }
  // restore / tidy: deactivate the test warehouse, remove the test user and role
  await call(3601, adm, 'POST', `/inventory/warehouses/${wh.id}/status`, { status: 'inactive' });
  await call(3601, adm, 'DELETE', `/company/users/${uid}`);
  await call(3601, adm, 'DELETE', `/company/roles/${role.id}`);
  require('fs').writeFileSync(out, JSON.stringify({ n: N, rows: result }, null, 1));
  console.log('written', out);
  await co.end(); await cp.end();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
