require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard-register')); // DB guard (M-R2 §11): default deny, all layers — no connection to an unapproved database
// CTO decisions of 2026-10-07 — runtime verification over REAL HTTP against the booted backend (3601, isolated env). Test identities only (…@closure.example.test).
//  Decision 4-C: support self-grant prohibited (grant / extend), support membership never receives a scope, support cannot manage anything.
//  Decision 3 / non-self-elevation: a `company_admin` administers users, organization and scopes of OTHER people, holds no ERP operational power, and can never add to or
//  widen its OWN roles or scope.
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
const NEW_PW = 'Closure-Http-Pass#2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (email, password = PW) => (await call(null, 'POST', '/auth/login', { email, password })).d.accessToken;
const enter = async (tok, companyId) => (await call(tok, 'POST', '/auth/select-company', { companyId })).d.accessToken;
(async () => {
  const cp = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: 'bv_cp' }); await cp.connect();
  const cos = (await cp.query(`SELECT id, name FROM companies WHERE status='READY'`)).rows;
  const verify = cos.find((c) => c.name === 'Verify Co'), fresh3 = cos.find((c) => c.name === 'Fresh Co 3');
  const stamp = Date.now();
  const approver = await login('bv.approver@example.test'); // Platform Super Admin alias + Verify Co administrator (legacy `admin`)
  const tokV = await enter(approver, verify.id);
  const tokF = await enter(approver, fresh3.id);
  const tidy = async () => { for (const t of [tokV, tokF]) for (const m of (await call(t, 'GET', '/company/users')).d.filter((x) => x.email.endsWith('@closure.example.test'))) await call(t, 'DELETE', `/company/users/${m.userId}`); };
  await tidy();
  const mk = async (tok, label, roleKeys) => {
    const email = `cl.${label}.${stamp}@closure.example.test`;
    const inv = await call(tok, 'POST', '/company/users/invitations', { email, fullName: `CL ${label}`, roleKeys });
    const reg = await call(null, 'POST', '/invitations/register', { token: inv.d && inv.d.token, fullName: `CL ${label}`, password: NEW_PW });
    const id = ((await call(tok, 'GET', '/company/users')).d.find((u) => u.email === email) || {}).userId;
    return { label, email, id, st: [inv.s, reg.s] };
  };

  // ---- identities: a platform support operator (a platform user lives in another Company), a company_admin and an operator in Verify Co ----
  const P = await mk(tokF, 'support', []);
  const asg = await call(approver, 'POST', '/admin/roles/assign', { userId: P.id, roleKey: 'support_operations' });
  const role = await call(tokV, 'POST', '/company/roles', { nameEn: `CL Operator ${stamp}`, grants: [{ node: 'inventory', access: 'editable' }, { node: 'sales', access: 'editable' }] });
  // Decision 3 concerns a NEW Company: the bv Companies predate it (legacy `admin`, no `company_admin` role row — D17 keeps existing Companies as they are), so a
  // Company is provisioned here through the real HTTP path (POST /installation/companies, no administratorRole => the new default) with C as initial administrator.
  const C = await mk(tokF, 'cadmin', []);
  const O = await mk(tokV, 'operator', [role.d.key]);
  const prov = await call(approver, 'POST', '/installation/companies', { name: `Closure Co ${stamp}`, initialAdminUserId: C.id, roleModuleCodes: ['sales', 'inventory', 'procurement'] });
  const N = prov.d && prov.d.company;
  ok('setup: a platform support operator (support_operations), an operator in Verify Co, and a NEW Company provisioned over HTTP with C as initial administrator', [P, C, O].every((u) => u.id && u.st[0] === 201 && u.st[1] === 201) && asg.s === 201 && role.s === 201 && prov.s === 201 && N && N.status === 'READY', JSON.stringify([P.st, C.st, O.st, asg.s, role.s, prov.s, N && N.status, prov.code || '']));
  const unitY = (await call(tokV, 'POST', '/organization/units', { type: 'branch', name: `CL Branch ${stamp}` })).d;
  await sleep(60000); // login throttle window
  const tokP = await login(P.email, NEW_PW);
  const loginC = await login(C.email, NEW_PW);
  const tokC = await enter(loginC, N.id);
  const memC = (await (async () => { const c = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: 'bv_cp' }); await c.connect(); const r = (await c.query(`SELECT "roleKey" FROM user_company_memberships WHERE "userId" = $1 AND "companyId" = $2`, [C.id, N.id])).rows; await c.end(); return r; })());
  ok('3: the initial membership of the new Company carries company_admin — never the legacy admin', memC.length === 1 && memC[0].roleKey === 'company_admin', JSON.stringify(memC));
  // inside the new Company, C (company_admin) builds what it administers: an operator role, a branch and an operator ON
  // F3 risk-aware anti-elevation (Blueprint §6.2): `inventory` editable reaches a CRITICAL node (inventory.stock_count.adjust) that company_admin does not hold
  const critical = await call(tokC, 'POST', '/company/roles', { nameEn: `CL N Critical ${stamp}`, grants: [{ node: 'inventory', access: 'editable' }] });
  ok('3 / anti-elevation: the company_admin cannot define a role reaching a CRITICAL capability it does not hold (403 ROLE_EXCEEDS_GRANTOR)', critical.s === 403 && critical.code === 'ROLE_EXCEEDS_GRANTOR', `status ${critical.s} ${critical.code || ''}`);
  const roleN = await call(tokC, 'POST', '/company/roles', { nameEn: `CL N Operator ${stamp}`, grants: [{ node: 'sales', access: 'editable' }] });
  const unitN = (await call(tokC, 'POST', '/organization/units', { type: 'branch', name: `CL N Branch ${stamp}` })).d;
  const ON = await mk(tokC, 'noperator', [roleN.d && roleN.d.key]);
  ok('3: the company_admin of the new Company creates a (non-critical) role, an organization unit and invites a person', roleN.s === 201 && !!(unitN && unitN.id) && !!ON.id && ON.st[0] === 201, JSON.stringify([roleN.s, ON.st]));
  const tokO = await enter(await login(O.email, NEW_PW), verify.id);

  // ---- Decision 4-C: support ----
  const reason = 'Investigating the posting issue reported in ticket 5521';
  const selfGrant = await call(tokP, 'POST', '/platform/support-access', { companyId: verify.id, userId: P.id, reason });
  ok('4-C: a support operator CANNOT grant itself access (403 SELF_GRANT_PROHIBITED); nothing is opened', selfGrant.s === 403 && selfGrant.code === 'SELF_GRANT_PROHIBITED' && (await call(approver, 'GET', `/platform/support-access?companyId=${verify.id}`)).d.every((a) => a.userId !== P.id), `status ${selfGrant.s} ${selfGrant.code || ''}`);
  const noGrantee = await call(tokP, 'POST', '/platform/support-access', { companyId: verify.id, reason });
  ok('4-C: the old "grant for myself" default is gone — the grantee must be named (400)', noGrantee.s === 400, `status ${noGrantee.s}`);
  const superSelf = await call(approver, 'POST', '/platform/support-access', { companyId: verify.id, userId: (await call(approver, 'GET', '/auth/me')).d.identity.id, reason });
  ok('4-C: not even the Platform Super Admin may grant access to itself (403)', superSelf.s === 403 && superSelf.code === 'SELF_GRANT_PROHIBITED', `status ${superSelf.s}`);
  const grant = await call(approver, 'POST', '/platform/support-access', { companyId: verify.id, userId: P.id, reason, hours: 1 });
  ok('4-C: ANOTHER authorized platform user can open it: explicit, reason-required, time-boxed, Company-visible', grant.s === 201 && grant.d.userId === P.id && !!grant.d.expiresAt && grant.d.reason === reason, `status ${grant.s}`);
  const extend = await call(tokP, 'POST', '/platform/support-access', { companyId: verify.id, userId: P.id, reason: 'Extending my own access, which is not allowed', hours: 8 });
  const live = (await call(approver, 'GET', `/platform/support-access?companyId=${verify.id}`)).d.find((a) => a.userId === P.id);
  ok('4-C: the holder cannot extend its own access (403) and the expiry is unchanged', extend.s === 403 && live && live.expiresAt === grant.d.expiresAt, `status ${extend.s}`);
  const tokPV = await enter(tokP, verify.id);
  ok('4-C: inside the Company the support access is read-only and administers nothing: no users, roles, scopes, organization or ERP writes', (await call(tokPV, 'GET', '/auth/me')).d.membership.kind === 'support' && [(await call(tokPV, 'PUT', `/company/users/${O.id}/scopes`, { grants: [{ orgUnitId: unitY.id }] })).s, (await call(tokPV, 'PUT', `/company/users/${O.id}/roles`, { roleKeys: [role.d.key] })).s, (await call(tokPV, 'POST', '/organization/units', { type: 'team', name: 'x' })).s, (await call(tokPV, 'POST', '/inventory/warehouses', { code: 'NOPE', name: 'x' })).s].every((s) => s === 403 || s === 404));
  const scopeToSupport = await call(tokV, 'PUT', `/company/users/${P.id}/scopes`, { grants: [{ orgUnitId: unitY.id, includeDescendants: true }] });
  ok('4-C: a support membership can never be given an access scope (409 SUPPORT_ACCESS_FIXED), even by the Company administrator', scopeToSupport.s === 409 && scopeToSupport.code === 'SUPPORT_ACCESS_FIXED', `status ${scopeToSupport.s}`);
  const roleToSupport = await call(tokV, 'PUT', `/company/users/${P.id}/roles`, { roleKeys: [role.d.key] });
  ok('4-C: nor a role (the role is fixed at read-only support)', roleToSupport.s === 409 || roleToSupport.s === 403, `status ${roleToSupport.s}`);
  const revoke = await call(tokP, 'DELETE', `/platform/support-access/${verify.id}/${P.id}`);
  ok('4-C: ending ones own access is narrowing, not elevation: allowed (the access closes)', revoke.s === 200 && (await call(approver, 'GET', `/platform/support-access?companyId=${verify.id}`)).d.every((a) => a.userId !== P.id), `status ${revoke.s}`);
  const audDenied = (await cp.query(`SELECT count(*)::int n FROM audit_records WHERE action = 'platform.support_access.self_grant_denied' AND result = 'denied'`)).rows[0].n;
  ok('4-C: every refused self-grant is audited in the platform chain', audDenied >= 3, `denied records ${audDenied}`);

  // ---- Decision 3: company_admin ----
  const meC = (await call(tokC, 'GET', '/auth/me')).d;
  const wfHeld = Object.keys(meC.capabilities).filter((n) => n.startsWith('wf.'));
  ok('3: the company_admin holds exactly ONE workflow-namespace capability (the Organization administration node) and nothing operational', JSON.stringify(wfHeld) === JSON.stringify(['wf.core.organization.manage']) && !meC.capabilities['inventory'] && !meC.capabilities['sales'] && meC.capabilities['core.company.members.manage'] === 'editable', JSON.stringify(wfHeld));
  const ops = [(await call(tokC, 'POST', '/inventory/warehouses', { code: `CL-${stamp}`.slice(0, 20), name: 'x' })).s, (await call(tokC, 'POST', '/inventory/movements', { warehouseId: '00000000-0000-4000-8000-000000000001' })).s, (await call(tokC, 'POST', '/warehouse-transactions/count', { warehouseId: '00000000-0000-4000-8000-000000000001', productIds: [] })).s, (await call(tokC, 'POST', '/procurement/purchase-requests', { warehouseId: '00000000-0000-4000-8000-000000000001', lines: [] })).s];
  ok('3: no ERP operational power — inventory / warehouse / procurement writes are refused (403/404)', ops.every((s) => s === 403 || s === 404), JSON.stringify(ops));
  ok('3: it administers the Organization (creates a unit) and sees the Company users', (await call(tokC, 'POST', '/organization/units', { type: 'branch', name: `CL Unit ${stamp}` })).s === 201 && (await call(tokC, 'GET', '/company/users')).s === 200);
  const place = await call(tokC, 'PUT', `/company/users/${ON.id}/scopes`, { grants: [{ orgUnitId: unitN.id, includeDescendants: true }] });
  ok('3: it places OTHER people on any unit of the tree although it has no data scope of its own (administrative reach, not a data privilege)', place.s === 200 && place.d.after.length === 1, `status ${place.s}`);
  const selfScope = await call(tokC, 'PUT', `/company/users/${C.id}/scopes`, { grants: [{ orgUnitId: unitN.id, includeDescendants: true }] });
  ok('3 / no self-elevation: it cannot add to or widen ITS OWN scope (403 SELF_SCOPE_CHANGE)', selfScope.s === 403 && selfScope.code === 'SELF_SCOPE_CHANGE', `status ${selfScope.s} ${selfScope.code || ''}`);
  const selfRole = await call(tokC, 'PUT', `/company/users/${C.id}/roles`, { roleKeys: ['company_admin', roleN.d.key] });
  ok('3 / no self-elevation: it cannot change its own roles (403 SELF_ROLE_CHANGE)', selfRole.s === 403 && selfRole.code === 'SELF_ROLE_CHANGE', `status ${selfRole.s}`);
  const toOp = await call(tokC, 'PUT', `/company/users/${ON.id}/roles`, { roleKeys: [roleN.d.key, 'company_admin'] });
  ok('3: it can administer the roles of OTHER people (the operator becomes a second administrator: a legitimate delegation, audited)', toOp.s === 200, `status ${toOp.s}`);
  await call(tokC, 'PUT', `/company/users/${ON.id}/roles`, { roleKeys: [roleN.d.key] });
  const pv = (await call(tokC, 'GET', `/company/users/${C.id}/effective-access?node=sales.order.create&level=editable`)).d;
  ok('3: the Effective Access Preview agrees — the company_admin is refused sales.order.create by PERMISSION, and holds the administration nodes', pv && pv.decision && pv.decision.allowed === false && pv.decision.refusedBy === 'permission' && pv.roles.join() === 'company_admin', JSON.stringify(pv && pv.decision));
  const crossSel = await call(loginC, 'POST', '/auth/select-company', { companyId: verify.id });
  ok('3 / isolation: the new Company\'s company_admin has nothing in Verify Co (cannot select it; its N token cannot address a Verify Co user)', crossSel.s !== 200 && !(crossSel.d && crossSel.d.accessToken) && (await call(tokC, 'GET', `/company/users/${O.id}/scopes`)).s === 404, `select ${crossSel.s}`);

  // ---- tidy ----
  await call(tokC, 'DELETE', `/company/users/${ON.id}`);
  await call(tokC, 'DELETE', `/company/roles/${roleN.d.id}`);
  await tidy();
  await call(tokV, 'DELETE', `/company/roles/${role.d.id}`);
  await call(approver, 'POST', '/admin/roles/revoke', { userId: P.id, roleKey: 'support_operations' });
  await cp.end();
  console.log(out.join('\n'));
  console.log(`\n${out.filter((l) => l.startsWith('PASS')).length}/${out.length} checks passed`);
})().catch((e) => { console.log(out.join('\n')); console.error('SCRIPT ERROR', e); process.exit(2); });
