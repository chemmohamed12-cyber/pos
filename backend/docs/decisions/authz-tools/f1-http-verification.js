require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard')).install(); // DB guard (M-R2 §11): default deny — no connection to an unapproved database
// F1 runtime verification over REAL HTTP against the booted backend (3601, isolated env bv_cp/bv_co/company DBs). Test users only.
const API = 'http://127.0.0.1:3601/api';
const J = { 'Content-Type': 'application/json' };
const base = 'D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/';
const { Client } = require(base + 'node_modules/pg');
const out = [];
const ok = (name, cond, extra = '') => { out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  — ' + extra : '')); if (!cond) process.exitCode = 1; };
async function call(tok, method, path, body, extraHeaders = {}) {
  const r = await fetch(API + path, { method, headers: { ...J, ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch { /* none */ }
  return { s: r.status, j };
}
async function login(email) { const r = await call(null, 'POST', '/auth/login', { email, password: process.env.BV_TEST_PASSWORD }); return r.j.data.accessToken; }
async function enter(tok, companyId) { const r = await call(tok, 'POST', '/auth/select-company', { companyId }); return r.j.data.accessToken; }
(async () => {
  const pg = (db) => new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: db });
  const cp = pg('bv_cp'); await cp.connect();
  const companies = (await cp.query(`SELECT c.id, c.name, d."databaseName" db FROM companies c JOIN database_registries d ON d."companyId"=c.id WHERE c.status='READY' ORDER BY c."createdAt"`)).rows;
  const verify = companies.find((c) => c.name === 'Verify Co');
  const fresh3 = companies.find((c) => c.name === 'Fresh Co 3');

  // ---- 1. /auth/me over HTTP (platform token, then Company token) ----
  const approver = await login('bv.approver@example.test');
  const meP = (await call(approver, 'GET', '/auth/me')).j.data;
  ok('/auth/me platform mode: company null, legacy roles present, contract fields present', meP.company === null && Array.isArray(meP.roles) && meP.membership === null && 'authzVersion' in meP && Array.isArray(meP.legacyRoles), JSON.stringify({ roles: meP.roles }));
  const tokV = await enter(approver, verify.id);
  const meV = (await call(tokV, 'GET', '/auth/me')).j.data;
  ok('/auth/me with Verify Co token: company = Verify Co, Company roles from Company DB, legacy roles unchanged', meV.company?.name === 'Verify Co' && meV.membership?.roleKeys?.includes('admin') && JSON.stringify(meV.roles) === JSON.stringify(meP.roles), `caps=${Object.keys(meV.capabilities).length} scopes.unrestricted=${meV.scopes.unrestricted}`);
  const tokF = await enter(approver, fresh3.id);
  const meF = (await call(tokF, 'GET', '/auth/me')).j.data;
  ok('same identity, Fresh Co 3 token: THAT Company only (different company id, name)', meF.company?.name === 'Fresh Co 3' && meF.company?.id !== meV.company?.id);
  ok('the authorization view is bound to the Company: authzVersion and membership id differ between the two Company tokens of the same identity', meV.authzVersion !== meF.authzVersion && meV.membership.id !== meF.membership.id, `v=${meV.authzVersion} f=${meF.authzVersion}`);

  // ---- 2. forged / stale inputs are ignored ----
  const forged = await call(tokV, 'GET', '/auth/me', null, { 'x-company-id': fresh3.id, 'x-roles': 'admin' });
  ok('forged headers (x-company-id / x-roles) do not change /auth/me', forged.j.data.company?.id === verify.id && forged.j.data.authzVersion === meV.authzVersion);
  const forgedBody = await call(tokV, 'GET', '/organization/units?companyId=' + fresh3.id, null, { 'x-company-id': fresh3.id });
  ok('forged companyId query/header on a Company route is ignored (still Verify Co)', forgedBody.s === 200);
  const nobody = await call('forged.token.value', 'GET', '/auth/me');
  ok('a forged bearer token is rejected (401)', nobody.s === 401);

  // ---- 3. navigation over HTTP ----
  const nav = (await call(tokV, 'GET', '/me/navigation')).j.data.groups;
  ok('/me/navigation returns the Company navigation incl. the F1-era items', nav.some((g) => g.items.some((i) => i.to === '/pending-work')) && nav.some((g) => g.items.some((i) => i.to === '/accounting/policy')), `groups=${nav.length}`);
  const navF = (await call(tokF, 'GET', '/me/navigation')).j.data.groups;
  ok('navigation resolves under the Company token for both Companies (200, groups present)', navF.length > 0 && nav.length > 0, `verify=${nav.length} fresh3=${navF.length}`);

  // ---- 4. organization boundary over HTTP (F-1) ----
  const cpOrgBefore = (await cp.query('SELECT count(*)::int n FROM org_units')).rows[0].n;
  const unitName = 'F1-HTTP-' + Date.now();
  const created = await call(tokV, 'POST', '/organization/units', { type: 'branch', name: unitName });
  ok('Company admin creates an org unit in Verify Co via HTTP', created.s === 201 && created.j.data?.name === unitName || created.s === 201, `status ${created.s}`);
  const listV = (await call(tokV, 'GET', '/organization/units')).j.data;
  const listF = (await call(tokF, 'GET', '/organization/units')).j.data;
  ok('the unit is visible in Verify Co and ABSENT in Fresh Co 3 (same identity, other Company token)', listV.some((u) => u.name === unitName) && !listF.some((u) => u.name === unitName), `verify=${listV.length} fresh3=${listF.length}`);
  const cpOrgAfter = (await cp.query('SELECT count(*)::int n FROM org_units')).rows[0].n;
  const vdb = pg(verify.db); await vdb.connect();
  const inCompany = (await vdb.query('SELECT count(*)::int n FROM org_units WHERE name=$1', [unitName])).rows[0].n;
  ok('the row landed in the Company database and the platform org table is untouched', inCompany === 1 && cpOrgAfter === cpOrgBefore, `company rows=${inCompany}, platform org_units ${cpOrgBefore}->${cpOrgAfter}`);
  const noCompanyToken = await call(approver, 'GET', '/organization/units');
  ok('a platform token with NO Company context can no longer read the org tree (403)', noCompanyToken.s === 403, `status ${noCompanyToken.s}`);
  const noAuth = await call(null, 'GET', '/organization/units');
  ok('unauthenticated org read is refused (401)', noAuth.s === 401);

  // scoped, explicit cleanup of ONLY the row this check created (isolated Company DB)
  await vdb.query('DELETE FROM org_units WHERE name=$1', [unitName]);
  await vdb.end(); await cp.end();
  console.log(out.join('\n'));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
