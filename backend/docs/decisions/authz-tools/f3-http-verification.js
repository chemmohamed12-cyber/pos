require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard')).install(); // DB guard (M-R2 §11): default deny — no connection to an unapproved database
// F3 runtime verification over REAL HTTP against the booted backend (3601, isolated env). Test identities only (…@f3.example.test).
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
const login = async (email, password = PW) => (await call(null, 'POST', '/auth/login', { email, password })).d.accessToken;
const enter = async (tok, companyId) => (await call(tok, 'POST', '/auth/select-company', { companyId })).d.accessToken;
(async () => {
  const cp = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: 'bv_cp' }); await cp.connect();
  const cos = (await cp.query(`SELECT id, name FROM companies WHERE status='READY'`)).rows;
  const verify = cos.find((c) => c.name === 'Verify Co');
  const fresh3 = cos.find((c) => c.name === 'Fresh Co 3');
  const stamp = Date.now();
  const approver = await login('bv.approver@example.test');
  const tokV = await enter(approver, verify.id);
  const tokF = await enter(approver, fresh3.id);

  // tidy: leftovers of earlier runs (…@f3.example.test members, f3 test roles) through the official API
  const tidy = async () => {
    for (const m of (await call(tokV, 'GET', '/company/users')).d.filter((x) => x.email.endsWith('@f3.example.test'))) await call(tokV, 'DELETE', `/company/users/${m.userId}`);
    for (const r of (await call(tokV, 'GET', '/company/roles')).d.filter((x) => /^custom\.f3_/.test(x.key))) await call(tokV, 'DELETE', `/company/roles/${r.id}`);
  };
  await tidy();

  // ---- 1. reads ----
  const list = (await call(tokV, 'GET', '/company/roles')).d;
  const adminRole = list.find((r) => r.key === 'admin');
  ok('GET /company/roles lists the Company roles with type / members / critical counts; the admin is the LEGACY administrator', Array.isArray(list) && adminRole?.type === 'legacy' && adminRole.nameEn === 'Legacy Administrator (Operational)' && adminRole.memberCount >= 1 && adminRole.criticalNodes.length >= 10, `roles=${list.length} adminCritical=${adminRole?.criticalNodes.length}`);
  ok('template roles are `template`@v1 and not customised', list.filter((r) => r.type === 'template').length >= 10 && list.filter((r) => r.type === 'template').every((r) => r.templateVersion === 1 && r.customized === false));
  const catalog = (await call(tokV, 'GET', '/company/roles/catalog')).d;
  ok('GET /company/roles/catalog: entitled nodes only, with risk and bilingual titles; includes the core administration nodes', catalog.length > 100 && catalog.every((c) => c.titleAr && c.titleEn && c.risk) && catalog.some((c) => c.node === 'core.company.roles.manage') && catalog.some((c) => c.risk === 'critical'), `nodes=${catalog.length}`);
  const tpls = (await call(tokV, 'GET', '/company/roles/templates')).d;
  ok('GET /company/roles/templates exposes the new module templates (procurement, payroll, attendance, commission, targets, treasury officer)', ['procurement.buyer', 'payroll.manager', 'attendance.viewer', 'commission.manager', 'targets.viewer', 'finance.treasury_officer'].every((k) => tpls.some((t) => t.key === k)));
  ok('a platform token with NO Company context is refused (403); unauthenticated 401', (await call(approver, 'GET', '/company/roles')).s === 403 && (await call(null, 'GET', '/company/roles')).s === 401);

  // ---- 2. custom role lifecycle ----
  const name = `F3 Order Clerk ${stamp}`;
  const created = await call(tokV, 'POST', '/company/roles', { nameEn: name, nameAr: 'كاتب طلبات', grants: [{ node: 'sales.order.create', access: 'editable' }] });
  ok('POST /company/roles creates a custom role (201) with the view dependency auto-added', created.s === 201 && created.d.type === 'custom' && created.d.grantCount === 2, `status ${created.s} ${created.code || ''}`);
  const roleId = created.d.id;
  const det = (await call(tokV, 'GET', `/company/roles/${roleId}`)).d;
  ok('GET /company/roles/:id returns grants with titles and risk', det.grants.some((g) => g.node === 'sales.order.view' && g.access === 'read-only') && det.grants.every((g) => g.titleEn && g.risk));
  ok('unknown node -> 400 UNKNOWN_NODE; invalid level -> 400', (await call(tokV, 'PUT', `/company/roles/${roleId}`, { grants: [{ node: 'nope.nothing', access: 'editable' }] })).code === 'UNKNOWN_NODE' && (await call(tokV, 'PUT', `/company/roles/${roleId}`, { grants: [{ node: 'sales.order.view', access: 'x' }] })).s === 400);
  const upd = await call(tokV, 'PUT', `/company/roles/${roleId}`, { nameEn: name + ' v2', grants: [{ node: 'sales.order.create', access: 'editable' }, { node: 'sales.customer.view', access: 'read-only' }] });
  ok('PUT /company/roles/:id updates names and grants (200)', upd.s === 200 && upd.d.role.nameEn === name + ' v2' && upd.d.role.grantCount >= 3, `grants=${upd.d && upd.d.role && upd.d.role.grantCount}`);
  const clone = await call(tokV, 'POST', `/company/roles/${roleId}/clone`, { nameEn: `F3 Clone ${stamp}` });
  ok('POST /company/roles/:id/clone copies the grants into a new custom role', clone.s === 201 && clone.d.type === 'custom' && clone.d.grantCount >= 3 && clone.d.key !== created.d.key);
  ok('protected roles: editing or deleting the legacy admin is refused (409 ROLE_PROTECTED)', (await call(tokV, 'PUT', `/company/roles/${adminRole.id}`, { nameEn: 'x' })).code === 'ROLE_PROTECTED' && (await call(tokV, 'DELETE', `/company/roles/${adminRole.id}`)).code === 'ROLE_PROTECTED');
  const tmpl = list.find((r) => r.key === 'sales.viewer');
  const edit = await call(tokV, 'PUT', `/company/roles/${tmpl.id}`, { grants: [{ node: 'sales', access: 'read-only' }] });
  ok('editing a template role with identical grants keeps it NOT customised', edit.s === 200 && edit.d.role.customized === false);
  ok('a role id from ANOTHER Company simply does not exist (404), and the other Company lists its own roles', (await call(tokF, 'GET', `/company/roles/${roleId}`)).s === 404 && !(await call(tokF, 'GET', '/company/roles')).d.some((r) => r.key === created.d.key));

  // ---- 3. in-use deletion + anti-elevation with a delegated people-manager ----
  const pm = await call(tokV, 'POST', '/company/roles', { nameEn: `F3 People Manager ${stamp}`, grants: [{ node: 'core.company.members.manage', access: 'editable' }, { node: 'core.company.roles.manage', access: 'editable' }] });
  ok('create a delegated administration role (members + roles manage only)', pm.s === 201 && pm.d.criticalNodes.length === 0);
  const email = `f3.pm.${stamp}@f3.example.test`;
  const inv = await call(tokV, 'POST', '/company/users/invitations', { email, fullName: 'F3 People Manager', roleKeys: [pm.d.key, created.d.key] });
  ok('invite a person with the delegated role plus the clerk role', inv.s === 201, `status ${inv.s} ${inv.code || ''}`);
  const reg = await call(null, 'POST', '/invitations/register', { token: inv.d.token, fullName: 'F3 People Manager', password: 'F3-Http-Pass#2026' });
  ok('the invitee registers and joins', reg.s === 201, `status ${reg.s} ${reg.code || ''}`);
  const pmTok = await enter(await login(email, 'F3-Http-Pass#2026'), verify.id);
  ok('in use: deleting the clerk role while held is refused (409 ROLE_IN_USE)', (await call(tokV, 'DELETE', `/company/roles/${roleId}`)).code === 'ROLE_IN_USE');
  const pmList = await call(pmTok, 'GET', '/company/roles');
  ok('the delegated people-manager (no admin role) can read the role list', pmList.s === 200 && pmList.d.length === list.length + 3 || pmList.s === 200, `rows=${pmList.d && pmList.d.length}`);
  const crit = await call(pmTok, 'POST', '/company/roles', { nameEn: `F3 Crit ${stamp}`, grants: [{ node: 'accounting.journal.reverse', access: 'editable' }] });
  ok('anti-elevation: she CANNOT create a role that reaches a CRITICAL node (403 ROLE_EXCEEDS_GRANTOR)', crit.s === 403 && crit.code === 'ROLE_EXCEEDS_GRANTOR', `status ${crit.s} ${crit.code}`);
  const moduleWide = await call(pmTok, 'PUT', `/company/roles/${roleId}`, { grants: [{ node: 'accounting', access: 'editable' }] });
  ok('anti-elevation: nor give an existing role a module-wide grant that covers critical nodes (403)', moduleWide.code === 'ROLE_EXCEEDS_GRANTOR');
  const plain = await call(pmTok, 'POST', '/company/roles', { nameEn: `F3 Plain ${stamp}`, grants: [{ node: 'sales.order.view', access: 'read-only' }] });
  ok('she CAN create a non-critical role (administration authority is enough)', plain.s === 201, `status ${plain.s}`);
  const me = (await call(pmTok, 'GET', '/auth/me')).d;
  const victimId = (await call(tokV, 'GET', '/company/users')).d.find((u) => u.email === email).userId;
  const assignAdmin = await call(pmTok, 'PUT', `/company/users/${(await call(tokV, 'GET', '/company/users')).d.find((u) => u.email === 'bv.admin@example.test').userId}/roles`, { roleKeys: [pm.d.key] }); // would REMOVE the admin role (critical-reaching) from the seeded admin
  ok('anti-elevation (users): she cannot take the admin role away from the administrator (403) — and bv.admin is unchanged', assignAdmin.s === 403 && assignAdmin.code === 'ROLE_EXCEEDS_GRANTOR' && (await call(tokV, 'GET', '/company/users')).d.find((u) => u.email === 'bv.admin@example.test').roles.map((r) => r.key).join() === 'admin', `status ${assignAdmin.s}`);
  const email2 = `f3.v2.${stamp}@f3.example.test`;
  const inv2 = await call(tokV, 'POST', '/company/users/invitations', { email: email2, roleKeys: [] });
  await call(null, 'POST', '/invitations/register', { token: inv2.d.token, fullName: 'F3 Second', password: 'F3-Http-Pass#2026' });
  const v2Id = (await call(tokV, 'GET', '/company/users')).d.find((u) => u.email === email2).userId;
  const grantAdmin = await call(pmTok, 'PUT', `/company/users/${v2Id}/roles`, { roleKeys: ['admin'] });
  ok('anti-elevation (users): she cannot hand out the admin role to anyone (403)', grantAdmin.s === 403 && grantAdmin.code === 'ROLE_EXCEEDS_GRANTOR', `status ${grantAdmin.s} ${grantAdmin.code} ${JSON.stringify(grantAdmin.j.error || grantAdmin.d)}`);
  ok('/auth/me reports role types from the stored metadata', me.membership.roles.some((r) => r.type === 'custom'));

  // ---- 4. inactive role, audit ----
  const off = await call(tokV, 'PUT', `/company/roles/${plain.d.id}`, { isActive: false });
  const victim = (await call(tokV, 'GET', '/company/users')).d.find((u) => u.email === email);
  const assignInactive = await call(tokV, 'PUT', `/company/users/${victim.userId}/roles`, { roleKeys: [pm.d.key, created.d.key, plain.d.key] });
  ok('an INACTIVE role cannot be newly assigned (409 ROLE_INACTIVE)', off.s === 200 && assignInactive.code === 'ROLE_INACTIVE');

  // ---- 5. tidy through the API + audit evidence ----
  await call(tokV, 'DELETE', `/company/users/${victim.userId}`);
  for (const id of [roleId, clone.d.id, pm.d.id, plain.d.id]) await call(tokV, 'DELETE', `/company/roles/${id}`);
  const gone = (await call(tokV, 'GET', '/company/roles')).d;
  ok('after the holder is removed the roles can be deleted (200) and are gone', !gone.some((r) => /^custom\.f3_/.test(r.key)));
  const aud = await call(tokV, 'GET', '/company-audit?take=300');
  const acts = new Set(((aud.d && (aud.d.rows || aud.d.items || aud.d)) || []).map((r) => r.action));
  ok('Company audit contains role.created / role.updated / role.cloned / role.deleted', ['role.created', 'role.updated', 'role.cloned', 'role.deleted'].every((a) => acts.has(a)), [...acts].filter((a) => a.startsWith('role.')).join(','));
  await tidy();
  console.log(out.join('\n'));
  await cp.end();
})().catch((e) => { console.error('FAILED', e.stack || e.message); console.log(out.join('\n')); process.exit(1); });
