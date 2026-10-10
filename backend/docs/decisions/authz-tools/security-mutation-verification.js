require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard')).install(); // DB guard (M-R2 §11): default deny — no connection to an unapproved database
// Authorization Foundation closure — Step B: security / NO-MUTATION verification over REAL HTTP (bv backend 3601, isolated env) with DATABASE proof.
// Every denied call is bracketed by fingerprints (md5 of the full ordered row set) of the tables it could have touched, in Company A's DB, Company B's DB and the
// control plane; a denial passes only if the HTTP status is the refusal AND every fingerprint is unchanged. Positive controls (an allowed call) prove the
// fingerprints do detect a real change. audit_records is deliberately NOT fingerprinted: a refusal may be audited by design (checked separately).
// A = Verify Co, B = Fresh Co 3, unauthorized support target = Fresh Co 4. Test identities only (…@secmut.example.test). usage: BV_TEST_PASSWORD=… node security-mutation-verification.js
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
const NEW_PW = 'SecMut-Http-Pass#2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (email, password = PW) => (await call(null, 'POST', '/auth/login', { email, password })).d.accessToken;
const enter = async (tok, companyId) => call(tok, 'POST', '/auth/select-company', { companyId });
const pgc = (database) => new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database });
const CO_TABLES = ['access_scopes', 'user_roles', 'roles', 'role_permissions', 'org_units', 'org_memberships', 'warehouses', 'purchase_requests', 'warehouse_transactions', 'sales_orders'];
const CP_TABLES = ['user_company_memberships', 'user_roles'];
async function fp(client, tables) {
  const r = {};
  for (const t of tables) r[t] = (await client.query(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM "${t}" x`)).rows[0];
  return r;
}
(async () => {
  const cp = pgc('bv_cp'); await cp.connect();
  const cos = (await cp.query(`SELECT c.id, c.name, d."databaseName" db FROM companies c JOIN database_registries d ON d."companyId" = c.id WHERE c.status = 'READY'`)).rows;
  const A = cos.find((c) => c.name === 'Verify Co'), B = cos.find((c) => c.name === 'Fresh Co 3'), Z = cos.find((c) => c.name === 'Fresh Co 4');
  const dbA = pgc(A.db), dbB = pgc(B.db); await dbA.connect(); await dbB.connect();
  const snap = async () => ({ A: await fp(dbA, CO_TABLES), B: await fp(dbB, CO_TABLES), CP: await fp(cp, CP_TABLES) });
  const diff = (x, y) => { const d = []; for (const k of ['A', 'B', 'CP']) for (const t of Object.keys(x[k])) if (x[k][t].h !== y[k][t].h) d.push(`${k}.${t}(${x[k][t].n}->${y[k][t].n})`); return d; };
  /** A refused call: expected status(es) AND no fingerprint change anywhere. */
  const denied = async (name, fn, statuses, code) => {
    const before = await snap();
    const r = await fn();
    const after = await snap();
    const d = diff(before, after);
    ok(`${name} — HTTP ${statuses.join('/')}${code ? ' ' + code : ''}, NO DB mutation`, statuses.includes(r.s) && (!code || r.code === code) && d.length === 0, `status ${r.s} ${r.code || ''}${d.length ? ' MUTATED ' + d.join(',') : ''}`);
    return r;
  };
  /** An allowed call (positive control): expected status AND the fingerprint of exactly `expectChanged` changes. */
  const allowed = async (name, fn, status, expectChanged) => {
    const before = await snap();
    const r = await fn();
    const d = diff(before, await snap());
    ok(`${name} — HTTP ${status}, mutation detected in ${expectChanged.join(',')}`, r.s === status && expectChanged.every((e) => d.some((x) => x.startsWith(e))), `status ${r.s} ${r.code || ''} changed [${d.join(',')}]`);
    return r;
  };

  const stamp = Date.now();
  const approver = await login('bv.approver@example.test'); // Platform Super Admin + administrator of A and B
  const tokA = (await enter(approver, A.id)).d.accessToken;
  const tokB = (await enter(approver, B.id)).d.accessToken;
  const tidy = async () => { for (const t of [tokA, tokB]) for (const m of (await call(t, 'GET', '/company/users')).d.filter((x) => x.email.endsWith('@secmut.example.test'))) await call(t, 'DELETE', `/company/users/${m.userId}`); };
  await tidy();

  // ---- fixture: A has branches X, Y and warehouses WX (X), WY (Y); B has its own warehouse WB ----
  const unitX = (await call(tokA, 'POST', '/organization/units', { type: 'branch', name: `SM Branch X ${stamp}` })).d;
  const unitY = (await call(tokA, 'POST', '/organization/units', { type: 'branch', name: `SM Branch Y ${stamp}` })).d;
  const mkWh = async (tok, code, orgUnitId) => (await call(tok, 'POST', '/inventory/warehouses', { code: `${code}-${stamp}`.slice(0, 30), name: `SM ${code}`, ...(orgUnitId ? { orgUnitId } : {}) })).d;
  const WX = await mkWh(tokA, 'SMWX', unitX.id), WY = await mkWh(tokA, 'SMWY', unitY.id), WB = await mkWh(tokB, 'SMWB', null);
  const opGrants = [{ node: 'inventory', access: 'editable' }, { node: 'procurement', access: 'editable' }, { node: 'sales', access: 'editable' }];
  const opA = (await call(tokA, 'POST', '/company/roles', { nameEn: `SM Operator ${stamp}`, grants: opGrants })).d;
  const pmA = (await call(tokA, 'POST', '/company/roles', { nameEn: `SM People Manager ${stamp}`, grants: [{ node: 'core.company.members.manage', access: 'editable' }] })).d;
  const opB = (await call(tokB, 'POST', '/company/roles', { nameEn: `SM Operator B ${stamp}`, grants: opGrants })).d;
  const mk = async (tok, label, roleKeys) => {
    const email = `sm.${label}.${stamp}@secmut.example.test`;
    const inv = await call(tok, 'POST', '/company/users/invitations', { email, fullName: `SM ${label}`, roleKeys });
    const reg = await call(null, 'POST', '/invitations/register', { token: inv.d && inv.d.token, fullName: `SM ${label}`, password: NEW_PW });
    const id = ((await call(tok, 'GET', '/company/users')).d.find((u) => u.email === email) || {}).userId;
    return { label, email, id, st: [inv.s, reg.s] };
  };
  const SX = await mk(tokA, 'sx', [opA.key]); // scoped operator, scope = X
  const PM = await mk(tokA, 'pm', [pmA.key, opA.key]); // delegated people-manager (NOT organization admin), scope = X only
  const T = await mk(tokA, 't', [opA.key]); // target person, no scope
  const OB = await mk(tokB, 'ob', [opB.key]); // operator of B
  await sleep(65000); // registration throttle (5/min)
  const P = await mk(tokB, 'support', []); // a platform user (lives in B)
  const asg = await call(approver, 'POST', '/admin/roles/assign', { userId: P.id, roleKey: 'support_operations' });
  await call(tokA, 'PUT', `/company/users/${SX.id}/scopes`, { grants: [{ orgUnitId: unitX.id, includeDescendants: true }] });
  await call(tokA, 'PUT', `/company/users/${PM.id}/scopes`, { grants: [{ orgUnitId: unitX.id, includeDescendants: false }] });
  ok('setup: A (X, Y, WX, WY, roles, sx/pm/t), B (WB, ob), platform support user', [SX, PM, T, OB, P].every((u) => u.id && u.st[0] === 201 && u.st[1] === 201) && asg.s === 201 && WX && WY && WB && opA && pmA && opB, JSON.stringify([SX.st, PM.st, T.st, OB.st, P.st, asg.s]));
  await sleep(61000); // login throttle (10/min)
  const tSX = (await enter(await login(SX.email, NEW_PW), A.id)).d.accessToken;
  const tPM = (await enter(await login(PM.email, NEW_PW), A.id)).d.accessToken;
  const lOB = await login(OB.email, NEW_PW);
  const tOB = (await enter(lOB, B.id)).d.accessToken;
  const lSX = await login(SX.email, NEW_PW);
  const tP = await login(P.email, NEW_PW);
  const product = (await call(tokA, 'GET', '/products')).d[0].id;
  const productB = ((await call(tokB, 'GET', '/products')).d[0] || {}).id || product;

  // ================= SCOPE =================
  const whSX = (await call(tSX, 'GET', '/inventory/warehouses')).d.map((w) => w.id);
  ok('scope: sx (scope X) sees WX, never WY', whSX.includes(WX.id) && !whSX.includes(WY.id));
  await denied('scope: sx reads stock of WY (outside own scope)', () => call(tSX, 'GET', `/inventory/stock?warehouseId=${WY.id}&productId=${product}`), [404]);
  await denied('scope: sx creates a purchase request in WY', () => call(tSX, 'POST', '/procurement/purchase-requests', { warehouseId: WY.id, lines: [{ productId: product, quantity: '5' }] }), [404]);
  await denied('scope: sx creates a warehouse transaction in WY', () => call(tSX, 'POST', '/warehouse-transactions', { type: 'receipt', warehouseId: WY.id, lines: [] }), [404]);
  await denied('scope: sx transfers WX -> WY (destination outside scope)', () => call(tSX, 'POST', '/warehouse-transactions', { type: 'transfer', warehouseId: WX.id, destinationWarehouseId: WY.id, lines: [] }), [404]);
  await denied('scope: sx re-links / deactivates WY', () => call(tSX, 'POST', `/inventory/warehouses/${WY.id}/status`, { status: 'inactive' }), [404]);
  await allowed('scope (positive control): sx creates a purchase request in WX', () => call(tSX, 'POST', '/procurement/purchase-requests', { warehouseId: WX.id, lines: [{ productId: product, quantity: '5' }] }), 201, ['A.purchase_requests']);
  await denied('scope: sx (no members.manage) grants itself Y', () => call(tSX, 'PUT', `/company/users/${SX.id}/scopes`, { grants: [{ orgUnitId: unitY.id, includeDescendants: true }] }), [403, 404]);
  await denied('scope: pm (scope X, not org admin) grants t a unit OUTSIDE pm\'s own scope (Y)', () => call(tPM, 'PUT', `/company/users/${T.id}/scopes`, { grants: [{ orgUnitId: unitY.id, includeDescendants: true }] }), [404]);
  await denied('scope: pm broadens ITS OWN scope by adding Y', () => call(tPM, 'PUT', `/company/users/${PM.id}/scopes`, { grants: [{ orgUnitId: unitX.id, includeDescendants: false }, { orgUnitId: unitY.id, includeDescendants: true }] }), [403], 'SELF_SCOPE_CHANGE');
  await denied('scope: pm widens ITS OWN grant on X (descendants off -> on)', () => call(tPM, 'PUT', `/company/users/${PM.id}/scopes`, { grants: [{ orgUnitId: unitX.id, includeDescendants: true }] }), [403], 'SELF_SCOPE_CHANGE');
  await allowed('scope (positive control): pm grants t a unit INSIDE its own scope (X)', () => call(tPM, 'PUT', `/company/users/${T.id}/scopes`, { grants: [{ orgUnitId: unitX.id, includeDescendants: false }] }), 200, ['A.access_scopes']);
  const grantsBefore = (await dbA.query(`SELECT count(*)::int n FROM access_scopes WHERE "userId" = ANY($1::uuid[])`, [[SX.id, T.id]])).rows[0].n;
  await call(tokA, 'DELETE', `/company/users/${SX.id}`); await call(tokA, 'DELETE', `/company/users/${T.id}`);
  const grantsAfter = (await dbA.query(`SELECT count(*)::int n FROM access_scopes WHERE "userId" = ANY($1::uuid[])`, [[SX.id, T.id]])).rows[0].n;
  ok('scope: removing the membership removes the grants (DB rows for sx and t)', grantsBefore === 2 && grantsAfter === 0, `${grantsBefore} -> ${grantsAfter}`);
  await denied('scope: the removed member\'s still-valid token can no longer read A', () => call(tSX, 'GET', '/inventory/warehouses'), [401, 403]);

  // ================= CROSS COMPANY =================
  ok('A -> A ALLOW: pm (A) reads A warehouses (200, sees WX)', await (async () => { const r = await call(tPM, 'GET', '/inventory/warehouses'); return r.s === 200 && r.d.some((w) => w.id === WX.id); })());
  ok('B -> B ALLOW: ob (B) reads B warehouses (200, sees WB, sees no A warehouse)', await (async () => { const r = await call(tOB, 'GET', '/inventory/warehouses'); return r.s === 200 && r.d.some((w) => w.id === WB.id) && !r.d.some((w) => [WX.id, WY.id].includes(w.id)); })());
  await denied('A -> B DENY: an A-only member cannot select Company B', () => enter(tPM, B.id), [401, 403, 404]);
  await denied('B -> A DENY: a B-only member cannot select Company A', () => enter(lOB, A.id), [401, 403, 404]);
  const whPM = (await call(tPM, 'GET', '/inventory/warehouses')).d.map((w) => w.id);
  ok('A -> B DENY: B\'s warehouse is invisible from an A token', !whPM.includes(WB.id));
  // B's warehouse id means nothing in A's database. The cross-company property is: B is never read or written. (KNOWN PRE-EXISTING DEFECT, pre-F1 identical:
  // purchase-request creation does not validate that the warehouse exists — no FK on purchase_requests.warehouseId — so A gets an orphan row in ITS OWN database.)
  {
    const before = await snap();
    const r = await call(tPM, 'POST', '/procurement/purchase-requests', { warehouseId: WB.id, lines: [{ productId: productB, quantity: '1' }] });
    const d = diff(before, await snap());
    ok('A -> B DENY: an A token addressing B\'s warehouse id never reads or writes Company B (B fingerprints unchanged, no B data returned)', !d.some((x) => x.startsWith('B.')) && !JSON.stringify(r.d).includes(WB.code), `status ${r.s} changed [${d.join(',')}]`);
    if (r.s === 201) out.push('KNOWN-DEFECT (pre-existing, not authorization): PR created in A with a warehouseId that does not exist in A — changed [' + d.join(',') + ']');
  }
  await denied('A -> B DENY: the A administrator\'s A token changes the scopes of a B user', () => call(tokA, 'PUT', `/company/users/${OB.id}/scopes`, { grants: [{ orgUnitId: unitX.id }] }), [404]);
  await denied('A -> B DENY: the A administrator\'s A token changes the roles of a B user', () => call(tokA, 'PUT', `/company/users/${OB.id}/roles`, { roleKeys: [opA.key] }), [404]);
  await denied('B -> A DENY: the B administrator\'s B token changes the scopes of an A user', () => call(tokB, 'PUT', `/company/users/${PM.id}/scopes`, { grants: [] }), [404]);
  // removal is bound to the token's Company (B): an A user has no B membership -> idempotent no-op (F2). The property is: A is untouched.
  await denied('B -> A DENY: the B administrator\'s B token "removes" an A user (no-op in B, A untouched)', () => call(tokB, 'DELETE', `/company/users/${PM.id}`), [200, 404]);
  ok('B -> A DENY: the A user is still a member of A after that call', (await call(tokA, 'GET', '/company/users')).d.some((u) => u.userId === PM.id));
  // an A warehouse id does not exist in B's database: whatever the status, B's token must return none of A's data
  const xs = await call(tOB, 'GET', `/inventory/stock?warehouseId=${WX.id}&productId=${product}`);
  ok('B -> A DENY: B token addressing an A warehouse id returns no A data', xs.s === 404 || xs.s === 400 || (xs.s === 200 && !JSON.stringify(xs.d).includes(WX.code)), `status ${xs.s} ${JSON.stringify(xs.d).slice(0, 120)}`);

  // ================= SUPPORT =================
  const reason = 'Investigating the posting issue reported in ticket 7731';
  await denied('support: self-grant on A', () => call(tP, 'POST', '/platform/support-access', { companyId: A.id, userId: P.id, reason }), [403], 'SELF_GRANT_PROHIBITED');
  await denied('support: grant with no named grantee (old "for myself" default)', () => call(tP, 'POST', '/platform/support-access', { companyId: A.id, reason }), [400]);
  const meId = (await call(approver, 'GET', '/auth/me')).d.identity.id;
  await denied('support: the Platform Super Admin self-grant', () => call(approver, 'POST', '/platform/support-access', { companyId: A.id, userId: meId, reason }), [403], 'SELF_GRANT_PROHIBITED');
  const g = await allowed('support (positive control): ANOTHER platform user opens P\'s access to A (1h)', () => call(approver, 'POST', '/platform/support-access', { companyId: A.id, userId: P.id, reason, hours: 1 }), 201, ['CP.user_company_memberships']);
  await denied('support: P extends its own live access (self-approve / self-extend)', () => call(tP, 'POST', '/platform/support-access', { companyId: A.id, userId: P.id, reason: 'Extending my own access, which is prohibited', hours: 8 }), [403], 'SELF_GRANT_PROHIBITED');
  await denied('support: P opens access for itself on an UNAUTHORIZED Company (Fresh Co 4)', () => call(tP, 'POST', '/platform/support-access', { companyId: Z.id, userId: P.id, reason }), [403], 'SELF_GRANT_PROHIBITED');
  await denied('support: P selects the unauthorized Company (Fresh Co 4)', () => enter(tP, Z.id), [401, 403, 404]);
  const tPA = (await enter(tP, A.id)).d.accessToken;
  await denied('support: P (in A) gives itself a scope', () => call(tPA, 'PUT', `/company/users/${P.id}/scopes`, { grants: [{ orgUnitId: unitY.id, includeDescendants: true }] }), [403, 404, 409]);
  await denied('support: P (in A) gives itself a role / makes itself Company Admin', () => call(tPA, 'PUT', `/company/users/${P.id}/roles`, { roleKeys: ['company_admin'] }), [403, 404, 409]);
  await denied('support: P (in A) writes ERP data (warehouse create)', () => call(tPA, 'POST', '/inventory/warehouses', { code: `SMNO-${stamp}`.slice(0, 20), name: 'no' }), [403, 404]);
  await denied('support: an administrator gives the support membership a scope', () => call(tokA, 'PUT', `/company/users/${P.id}/scopes`, { grants: [{ orgUnitId: unitY.id }] }), [409], 'SUPPORT_ACCESS_FIXED');
  const live = (await call(approver, 'GET', `/platform/support-access?companyId=${A.id}`)).d.find((a) => a.userId === P.id);
  ok('support: P\'s access is unchanged after all refusals (same expiry, read-only, Company-visible)', live && g.d && live.expiresAt === g.d.expiresAt);
  const aud = (await cp.query(`SELECT count(*)::int n FROM audit_records WHERE action = 'platform.support_access.self_grant_denied' AND result = 'denied' AND "timestamp" > to_timestamp($1 / 1000.0)`, [stamp])).rows[0].n;
  ok('support: every refused self-grant in this run is audited (>= 4)', aud >= 4, `audited ${aud}`);

  // ---- tidy ----
  await call(tP, 'DELETE', `/platform/support-access/${A.id}/${P.id}`);
  await tidy();
  for (const [t, w] of [[tokA, WX], [tokA, WY], [tokB, WB]]) await call(t, 'POST', `/inventory/warehouses/${w.id}/status`, { status: 'inactive' });
  for (const [t, r] of [[tokA, opA], [tokA, pmA], [tokB, opB]]) await call(t, 'DELETE', `/company/roles/${r.id}`);
  await call(approver, 'POST', '/admin/roles/revoke', { userId: P.id, roleKey: 'support_operations' });
  await dbA.end(); await dbB.end(); await cp.end();
  console.log(out.join('\n'));
  console.log(`\n${out.filter((l) => l.startsWith('PASS')).length}/${out.length} checks passed`);
})().catch((e) => { console.log(out.join('\n')); console.error('SCRIPT ERROR', e); process.exit(2); });
