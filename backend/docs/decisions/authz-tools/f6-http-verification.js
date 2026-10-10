require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard-register')); // DB guard (M-R2 §11): default deny, all layers — no connection to an unapproved database
// F6 runtime verification over REAL HTTP against the booted backend (3601, isolated env). Test identities only (…@f6.example.test).
// Controlled scope pilot: two branches, scoped users, warehouse-keyed enforcement on inventory / warehouse transactions / PR / PO / GR / sales orders, instant effect of a
// grant, Effective Access Preview == the guards, containment, audit. Existing demo warehouses are linked to a test branch for the run and RESTORED at the end.
const API = 'http://127.0.0.1:3601/api';
const J = { 'Content-Type': 'application/json' };
const base = 'D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/';
const { Client } = require(base + 'node_modules/pg');
const out = [];
const ok = (name, cond, extra = '') => { out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  — ' + extra : '')); if (!cond) process.exitCode = 1; };
async function call(tok, method, path, body) {
  const r = await fetch(API + path, { method, headers: { ...J, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch { /* none */ }
  return { s: r.status, j, d: j.data !== undefined ? j.data : j, code: j.error && j.error.code };
}
const PW = process.env.BV_TEST_PASSWORD;
const NEW_PW = 'F6-Http-Pass#2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (email, password = PW) => (await call(null, 'POST', '/auth/login', { email, password })).d.accessToken;
const enter = async (tok, companyId) => (await call(tok, 'POST', '/auth/select-company', { companyId })).d.accessToken;
(async () => {
  const cp = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: 'bv_cp' }); await cp.connect();
  const verify = (await cp.query(`SELECT c.id, d."databaseName" db FROM companies c JOIN database_registries d ON d."companyId" = c.id WHERE c.name = 'Verify Co'`)).rows[0];
  const co = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: verify.db }); await co.connect();
  const stamp = Date.now();
  const approver = await login('bv.approver@example.test');
  const tokV = await enter(approver, verify.id); // Verify Co administrator (unrestricted)
  const tidy = async () => { for (const m of (await call(tokV, 'GET', '/company/users')).d.filter((x) => x.email.endsWith('@f6.example.test'))) await call(tokV, 'DELETE', `/company/users/${m.userId}`); };
  await tidy();

  // ---- setup: two branches, three new warehouses, existing warehouses linked to branch Y for the run ----
  const unitX = (await call(tokV, 'POST', '/organization/units', { type: 'branch', name: `F6 Branch X ${stamp}` })).d;
  const unitY = (await call(tokV, 'POST', '/organization/units', { type: 'branch', name: `F6 Branch Y ${stamp}` })).d;
  const mkWh = async (code, orgUnitId) => (await call(tokV, 'POST', '/inventory/warehouses', { code: `${code}-${stamp}`.slice(0, 30), name: `F6 ${code}`, ...(orgUnitId ? { orgUnitId } : {}) })).d;
  const WX = await mkWh('WX', unitX.id), WY = await mkWh('WY', unitY.id), WU = await mkWh('WU', null);
  ok('setup: branches X / Y and warehouses linked X / Y / unlinked (create-with-link accepted)', [unitX, unitY, WX, WY, WU].every((x) => x && x.id) && WX.orgUnitId === unitX.id && WY.orgUnitId === unitY.id && !WU.orgUnitId, `WX.org=${WX && WX.orgUnitId}`);
  const orders = (await call(tokV, 'GET', '/sales-orders')).d, pos = (await call(tokV, 'GET', '/procurement/purchase-orders')).d;
  const orderE = orders.find((o) => o.warehouseId), orderNoWh = orders.find((o) => !o.warehouseId);
  const poE = pos.find((p) => p.warehouseId);
  const linked = [...new Set([orderE && orderE.warehouseId, poE && poE.warehouseId].filter(Boolean))];
  const prior = {};
  for (const w of linked) { prior[w] = ((await call(tokV, 'GET', '/inventory/warehouses')).d.find((x) => x.id === w) || {}).orgUnitId || null; await call(tokV, 'POST', `/inventory/warehouses/${w}/org-unit`, { orgUnitId: unitY.id }); }
  const E = orderE && orderE.warehouseId;
  ok('setup: the demo warehouse that holds the existing order / PO is linked to branch Y (audited)', linked.length >= 1 && (await co.query(`SELECT count(*)::int n FROM audit_records WHERE action = 'inventory.warehouse.org_unit_changed'`)).rows[0].n >= linked.length, `linked ${linked.length}`);

  // ---- identities ----
  const products = (await call(tokV, 'GET', '/products')).d;
  const P = products[0].id;
  const role = await call(tokV, 'POST', '/company/roles', { nameEn: `F6 Operator ${stamp}`, grants: [{ node: 'inventory', access: 'editable' }, { node: 'procurement', access: 'editable' }, { node: 'sales', access: 'editable' }, { node: 'wf.sales.order.list_all', access: 'editable' }, { node: 'wf.sales.order.read_any', access: 'editable' }] });
  ok('setup: an operator role (inventory / procurement / sales module access + order visibility rules)', role.s === 201, `status ${role.s} ${role.code || ''}`);
  let regs = 0;
  const mk = async (label) => {
    if (regs > 0 && regs % 4 === 0) await sleep(65000);
    regs++;
    const email = `f6.${label}.${stamp}@f6.example.test`;
    const inv = await call(tokV, 'POST', '/company/users/invitations', { email, fullName: `F6 ${label}`, roleKeys: [role.d.key] });
    const reg = await call(null, 'POST', '/invitations/register', { token: inv.d && inv.d.token, fullName: `F6 ${label}`, password: NEW_PW });
    const id = ((await call(tokV, 'GET', '/company/users')).d.find((u) => u.email === email) || {}).userId;
    return { label, email, id, st: [inv.s, reg.s] };
  };
  const U = { x: await mk('x'), y: await mk('y'), n: await mk('n') };
  ok('setup: three operators with the SAME permissions (the only difference is scope)', Object.values(U).every((u) => u.id && u.st[0] === 201 && u.st[1] === 201), JSON.stringify(Object.values(U).map((u) => u.st)));
  await call(tokV, 'POST', `/organization/units/${unitX.id}/members`, { userId: U.x.id }); // x: BELONGS to branch X (membership = scope source, compatibility)
  const grantY = await call(tokV, 'PUT', `/company/users/${U.y.id}/scopes`, { grants: [{ orgUnitId: unitY.id, includeDescendants: true }] }); // y: explicit grant on branch Y
  ok('scope management: an explicit grant is recorded (200) with before/after and the effective scope', grantY.s === 200 && grantY.d.after.length === 1 && grantY.d.effective.units.some((u) => u.id === unitY.id), `status ${grantY.s}`);
  await sleep(60000); // login throttle window
  const T = { a: tokV };
  for (const k of ['x', 'y', 'n']) T[k] = await enter(await login(U[k].email, NEW_PW), verify.id);
  const meY = (await call(T.y, 'GET', '/auth/me')).d;
  ok('/auth/me: scopes.orgUnitIds carries the granted unit (and the membership unit for x)', meY.scopes.orgUnitIds.includes(unitY.id) && (await call(T.x, 'GET', '/auth/me')).d.scopes.orgUnitIds.includes(unitX.id) && meY.scopes.unrestricted === false);

  // ---- warehouses list ----
  const names = async (k) => new Set((await call(T[k], 'GET', '/inventory/warehouses')).d.map((w) => w.id));
  const sa = await names('a'), sx = await names('x'), sy = await names('y'), sn = await names('n');
  ok('GET /inventory/warehouses: administrator sees all; x sees X + unlinked, not Y; y sees Y + unlinked, not X; n (no scope) sees only unlinked', [WX, WY, WU].every((w) => sa.has(w.id)) && sx.has(WX.id) && sx.has(WU.id) && !sx.has(WY.id) && sy.has(WY.id) && sy.has(WU.id) && !sy.has(WX.id) && sn.has(WU.id) && !sn.has(WX.id) && !sn.has(WY.id));
  if (E) ok('the demo warehouse linked to Y is hidden from x and n, visible to y and the administrator', !sx.has(E) && !sn.has(E) && sy.has(E) && sa.has(E));

  // ---- inventory: addressing a warehouse ----
  const st = async (k, w) => (await call(T[k], 'GET', `/inventory/stock?warehouseId=${w}&productId=${P}`)).s;
  ok('GET /inventory/stock: out of scope = 404 (never 403), in scope = 200, unlinked = 200 for everyone', (await st('x', WY.id)) === 404 && (await st('y', WY.id)) === 200 && (await st('n', WX.id)) === 404 && (await st('x', WX.id)) === 200 && (await st('n', WU.id)) === 200 && (await st('a', WY.id)) === 200);
  ok('GET /inventory/warehouses/:id/inventory and POST …/items: out of scope 404; assigning items by an in-scope operator reaches validation (400), not the scope wall', (await call(T.x, 'GET', `/inventory/warehouses/${WY.id}/inventory`)).s === 404 && (await call(T.y, 'GET', `/inventory/warehouses/${WY.id}/inventory`)).s === 200 && (await call(T.x, 'POST', `/inventory/warehouses/${WY.id}/items`, { productIds: [] })).s === 404 && (await call(T.y, 'POST', `/inventory/warehouses/${WY.id}/items`, { productIds: [] })).s === 400);
  ok('POST /inventory/warehouses/:id/org-unit and /status are scope-walled too (x cannot re-link or deactivate Y\'s warehouse); linking to a unit outside the caller\'s scope is a 404', (await call(T.x, 'POST', `/inventory/warehouses/${WY.id}/org-unit`, { orgUnitId: null })).s === 404 && (await call(T.x, 'POST', `/inventory/warehouses/${WY.id}/status`, { status: 'inactive' })).s === 404 && (await call(T.x, 'POST', `/inventory/warehouses/${WX.id}/org-unit`, { orgUnitId: unitY.id })).s === 404);
  const rowsOf = (r) => (Array.isArray(r.d) ? r.d : []);
  const stockX = rowsOf(await call(T.x, 'GET', '/inventory/reports/stock')), stockY = rowsOf(await call(T.y, 'GET', '/inventory/reports/stock')), stockA = rowsOf(await call(T.a, 'GET', '/inventory/reports/stock'));
  if (E) ok('reports/stock is filtered BEFORE aggregation: x and n see no row of the Y-linked demo warehouse; y and the administrator do', !stockX.some((r) => r.warehouseId === E) && stockY.some((r) => r.warehouseId === E) === stockA.some((r) => r.warehouseId === E) && !rowsOf(await call(T.n, 'GET', '/inventory/reports/stock')).some((r) => r.warehouseId === E), `A rows ${stockA.length} / X ${stockX.length} / Y ${stockY.length}`);
  const movX = rowsOf(await call(T.x, 'GET', '/inventory/reports/movements')), movA = rowsOf(await call(T.a, 'GET', '/inventory/reports/movements'));
  ok('reports/movements: every movement x sees belongs to a warehouse x may see', movX.every((m) => sx.has(m.warehouseId)) && movA.length >= movX.length);
  ok('reports/*?warehouseId= of an out-of-scope warehouse is a 404', (await call(T.x, 'GET', `/inventory/reports/stock?warehouseId=${WY.id}`)).s === 404 && (await call(T.x, 'GET', `/inventory/reports/movements?warehouseId=${WY.id}`)).s === 404);

  // ---- warehouse transactions ----
  const countY = await call(T.y, 'POST', '/warehouse-transactions/count', { warehouseId: WY.id, productIds: [P] });
  const txY = countY.d && countY.d.id;
  ok('POST /warehouse-transactions/count: y counts in Y (201); x is refused in Y (404) before anything is created', countY.s === 201 && !!txY && (await call(T.x, 'POST', '/warehouse-transactions/count', { warehouseId: WY.id, productIds: [P] })).s === 404, `status ${countY.s}`);
  ok('POST /warehouse-transactions: creating in a warehouse outside the scope is a 404 — for the source AND for a transfer destination', (await call(T.x, 'POST', '/warehouse-transactions', { type: 'receipt', warehouseId: WY.id, lines: [] })).s === 404 && (await call(T.x, 'POST', '/warehouse-transactions', { type: 'transfer', warehouseId: WX.id, destinationWarehouseId: WY.id, lines: [] })).s === 404);
  const listTx = async (k) => (await call(T[k], 'GET', '/warehouse-transactions')).d.map((t) => t.id);
  ok('GET /warehouse-transactions: x does NOT see the transaction of Y; y and the administrator do', !(await listTx('x')).includes(txY) && (await listTx('y')).includes(txY) && (await listTx('a')).includes(txY));
  ok('…/:id, …/:id/lines, …/:id/transition on a transaction of Y: x = 404; y = 200', (await call(T.x, 'GET', `/warehouse-transactions/${txY}`)).s === 404 && (await call(T.x, 'GET', `/warehouse-transactions/${txY}/lines`)).s === 404 && (await call(T.x, 'POST', `/warehouse-transactions/${txY}/transition`, { action: 'submit' })).s === 404 && (await call(T.y, 'GET', `/warehouse-transactions/${txY}`)).s === 200 && (await call(T.y, 'GET', `/warehouse-transactions/${txY}/lines`)).s === 200);
  const pageX = (await call(T.x, 'GET', '/warehouse-transactions?page=1&pageSize=50')).d;
  ok('the paginated list applies the same filter (total excludes Y\'s transaction for x)', pageX.rows && !pageX.rows.some((t) => t.id === txY));
  const ovX = (await call(T.x, 'GET', '/warehouse-transactions/overview')).d, ovA = (await call(T.a, 'GET', '/warehouse-transactions/overview')).d;
  ok('overview KPIs describe only the caller\'s visible warehouses (x: warehouse count = visible set; administrator: all)', ovX.totalWarehouses === sx.size && ovA.totalWarehouses === sa.size && ovX.totalWarehouses < ovA.totalWarehouses, `x ${ovX.totalWarehouses} / admin ${ovA.totalWarehouses}`);

  // ---- procurement: PR / PO / GR ----
  const prLine = { productId: P, quantity: '5' };
  const prY = await call(T.y, 'POST', '/procurement/purchase-requests', { warehouseId: WY.id, lines: [prLine] });
  const prIdY = prY.d && prY.d.purchaseRequest ? prY.d.purchaseRequest.id : prY.d && prY.d.id;
  ok('PR: y creates in Y (201); x creating in Y is a 404; x creating in X works (201)', prY.s === 201 && !!prIdY && (await call(T.x, 'POST', '/procurement/purchase-requests', { warehouseId: WY.id, lines: [prLine] })).s === 404 && (await call(T.x, 'POST', '/procurement/purchase-requests', { warehouseId: WX.id, lines: [prLine] })).s === 201, `status ${prY.s}`);
  const prList = async (k) => (await call(T[k], 'GET', '/procurement/purchase-requests')).d.map((p) => p.id);
  ok('PR list is filtered (x does not see Y\'s request; y and the administrator do); detail and every transition of Y\'s request are 404 for x', !(await prList('x')).includes(prIdY) && (await prList('y')).includes(prIdY) && (await prList('a')).includes(prIdY) && (await call(T.x, 'GET', `/procurement/purchase-requests/${prIdY}`)).s === 404 && (await call(T.y, 'GET', `/procurement/purchase-requests/${prIdY}`)).s === 200 && (await Promise.all(['submit', 'approve', 'reject', 'cancel'].map((a) => call(T.x, 'POST', `/procurement/purchase-requests/${prIdY}/${a}`)))).every((r) => r.s === 404));
  const poList = async (k) => (await call(T[k], 'GET', '/procurement/purchase-orders')).d;
  const poX = await poList('x');
  ok('PO list: every order x sees sits in a warehouse x may see (the Y-linked demo warehouse is hidden)', poX.every((p) => sx.has(p.warehouseId)) && (await poList('a')).length >= poX.length);
  if (poE) {
    ok('PO of a hidden warehouse: detail + every transition 404 for x, 200 for y; creating a PO in Y is a 404 for x', (await call(T.x, 'GET', `/procurement/purchase-orders/${poE.id}`)).s === 404 && (await call(T.y, 'GET', `/procurement/purchase-orders/${poE.id}`)).s === 200 && (await Promise.all(['submit', 'approve', 'reject', 'cancel'].map((a) => call(T.x, 'POST', `/procurement/purchase-orders/${poE.id}/${a}`)))).every((r) => r.s === 404) && (await call(T.x, 'POST', '/procurement/purchase-orders', { warehouseId: WY.id, supplierId: poE.supplierId, lines: [] })).s === 404);
    ok('GR derives its scope from the PO: listing / posting receipts against a hidden PO is a 404 for x, allowed for y', (await call(T.x, 'GET', `/procurement/goods-receipts/by-purchase-order/${poE.id}`)).s === 404 && (await call(T.y, 'GET', `/procurement/goods-receipts/by-purchase-order/${poE.id}`)).s === 200 && (await call(T.x, 'POST', '/procurement/goods-receipts', { purchaseOrderId: poE.id, lines: [] })).s === 404);
  }

  // ---- sales orders ----
  const soList = async (k) => (await call(T[k], 'GET', '/sales-orders')).d;
  if (orderE) {
    const lx = await soList('x'), ly = await soList('y'), la = await soList('a');
    ok('SO list: x does not see the order of the Y-linked warehouse; y and the administrator do; an order WITHOUT a warehouse (legacy) stays visible to everyone', !lx.some((o) => o.id === orderE.id) && ly.some((o) => o.id === orderE.id) && la.some((o) => o.id === orderE.id) && (!orderNoWh || (lx.some((o) => o.id === orderNoWh.id) && ly.some((o) => o.id === orderNoWh.id))), `A ${la.length} / X ${lx.length} / Y ${ly.length}`);
    const pg = (await call(T.x, 'GET', '/sales-orders?page=1&pageSize=50')).d;
    ok('SO paginated list: the same filter (total counts only visible orders)', pg.rows && !pg.rows.some((o) => o.id === orderE.id) && pg.total === lx.length, `total ${pg.total}`);
    ok('SO detail / lines / edit-history / transition / draft edit / delete on a hidden order: 404 for x; detail 200 for y', (await call(T.x, 'GET', `/sales-orders/${orderE.id}`)).s === 404 && (await call(T.y, 'GET', `/sales-orders/${orderE.id}`)).s === 200 && (await call(T.x, 'GET', `/sales-orders/${orderE.id}/edit-history`)).s === 404 && (await call(T.x, 'POST', `/sales-orders/${orderE.id}/transition`, { action: 'submit' })).s === 404 && (await call(T.x, 'POST', `/sales-orders/${orderE.id}/lines`, { lines: [] })).s === 404 && (await call(T.x, 'POST', `/sales-orders/${orderE.id}/draft-lines`, { lines: [] })).s === 404 && (await call(T.x, 'POST', `/sales-orders/${orderE.id}/delete`)).s === 404);
    ok('POST /sales-orders: creating an order in a warehouse outside the scope is a 404; /inventory/reservations/by-order of a hidden order is a 404', (await call(T.x, 'POST', '/sales-orders', { warehouseId: E, customerId: orderE.customerId, lines: [] })).s === 404 && (await call(T.x, 'GET', `/inventory/reservations/by-order?salesOrderId=${orderE.id}`)).s === 404 && (await call(T.y, 'GET', `/inventory/reservations/by-order?salesOrderId=${orderE.id}`)).s === 200);
  }

  // ---- a grant is effective on the very next call; removal likewise ----
  await call(tokV, 'PUT', `/company/users/${U.n.id}/scopes`, { grants: [{ orgUnitId: unitX.id, includeDescendants: false }] });
  ok('a new grant is effective immediately (no re-login): n now sees X\'s warehouse', (await names('n')).has(WX.id) && (await st('n', WX.id)) === 200);
  await call(tokV, 'PUT', `/company/users/${U.n.id}/scopes`, { grants: [] });
  ok('removing the grant is effective immediately: n is back to the unlinked warehouses only', !(await names('n')).has(WX.id) && (await st('n', WX.id)) === 404);

  // ---- Effective Access Preview == guards ----
  let agree = 0, total = 0, mismatches = [];
  for (const k of ['x', 'y', 'n']) for (const [label, w] of [['X', WX], ['Y', WY], ['U', WU]]) {
    const pv = (await call(tokV, 'GET', `/company/users/${U[k].id}/effective-access?node=inventory.warehouse.edit&level=editable&warehouseId=${w.id}`)).d.decision;
    const real = await call(T[k], 'POST', `/inventory/warehouses/${w.id}/items`, { productIds: [] }); // 404 = a guard refused; 400 = reached validation (guards passed)
    const guardAllowed = real.s !== 404 && real.s !== 403;
    total++; if (pv.allowed === guardAllowed) agree++; else mismatches.push(`${k}/${label} preview=${pv.allowed} guard=${real.s}`);
  }
  ok('Effective Access Preview ≡ the guards: the preview decision equals the real HTTP outcome for 3 users × 3 warehouses', agree === total, `${agree}/${total} ${mismatches.join('; ')}`);
  const pvScope = (await call(tokV, 'GET', `/company/users/${U.x.id}/effective-access?node=inventory.warehouse.edit&level=editable&warehouseId=${WY.id}`)).d;
  ok('the preview names the layer that refuses (scope, not permission) and lists visible / hidden warehouses', pvScope.decision.refusedBy === 'scope' && pvScope.scope.warehouses.hidden.some((w) => w.id === WY.id) && pvScope.scope.warehouses.visible.some((w) => w.id === WX.id));
  const pvPerm = (await call(tokV, 'GET', `/company/users/${U.x.id}/effective-access?node=accounting.journal.post&level=editable`)).d;
  ok('…and names permission when the node itself is not held', pvPerm.decision.allowed === false && pvPerm.decision.refusedBy === 'permission');

  // ---- management surface: allow / deny / validation ----
  ok('scope management is administration-only: an operator (no members.manage) cannot read or write scopes; unknown unit = 400; a non-member = 404; no token = 401', [(await call(T.x, 'GET', `/company/users/${U.y.id}/scopes`)).s, (await call(T.x, 'PUT', `/company/users/${U.y.id}/scopes`, { grants: [] })).s].every((s) => s === 404 || s === 403) && (await call(tokV, 'PUT', `/company/users/${U.y.id}/scopes`, { grants: [{ orgUnitId: '00000000-0000-4000-8000-000000000000' }] })).s === 400 && (await call(tokV, 'GET', `/company/users/00000000-0000-4000-8000-000000000001/scopes`)).s === 404 && (await call(null, 'GET', `/company/users/${U.y.id}/scopes`)).s === 401);
  const aud = (await co.query(`SELECT action, count(*)::int n FROM audit_records WHERE action IN ('company.user.scopes_changed', 'inventory.warehouse.org_unit_changed') GROUP BY action`)).rows;
  ok('audit: grants (every PUT) and warehouse re-links are recorded in the Company audit chain', aud.some((r) => r.action === 'company.user.scopes_changed' && r.n >= 3) && aud.some((r) => r.action === 'inventory.warehouse.org_unit_changed' && r.n >= linked.length), JSON.stringify(aud));

  // ---- A/B: the other Company is untouched ----
  const fresh3 = (await cp.query(`SELECT id FROM companies WHERE name = 'Fresh Co 3'`)).rows[0];
  const tokF = await enter(approver, fresh3.id);
  ok('Company B (Fresh Co 3) is untouched: its warehouse list has none of the F6 test warehouses and the scope endpoints refuse a Verify Co user id', !(await call(tokF, 'GET', '/inventory/warehouses')).d.some((w) => [WX.id, WY.id, WU.id].includes(w.id)) && (await call(tokF, 'GET', `/company/users/${U.y.id}/scopes`)).s === 404);

  // ---- restore + tidy ----
  for (const w of linked) await call(tokV, 'POST', `/inventory/warehouses/${w}/org-unit`, { orgUnitId: prior[w] });
  const restored = (await call(tokV, 'GET', '/inventory/warehouses')).d;
  ok('restore: the demo warehouses are back to their original link (unlinked)', linked.every((w) => ((restored.find((x) => x.id === w) || {}).orgUnitId || null) === prior[w]));
  for (const w of [WX, WY, WU]) await call(tokV, 'POST', `/inventory/warehouses/${w.id}/status`, { status: 'inactive' });
  await tidy();
  ok('removing a member removes their explicit scope grants (a re-invited person does not silently regain a scope)', (await co.query(`SELECT count(*)::int n FROM access_scopes WHERE "userId" = ANY($1::uuid[])`, [[U.x.id, U.y.id, U.n.id]])).rows[0].n === 0);
  await call(tokV, 'DELETE', `/company/roles/${role.d.id}`);
  await co.end(); await cp.end();
  console.log(out.join('\n'));
  console.log(`\n${out.filter((l) => l.startsWith('PASS')).length}/${out.length} checks passed`);
})().catch((e) => { console.log(out.join('\n')); console.error('SCRIPT ERROR', e); process.exit(2); });
