require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard')).install(); // DB guard (M-R2 §11): default deny — no connection to an unapproved database
// F4 runtime verification over REAL HTTP against the booted backend (3601, isolated env). Test identities only (…@f4.example.test).
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
const NEW_PW = 'F4-Http-Pass#2026';
const login = async (email, password = PW) => (await call(null, 'POST', '/auth/login', { email, password })).d.accessToken;
const enter = async (tok, companyId) => (await call(tok, 'POST', '/auth/select-company', { companyId })).d.accessToken;
(async () => {
  const cp = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: 'bv_cp' }); await cp.connect();
  const cos = (await cp.query(`SELECT id, name FROM companies WHERE status='READY'`)).rows;
  const verify = cos.find((c) => c.name === 'Verify Co');
  const stamp = Date.now();
  const approver = await login('bv.approver@example.test'); // legacy platform admin (super-user alias) + Verify Co administrator
  const tokV = await enter(approver, verify.id);
  const fresh3 = cos.find((c) => c.name === 'Fresh Co 3');
  const tokF = await enter(approver, fresh3.id); // the platform test identities are created as members of ANOTHER Company, so none of them is a regular member of Verify Co

  // tidy leftovers of earlier runs (official API, scoped by e-mail domain)
  const tidy = async () => {
    for (const t of [tokV, tokF]) for (const m of (await call(t, 'GET', '/company/users')).d.filter((x) => x.email.endsWith('@f4.example.test'))) await call(t, 'DELETE', `/company/users/${m.userId}`);
  };
  await tidy();

  // ---- 1. platform roles + capabilities ----
  const roles = (await call(approver, 'GET', '/platform/roles')).d;
  ok('GET /platform/roles lists the four platform roles and the legacy admin alias with holder counts', ['platform_super_admin', 'company_manager', 'support_operations', 'platform_audit_readonly', 'admin'].every((k) => roles.some((r) => r.key === k)) && roles.find((r) => r.key === 'admin').holders >= 2, roles.map((r) => `${r.key}:${r.holders}`).join(' '));
  const nodes = (await call(approver, 'GET', '/platform/nodes')).d;
  ok('GET /platform/nodes: the platform namespace with risk and bilingual titles', nodes.length >= 30 && nodes.every((n) => n.titleAr && n.titleEn && n.risk) && nodes.some((n) => n.risk === 'platform-critical'), `nodes=${nodes.length}`);
  const meA = (await call(approver, 'GET', '/auth/me')).d;
  ok('/auth/me platform.capabilities: the legacy admin holds every platform node (alias)', Object.keys(meA.platform.capabilities).length >= nodes.length, `caps=${Object.keys(meA.platform.capabilities).length}`);

  // ---- 2. four platform users ----
  const mkUser = async (label, roleKey) => {
    const email = `f4.${label}.${stamp}@f4.example.test`;
    const inv = await call(tokF, 'POST', '/company/users/invitations', { email, fullName: `F4 ${label}`, roleKeys: [] });
    const reg = await call(null, 'POST', '/invitations/register', { token: inv.d.token, fullName: `F4 ${label}`, password: NEW_PW });
    const id = (await call(tokF, 'GET', '/company/users')).d.find((u) => u.email === email).userId;
    const as = roleKey ? await call(approver, 'POST', '/admin/roles/assign', { userId: id, roleKey }) : { s: 201 };
    return { label, email, id, regStatus: reg.s, assign: as.s };
  };
  const cm = await mkUser('cm', 'company_manager');
  const so = await mkUser('so', 'support_operations');
  const au = await mkUser('au', 'platform_audit_readonly');
  const sa = await mkUser('sa', 'platform_super_admin');
  ok('platform users created (new identities) and assigned platform roles by the Super Admin', [cm, so, au, sa].every((u) => u.regStatus === 201 && u.assign === 201), [cm, so, au, sa].map((u) => `${u.label}:${u.regStatus}/${u.assign}`).join(' '));
  const tCm = await login(cm.email, NEW_PW), tSo = await login(so.email, NEW_PW), tAu = await login(au.email, NEW_PW), tSa = await login(sa.email, NEW_PW);
  const meCm = (await call(tCm, 'GET', '/auth/me')).d;
  ok('/auth/me platform.capabilities follows the platform role (Company Manager: company.suspend yes, release.deploy no)', meCm.platform.capabilities['platform.company.suspend'] === 'editable' && !meCm.platform.capabilities['platform.release.deploy'] && !meCm.platform.capabilities['platform.config.edit']);

  // ---- 3. matrix over HTTP ----
  const code = async (t, m, p, b) => (await call(t, m, p, b)).s;
  const checks = [
    ['GET /installation/companies', 'GET', '/installation/companies'],
    ['GET /installation/plans', 'GET', '/installation/plans'],
    ['GET /config/keys', 'GET', '/config/keys'],
    ['GET /release/releases', 'GET', '/release/releases'],
    ['GET /admin/users', 'GET', '/admin/users'],
    ['PUT /platform/integrations/providers/qr_store', 'PUT', '/platform/integrations/providers/qr_store', { status: 'available' }],
  ];
  const expectAllowed = { sa: [1, 1, 1, 1, 1, 1], cm: [1, 1, 0, 0, 1, 0], so: [1, 1, 0, 1, 1, 0], au: [1, 1, 1, 1, 1, 0] };
  const tokens = { sa: tSa, cm: tCm, so: tSo, au: tAu };
  const results = {};
  for (const [who, t] of Object.entries(tokens)) results[who] = await Promise.all(checks.map(async (c) => { const s = await code(t, c[1], c[2], c[3]); return s < 300 ? 1 : (s === 403 ? 0 : -s); }));
  ok('HTTP matrix: Super Admin all allowed; Company Manager no config/release/integration; Support reads + release.view; Auditor reads only', JSON.stringify(results) === JSON.stringify(expectAllowed), JSON.stringify(results));
  const pure = await mkUser('pure', null); // a Company member with NO platform role at all
  const tPure = await login(pure.email, NEW_PW);
  const tPureV = await enter(tPure, fresh3.id);
  ok('a person with NO platform role is refused on every platform route (403) — also with a Company token; the Company view stays theirs', (await Promise.all(['/platform/roles', '/installation/companies', '/admin/users', '/config/keys', '/release/releases'].flatMap((p) => [code(tPure, 'GET', p), code(tPureV, 'GET', p)]))).every((s2) => s2 === 403));
  ok('no token -> 401; forged token -> 401', (await call(null, 'GET', '/platform/roles')).s === 401 && (await call('forged.token', 'GET', '/platform/roles')).s === 401);

  // ---- 4. platform role escalation ----
  ok('escalation: a Company Manager cannot assign any role (403), a Super Admin can', (await call(tCm, 'POST', '/admin/roles/assign', { userId: au.id, roleKey: 'platform_super_admin' })).s === 403 && (await call(tSa, 'POST', '/admin/roles/assign', { userId: au.id, roleKey: 'support_operations' })).s === 201);
  await call(tSa, 'POST', '/admin/roles/revoke', { userId: au.id, roleKey: 'support_operations' });
  ok('the Auditor is read-only for platform users too (cannot reset a password, 403)', (await call(tAu, 'POST', `/admin/users/${au.id}/reset-password`, { newPassword: 'Something-Else-1' })).s === 403);

  // ---- 5. support access ----
  const bad1 = await call(tSo, 'POST', '/platform/support-access', { companyId: verify.id, reason: 'short' });
  const bad2 = await call(tSo, 'POST', '/platform/support-access', { companyId: verify.id, reason: 'Investigating ticket 5521 for the customer', hours: 9 });
  ok('support access validation: short reason -> 400, > 8 hours -> 400', bad1.s === 400 && bad2.s === 400, `${bad1.s}/${bad2.s}`);
  ok('the Auditor cannot open support access (403)', (await call(tAu, 'POST', '/platform/support-access', { companyId: verify.id, reason: 'Investigating ticket 5521 for the customer' })).s === 403);
  const grant = await call(tSo, 'POST', '/platform/support-access', { companyId: verify.id, reason: 'Investigating ticket 5521 for the customer', hours: 1 });
  ok('Support/Operations opens time-boxed support access to Verify Co (201) with the fixed read-only role', grant.s === 201 && grant.d.roleKey === 'support_readonly' && new Date(grant.d.expiresAt).getTime() - Date.now() <= 3_700_000, `status ${grant.s} ${grant.code || ''}`);
  const tSoV = await enter(tSo, verify.id);
  const meSo = (await call(tSoV, 'GET', '/auth/me')).d;
  ok('the support session sees the Company read-only: /auth/me kind=support, role support_readonly, expiry present', meSo.membership && meSo.membership.kind === 'support' && meSo.membership.roleKeys.join() === 'support_readonly' && !!meSo.membership.expiresAt);
  const so1 = await call(tSoV, 'GET', '/sales-orders');
  const so2 = await call(tSoV, 'POST', '/company/users/invitations', { email: 'x@f4.example.test' });
  const so3 = await call(tSoV, 'GET', '/company/roles');
  ok('support session: can READ Company data (200), cannot administer users/roles (404) nor write', so1.s === 200 && so2.s === 404 && so3.s === 404, `${so1.s}/${so2.s}/${so3.s}`);
  const dir = (await call(tokV, 'GET', '/company/users')).d.find((u) => u.email === so.email);
  ok('Company-visible: the Company administrator sees the support access (kind, reason, expiry) in the user directory', dir && dir.membership.kind === 'support' && dir.membership.reason.startsWith('Investigating ticket 5521') && !!dir.membership.expiresAt);
  const aud = await call(tokV, 'GET', '/company-audit?take=300');
  const acts = new Set(((aud.d && (aud.d.rows || aud.d.items || aud.d)) || []).map((r) => r.action));
  ok('Company-visible: support_access.granted is in the COMPANY audit chain', acts.has('support_access.granted'));
  ok('the Company cannot turn it into a normal membership (409 SUPPORT_ACCESS_FIXED) but can end it', (await call(tokV, 'PUT', `/company/users/${so.id}/roles`, { roleKeys: ['sales.manager'] })).code === 'SUPPORT_ACCESS_FIXED');
  // expiry enforced on the very next request, before any sweep
  await cp.query(`UPDATE user_company_memberships SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = $1 AND "companyId" = $2`, [so.id, verify.id]);
  ok('expiry is enforced on the very next request: the Company route is refused (403) and select-company 401', (await call(tSoV, 'GET', '/sales-orders')).s === 403 && (await call(tSo, 'POST', '/auth/select-company', { companyId: verify.id })).s === 401);
  const listed = await call(tSo, 'GET', '/platform/support-access');
  const gone = (await cp.query(`SELECT 1 FROM user_company_memberships WHERE "userId"=$1 AND "companyId"=$2`, [so.id, verify.id])).rowCount === 0;
  ok('the sweeper closed it (membership removed) and audited it in the Company chain', listed.s === 200 && gone && new Set((((await call(tokV, 'GET', '/company-audit?take=400')).d || {}).rows || (await call(tokV, 'GET', '/company-audit?take=400')).d || []).map((r) => r.action)).has('support_access.expired'));
  // Company administrator ends a live one
  await call(tSo, 'POST', '/platform/support-access', { companyId: verify.id, reason: 'Second window to verify the fix on site', hours: 1 });
  const end = await call(tokV, 'DELETE', `/company/users/${so.id}`);
  ok('the Company administrator ends a live support access (200); the support user is refused immediately', end.s === 200 && (await call(tSo, 'POST', '/auth/select-company', { companyId: verify.id })).s === 401);
  ok('support access can only be opened for a PLATFORM user (a Company member with no platform role -> 400)', (await call(tSa, 'POST', '/platform/support-access', { companyId: verify.id, userId: pure.id, reason: 'Attempt for a person without a platform role' })).s === 400);
  ok('a Super Admin WITHOUT support access has no Company data access at all (select-company 401)', (await call(tSa, 'POST', '/auth/select-company', { companyId: verify.id })).s === 401);

  // ---- 6. integration catalog + legacy compatibility ----
  const prov = (await call(tSa, 'GET', '/platform/integrations/providers')).d;
  ok('GET /platform/integrations/providers: the platform-owned catalog lists qr_store (available)', prov.some((p) => p.code === 'qr_store' && p.status === 'available'));
  const off = await call(tSa, 'PUT', '/platform/integrations/providers/qr_store', { status: 'disabled' });
  const on = await call(tSa, 'PUT', '/platform/integrations/providers/qr_store', { status: 'available' });
  ok('availability can be closed and re-opened by a platform integration manager (audited)', off.d.status === 'disabled' && on.d.status === 'available');
  ok('legacy compatibility: the existing platform admin keeps every route (plans, config, release, users, companies)', (await Promise.all(['/installation/plans', '/config/keys', '/release/releases', '/admin/users', '/installation/companies'].map((p) => code(approver, 'GET', p)))).every((s) => s === 200));

  // ---- 7. tidy ----
  for (const u of [cm, so, au, sa, pure]) {
    for (const r of ['company_manager', 'support_operations', 'platform_audit_readonly', 'platform_super_admin']) await call(approver, 'POST', '/admin/roles/revoke', { userId: u.id, roleKey: r });
    await call(approver, 'POST', `/admin/users/${u.id}/status`, { status: 'disabled' });
  }
  await tidy();
  console.log(out.join('\n'));
  await cp.end();
})().catch((e) => { console.error('FAILED', e.stack || e.message); console.log(out.join('\n')); process.exit(1); });
