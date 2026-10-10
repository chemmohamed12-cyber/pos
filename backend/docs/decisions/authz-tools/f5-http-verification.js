require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard')).install(); // DB guard (M-R2 §11): default deny — no connection to an unapproved database
// F5 runtime verification over REAL HTTP against the booted backend (3601, isolated env). Test identities only (…@f5.example.test).
// Legacy authorization migration: the capability decisions equal the legacy role decisions; /admin/sales-reps is Company-aware; Organization writes, nav, scope and
// customer-reviewer rules are served by workflow capabilities; the divergence monitor shows no user losing power.
const API = 'http://127.0.0.1:3601/api';
const J = { 'Content-Type': 'application/json' };
const base = 'D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/';
const { Client } = require(base + 'node_modules/pg');
const out = [];
const ok = (name, cond, extra = '') => { out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  — ' + extra : '')); if (!cond) process.exitCode = 1; };
async function call(tok, method, path, body) {
  const r = await fetch(API + path, { method, headers: { ...J, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch { /* none */ }
  return { s: r.status, j, d: j.data, code: j.error && j.error.code };
}
const PW = process.env.BV_TEST_PASSWORD;
const NEW_PW = 'F5-Http-Pass#2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let regCount = 0; // Throttler: register 5/min, login 10/min -> batches with a pause
const login = async (email, password = PW) => (await call(null, 'POST', '/auth/login', { email, password })).d.accessToken;
const enter = async (tok, companyId) => (await call(tok, 'POST', '/auth/select-company', { companyId })).d.accessToken;
(async () => {
  const cp = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: 'bv_cp' }); await cp.connect();
  const cos = (await cp.query(`SELECT id, name FROM companies WHERE status='READY'`)).rows;
  const verify = cos.find((c) => c.name === 'Verify Co');
  const fresh3 = cos.find((c) => c.name === 'Fresh Co 3');
  const stamp = Date.now();
  const approver = await login('bv.approver@example.test'); // platform admin alias + Verify Co administrator
  const tokV = await enter(approver, verify.id);
  const tokF = await enter(approver, fresh3.id);
  const tidy = async () => { for (const t of [tokV, tokF]) for (const m of (await call(t, 'GET', '/company/users')).d.filter((x) => x.email.endsWith('@f5.example.test'))) await call(t, 'DELETE', `/company/users/${m.userId}`); };
  await tidy();

  // identities: one per legacy role + a bare member, all in Verify Co; one rep in Fresh Co 3 (the A/B probe)
  const mk = async (tok, label, roleKeys) => {
    if (regCount > 0 && regCount % 4 === 0) await sleep(65000);
    regCount++;
    const email = `f5.${label}.${stamp}@f5.example.test`;
    const inv = await call(tok, 'POST', '/company/users/invitations', { email, fullName: `F5 ${label}`, roleKeys });
    const reg = await call(null, 'POST', '/invitations/register', { token: inv.d && inv.d.token, fullName: `F5 ${label}`, password: NEW_PW });
    const id = ((await call(tok, 'GET', '/company/users')).d.find((u) => u.email === email) || {}).userId;
    return { label, email, id, inv: inv.s, reg: reg.s };
  };
  const U = {};
  for (const [label, keys] of [['mgr', ['sales_manager']], ['sup', ['sales_supervisor']], ['rep', ['sales_rep']], ['fin', ['finance']], ['wh', ['warehouse_worker']], ['drv', ['driver']], ['none', []]]) U[label] = await mk(tokV, label, keys);
  U.repB = await mk(tokF, 'repb', ['sales_rep']);
  ok('test identities created through invitations with legacy role keys', Object.values(U).every((u) => u.inv === 201 && u.reg === 201 && u.id), Object.values(U).map((u) => `${u.label}:${u.inv}/${u.reg}`).join(' '));
  await sleep(65000);
  const T = {};
  for (const [k, u] of Object.entries(U)) { const t = await login(u.email, NEW_PW).catch(() => { throw new Error('login failed for ' + JSON.stringify(u)); }); T[k] = await enter(t, (k === 'repB' ? fresh3 : verify).id); }

  // ---- 1. capabilities mirror the legacy roles ----
  const caps = async (k) => (await call(T[k], 'GET', '/auth/me')).d.capabilities;
  const cMgr = await caps('mgr'), cSup = await caps('sup'), cRep = await caps('rep'), cFin = await caps('fin'), cWh = await caps('wh'), cDrv = await caps('drv'), cNone = await caps('none');
  const has = (c, n) => c[n] === 'editable';
  ok('/auth/me: sales_manager holds manager approve + manager price + price-list menu, not supervisor approve', has(cMgr, 'wf.sales.order.manager_approve') && has(cMgr, 'wf.sales.order.set_manager_price') && has(cMgr, 'wf.sales.nav.price_lists') && !has(cMgr, 'wf.sales.order.supervisor_approve'));
  ok('/auth/me: sales_supervisor holds supervisor approve + return authorize, not manager approve', has(cSup, 'wf.sales.order.supervisor_approve') && has(cSup, 'wf.logistics.return.authorize') && !has(cSup, 'wf.sales.order.manager_approve'));
  ok('/auth/me: sales_rep holds submit/resubmit/act-as-rep, nothing of the review chain', has(cRep, 'wf.sales.order.submit') && has(cRep, 'wf.sales.rep.act') && !has(cRep, 'wf.sales.order.supervisor_approve') && !has(cRep, 'wf.sales.order.list_all'));
  ok('/auth/me: finance holds read-any + collection settlements menu + edit-released, not warehouse', has(cFin, 'wf.sales.order.read_any') && has(cFin, 'wf.logistics.nav.collection_settlements') && has(cFin, 'wf.sales.order.edit_released') && !has(cFin, 'wf.inventory.fulfillment.worker'));
  ok('/auth/me: warehouse_worker holds fulfilment worker + returns receive + warehouse menu, not admin-only rules', has(cWh, 'wf.inventory.fulfillment.worker') && has(cWh, 'wf.logistics.return.receive') && has(cWh, 'wf.inventory.nav.warehouse') && !has(cWh, 'wf.logistics.shipment.assign_driver') && !has(cWh, 'wf.core.organization.manage'));
  ok('/auth/me: driver holds only the Shipments menu rule', has(cDrv, 'wf.logistics.nav.shipments') && Object.keys(cDrv).filter((n) => n.startsWith('wf.') && cDrv[n] === 'editable').length === 1);
  ok('/auth/me: a member with no legacy role holds no workflow capability', Object.keys(cNone).filter((n) => n.startsWith('wf.') && cNone[n] === 'editable').length === 0);
  const adminCaps = (await call(tokV, 'GET', '/auth/me')).d.capabilities;
  ok('/auth/me: the Company administrator holds all 46 workflow capabilities', Object.keys(adminCaps).filter((n) => n.startsWith('wf.') && adminCaps[n] === 'editable').length === 46);

  // ---- 2. navigation (legacy `roles` -> workflow rules): same items as before ----
  const navTos = async (k) => ((await call(T[k], 'GET', '/me/navigation')).d.groups || []).flatMap((g) => g.items.map((i) => i.to));
  const nWh = await navTos('wh'), nMgr = await navTos('mgr'), nFin = await navTos('fin'), nNone = await navTos('none'), nAdmin = ((await call(tokV, 'GET', '/me/navigation')).d.groups || []).flatMap((g) => g.items.map((i) => i.to));
  ok('menu: warehouse_worker sees Warehouses + Fulfilment + Custody returns, not Price lists / Shipping methods / Organization', ['/warehouses', '/fulfillment', '/custody-returns'].every((p) => nWh.includes(p)) && !['/price-lists', '/shipping-methods', '/organization'].some((p) => nWh.includes(p)), nWh.join(' '));
  ok('menu: sales_manager sees Price lists, not Warehouses / Collection settlements', nMgr.includes('/price-lists') && !nMgr.includes('/warehouses') && !nMgr.includes('/collection-settlements'));
  ok('menu: finance sees Collection settlements, not Price lists', nFin.includes('/collection-settlements') && !nFin.includes('/price-lists'));
  ok('menu: a bare member sees none of the role-gated entries', !['/warehouses', '/fulfillment', '/price-lists', '/shipping-methods', '/custody-returns', '/collection-settlements', '/bom', '/organization'].some((p) => nNone.includes(p)), nNone.join(' '));
  ok('menu: the Company administrator sees all of them', ['/warehouses', '/fulfillment', '/price-lists', '/shipping-methods', '/custody-returns', '/collection-settlements', '/bom', '/organization', '/shipments'].every((p) => nAdmin.includes(p)), `missing: ${['/warehouses', '/fulfillment', '/price-lists', '/shipping-methods', '/custody-returns', '/collection-settlements', '/bom', '/organization', '/shipments'].filter((p) => !nAdmin.includes(p)).join(' ')}`);

  // ---- 3. /admin/sales-reps is a Company surface ----
  const repsV = await call(T.mgr, 'GET', '/admin/sales-reps');
  const repsAdmin = await call(tokV, 'GET', '/admin/sales-reps');
  const repsB = await call(tokF, 'GET', '/admin/sales-reps');
  const ids = (r) => (r.d || r.j || []).map((u) => u.id);
  ok('/admin/sales-reps: a sales_manager of Verify Co gets 200 with Verify Co reps only (own rep in, Fresh Co 3 rep out)', repsV.s === 200 && ids(repsV).includes(U.rep.id) && !ids(repsV).includes(U.repB.id), `status ${repsV.s} n=${ids(repsV).length}`);
  ok('/admin/sales-reps: the other Company sees ITS rep only (A/B isolation)', repsB.s === 200 && ids(repsB).includes(U.repB.id) && !ids(repsB).includes(U.rep.id));
  ok('/admin/sales-reps: Company administrator allowed; rep / finance / bare member refused (403); no token 401', repsAdmin.s === 200 && (await call(T.rep, 'GET', '/admin/sales-reps')).s === 403 && (await call(T.fin, 'GET', '/admin/sales-reps')).s === 403 && (await call(T.none, 'GET', '/admin/sales-reps')).s === 403 && (await call(null, 'GET', '/admin/sales-reps')).s === 401);

  // ---- 4. Organization writes (admin-only before) ----
  const unit = await call(tokV, 'POST', '/organization/units', { type: 'team', name: `F5 Team ${stamp}` });
  ok('organization: the administrator can create a unit (201)', unit.s === 201, `status ${unit.s}`);
  ok('organization: manager / warehouse worker / bare member are refused (403), reads stay open to every member', (await call(T.mgr, 'POST', '/organization/units', { type: 'team', name: 'x' })).s === 403 && (await call(T.wh, 'POST', '/organization/units', { type: 'team', name: 'x' })).s === 403 && (await call(T.none, 'POST', '/organization/units', { type: 'team', name: 'x' })).s === 403 && (await call(T.none, 'GET', '/organization/units')).s === 200);

  // ---- 5. a Company-designed role with the capability works (capability != role key) ----
  await sleep(65000);
  const probe = await call(tokV, 'POST', '/company/roles', { nameEn: `F5 Org Keeper ${stamp}`, grants: [{ node: 'wf.core.organization.manage', access: 'editable' }] });
  ok('a custom role can be granted a workflow capability (catalog knows wf.* nodes)', probe.s === 201, `status ${probe.s} ${probe.code || ''}`);
  if (probe.s === 201) {
    await call(tokV, 'PUT', `/company/users/${U.none.id}/roles`, { roleKeys: [probe.d.key] });
    const tNone2 = await enter(await login(U.none.email, NEW_PW), verify.id);
    ok('organization: the holder of the custom role can create a unit although they hold no legacy role key', (await call(tNone2, 'POST', '/organization/units', { type: 'team', name: `F5 Custom ${stamp}` })).s === 201);
    await call(tokV, 'PUT', `/company/users/${U.none.id}/roles`, { roleKeys: [] });
    ok('organization: after the role is removed the same user is refused again (403)', (await call(await enter(await login(U.none.email, NEW_PW), verify.id), 'POST', '/organization/units', { type: 'team', name: 'again' })).s === 403);
    await call(tokV, 'DELETE', `/company/roles/${probe.d.id}`);
  }

  // ---- 6. customers: reviewers see all, a rep sees only the assigned ----
  const cust = await call(tokV, 'POST', '/customers', { name: `F5 Customer ${stamp}`, phone: '0100000000' });
  const list = async (k) => { const r = await call(T[k], 'GET', '/customers?page=1&pageSize=200'); return { s: r.s, n: ((r.d && r.d.rows) || []).length }; };
  const lMgr = await list('mgr'), lFin = await list('fin'), lRep = await list('rep'), lSup = await list('sup');
  ok('customers: reviewers (sales_manager / supervisor / finance) see the customer; a rep with no assignment sees none (scope unchanged)', cust.s === 201 && lMgr.n >= 1 && lFin.n >= 1 && lSup.n >= 1 && lRep.n === 0, JSON.stringify({ mgr: lMgr, sup: lSup, fin: lFin, rep: lRep, create: cust.s }));

  // ---- 7. platform route + register ----
  ok('POST /auth/register: a non-admin caller is refused (403), no token 401', (await call(T.mgr, 'POST', '/auth/register', { email: `x${stamp}@f5.example.test`, fullName: 'X', password: NEW_PW })).s === 403 && (await call(null, 'POST', '/auth/register', { email: `x${stamp}@f5.example.test`, fullName: 'X', password: NEW_PW })).s === 401);
  const div = await call(approver, 'GET', '/platform/authz/workflow-divergence');
  ok('GET /platform/authz/workflow-divergence: platform admin sees the mode and per-rule counters', div.s === 200 && ['legacy', 'dual', 'capability'].includes(div.d.mode) && div.d.rules.length === 46, div.s === 200 ? `mode=${div.d.mode} legacyOnly=${div.d.totals.legacyOnly} capabilityOnly=${div.d.totals.capabilityOnly}` : `status ${div.s}`);
  ok('the divergence monitor is platform-only: Company administrator without platform role / bare member refused (403)', (await call(T.none, 'GET', '/platform/authz/workflow-divergence')).s === 403 && (await call(T.mgr, 'GET', '/platform/authz/workflow-divergence')).s === 403);
  if (div.s === 200 && div.d.mode === 'dual') ok('dual mode: ZERO legacy-only divergence after the whole run (no user would lose a power)', div.d.totals.legacyOnly === 0, JSON.stringify(div.d.totals));

  await tidy();
  await cp.end();
  console.log(out.join('\n'));
  console.log(`\n${out.filter((l) => l.startsWith('PASS')).length}/${out.length} checks passed`);
})().catch((e) => { console.log(out.join('\n')); console.error('SCRIPT ERROR', e); process.exit(2); });
