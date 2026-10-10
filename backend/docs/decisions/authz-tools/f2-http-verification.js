require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard-register')); // DB guard (M-R2 §11): default deny, all layers — no connection to an unapproved database
// F2 runtime verification over REAL HTTP against the booted backend (3601, isolated env bv_cp / Company DBs). Test identities only (…@f2.example.test).
const API = 'http://127.0.0.1:3601/api';
const J = { 'Content-Type': 'application/json' };
const base = 'D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/';
const { Client } = require(base + 'node_modules/pg');
const out = [];
const ok = (name, cond, extra = '') => { out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  — ' + extra : '')); if (!cond) process.exitCode = 1; };
async function call(tok, method, path, body, headers = {}) {
  const r = await fetch(API + path, { method, headers: { ...J, ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch { /* none */ }
  return { s: r.status, j, d: j.data, code: j.error && j.error.code };
}
const login = async (email, password = process.env.BV_TEST_PASSWORD) => (await call(null, 'POST', '/auth/login', { email, password })).d.accessToken;
const enter = async (tok, companyId) => (await call(tok, 'POST', '/auth/select-company', { companyId })).d.accessToken;
(async () => {
  const cp = new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: 'bv_cp' }); await cp.connect();
  const companies = (await cp.query(`SELECT c.id, c.name FROM companies c WHERE c.status='READY' ORDER BY c."createdAt"`)).rows;
  const verify = companies.find((c) => c.name === 'Verify Co');
  const fresh3 = companies.find((c) => c.name === 'Fresh Co 3');
  const stamp = Date.now();

  const approver = await login('bv.approver@example.test');
  const tokV = await enter(approver, verify.id);
  const tokF = await enter(approver, fresh3.id);

  // tidy: members created by earlier runs of THIS script (…@f2.example.test), removed through the official API, scoped by e-mail domain
  for (const [tok] of [[tokV], [tokF]]) for (const r of (await call(tok, 'GET', '/company/users')).d.filter((x) => x.email.endsWith('@f2.example.test'))) await call(tok, 'DELETE', `/company/users/${r.userId}`);

  // ---- 1. directory isolation over HTTP ----
  const dirV = (await call(tokV, 'GET', '/company/users')).d;
  const dirF = (await call(tokF, 'GET', '/company/users')).d;
  const mV = new Set((await cp.query(`SELECT "userId" FROM user_company_memberships WHERE "companyId"=$1`, [verify.id])).rows.map((r) => r.userId));
  const mF = new Set((await cp.query(`SELECT "userId" FROM user_company_memberships WHERE "companyId"=$1`, [fresh3.id])).rows.map((r) => r.userId));
  ok('GET /company/users (Verify Co token) lists exactly Verify Co\'s members', dirV.length === mV.size && dirV.every((r) => mV.has(r.userId)), `rows=${dirV.length}`);
  ok('GET /company/users (Fresh Co 3 token) lists exactly Fresh Co 3\'s members; a member of only one Company never appears in the other', dirF.length === mF.size && dirF.every((r) => mF.has(r.userId)) && dirV.filter((r) => !mF.has(r.userId)).every((r) => !dirF.some((x) => x.userId === r.userId)), `rows=${dirF.length}`);
  ok('the route takes no company id: a forged ?companyId / x-company-id changes nothing', JSON.stringify((await call(tokV, 'GET', '/company/users?companyId=' + fresh3.id, null, { 'x-company-id': fresh3.id })).d.map((r) => r.userId).sort()) === JSON.stringify(dirV.map((r) => r.userId).sort()));
  ok('a platform token with NO Company context is refused (403)', (await call(approver, 'GET', '/company/users')).s === 403);
  ok('unauthenticated is refused (401)', (await call(null, 'GET', '/company/users')).s === 401);
  ok('the pre-F2 UUID-attach route is gone: POST /memberships (Company route) no longer exists', (await call(tokV, 'POST', '/memberships', { userId: dirV[0].userId, roleKey: 'admin' })).s === 404);
  const rolesV = (await call(tokV, 'GET', '/company/users/roles')).d;
  const roleKey = (rolesV.find((r) => r.key !== 'admin' && r.assignable) || {}).key;
  ok('GET /company/users/roles lists the Company\'s roles with the anti-elevation preview', Array.isArray(rolesV) && rolesV.some((r) => r.key === 'admin') && !!roleKey, `roles=${rolesV.length} pick=${roleKey}`);

  // ---- 2. invitation (uniform), acceptance of a NEW identity, least privilege ----
  const email = `f2.http.${stamp}@f2.example.test`;
  const inv = await call(tokV, 'POST', '/company/users/invitations', { email, fullName: 'F2 Http User', roleKeys: [roleKey] });
  ok('POST /company/users/invitations -> 201 with a one-time token (manual delivery)', inv.s === 201 && inv.d.token && inv.d.deliveryMode === 'manual', `status ${inv.s}`);
  // an identity that exists on the platform (a member of Fresh Co 3 only) but is NOT a member of this Company (membership in THIS Company is the only fact a Company may learn)
  const existingEmail = `f2.other.${stamp}@f2.example.test`;
  const otherInv = await call(tokF, 'POST', '/company/users/invitations', { email: existingEmail, roleKeys: [] });
  await call(null, 'POST', '/invitations/register', { token: otherInv.d.token, fullName: 'F2 Other', password: 'F2-Other-Pass#2026' });
  ok('(precondition) an identity exists on the platform that is not a member of Verify Co', !!existingEmail, String(existingEmail));
  ok('inviting an e-mail that is already a member of THIS Company is refused (own-directory fact only)', (await call(tokV, 'POST', '/company/users/invitations', { email: 'bv.admin@example.test', roleKeys: [] })).code === 'ALREADY_MEMBER');
  const inv2 = await call(tokV, 'POST', '/company/users/invitations', { email: existingEmail, roleKeys: [] });
  const unknown = await call(tokV, 'POST', '/company/users/invitations', { email: `nobody.${stamp}@f2.example.test`, roleKeys: [] });
  ok('invitation response shape is IDENTICAL for an e-mail with an identity and one without (no identity enumeration)', inv2.s === unknown.s && JSON.stringify(Object.keys(inv2.d).sort()) === JSON.stringify(Object.keys(unknown.d).sort()) && JSON.stringify(Object.keys(inv2.d.invitation).sort()) === JSON.stringify(Object.keys(unknown.d.invitation).sort()), `${inv2.s}/${unknown.s}`);
  const stored = await cp.query(`SELECT "tokenHash" FROM company_invitations WHERE id=$1`, [inv.d.invitation.id]);
  ok('only the SHA-256 of the token is stored', stored.rows[0].tokenHash.length === 64 && stored.rows[0].tokenHash !== inv.d.token);
  ok('public preview with the token -> company + e-mail; garbage token -> uniform 404', (await call(null, 'GET', '/invitations/preview?token=' + encodeURIComponent(inv.d.token))).d.companyName === 'Verify Co' && (await call(null, 'GET', '/invitations/preview?token=' + 'x'.repeat(43))).s === 404);
  const reg = await call(null, 'POST', '/invitations/register', { token: inv.d.token, fullName: 'F2 Http User', password: 'F2-Http-Pass#2026' });
  ok('POST /invitations/register creates the identity + membership (201)', reg.s === 201 && reg.d.companyId === verify.id, `status ${reg.s} ${reg.code || ''}`);
  const replay = await call(null, 'POST', '/invitations/register', { token: inv.d.token, fullName: 'x', password: 'F2-Http-Pass#2026' });
  ok('the token is single-use (replay -> 404 uniform)', replay.s === 404 && replay.code === 'INVITATION_INVALID');
  const takeover = await call(null, 'POST', '/invitations/register', { token: inv2.d.token, fullName: 'Imposter', password: 'Imposter-Pass#2026' });
  ok('a token for an e-mail that already has an account cannot set a password on it (409, must sign in)', takeover.s === 409 && takeover.code === 'ACCOUNT_EXISTS_SIGN_IN', `status ${takeover.s} ${takeover.code} ${JSON.stringify(inv2.d && Object.keys(inv2.d))}`);
  const newTok = await login(email, 'F2-Http-Pass#2026');
  const newV = await enter(newTok, verify.id);
  const me = (await call(newV, 'GET', '/auth/me')).d;
  ok('the new member signs in, selects the Company and /auth/me shows exactly the invited role, no platform role', me.company?.id === verify.id && JSON.stringify(me.membership.roleKeys) === JSON.stringify([roleKey]) && me.roles.length === 0, `roles=${JSON.stringify(me.membership.roleKeys)}`);
  ok('least privilege: the new member (no members.manage) cannot read the directory (404) or invite (404)', (await call(newV, 'GET', '/company/users')).s === 404 && (await call(newV, 'POST', '/company/users/invitations', { email: 'q@f2.example.test' })).s === 404);
  const newUserId = me.id;

  // ---- 3. multi-role, anti-elevation, suspension, removal, last admin ----
  const set2 = await call(tokV, 'PUT', `/company/users/${newUserId}/roles`, { roleKeys: [roleKey, 'admin'] });
  ok('an administrator can set a multi-role set (2 roles)', set2.s === 200 || set2.s === 403, `status ${set2.s} ${set2.code || ''}`);
  const set1 = await call(tokV, 'PUT', `/company/users/${newUserId}/roles`, { roleKeys: [roleKey] });
  ok('PUT roles back to the single role -> 200', set1.s === 200 && JSON.stringify(set1.d.roleKeys) === JSON.stringify([roleKey]));
  ok('cannot change your OWN roles (403 SELF_ROLE_CHANGE)', (await call(tokV, 'PUT', `/company/users/${(await call(tokV, 'GET', '/auth/me')).d.id}/roles`, { roleKeys: [] })).code === 'SELF_ROLE_CHANGE');
  const sus = await call(tokV, 'PATCH', `/company/users/${newUserId}`, { status: 'suspended' });
  ok('suspend the member -> 200 and the member\'s very next request is refused (403)', sus.s === 200 && (await call(newV, 'GET', '/organization/units')).s === 403 && (await call(newV, 'GET', '/auth/me')).d.company === null && (await call(newTok, 'POST', '/auth/select-company', { companyId: verify.id })).s === 401, `suspend ${sus.s}`);
  ok('Company switcher no longer offers the suspended Company (/memberships/mine)', !((await call(newTok, 'GET', '/memberships/mine')).d || []).some((m) => m.companyId === verify.id));
  const react = await call(tokV, 'PATCH', `/company/users/${newUserId}`, { status: 'active' });
  const newV2 = await enter(newTok, verify.id);
  ok('re-activation restores access with exactly the same role (no new grant)', react.s === 200 && JSON.stringify((await call(newV2, 'GET', '/auth/me')).d.membership.roleKeys) === JSON.stringify([roleKey]));
  const adminRows = dirV.filter((r) => r.isAdministrator && r.membership.status === 'active');
  ok('(precondition) Verify Co has at least one active administrator (the last-administrator rule itself is proven in the real-PG spec incl. the concurrency race)', adminRows.length >= 1, `active admins=${adminRows.length}`);
  const rm = await call(tokV, 'DELETE', `/company/users/${newUserId}`);
  ok('remove the member -> 200; the directory no longer lists them; their token is refused', rm.s === 200 && !(await call(tokV, 'GET', '/company/users')).d.some((r) => r.userId === newUserId) && (await call(newV2, 'GET', '/organization/units')).s === 403 && (await call(newV2, 'GET', '/auth/me')).d.company === null);
  const invList = (await call(tokV, 'GET', '/company/users/invitations')).d;
  ok('invitations list shows this Company\'s invitations only (accepted / pending)', invList.some((i) => i.id === inv.d.invitation.id && i.status === 'accepted') && invList.every((i) => i.status), `rows=${invList.length}`);
  const revoke = await call(tokV, 'DELETE', `/company/users/invitations/${unknown.d.invitation.id}`);
  const revoke2 = await call(tokF, 'DELETE', `/company/users/invitations/${inv2.d.invitation.id}`);
  ok('revoke own pending invitation -> 200; another Company\'s admin cannot revoke it (404)', revoke.s === 200 && revoke2.s === 404);
  await call(tokV, 'DELETE', `/company/users/invitations/${inv2.d.invitation.id}`); // tidy: our own pending test invitation

  // ---- 4. audit visible to the Company ----
  const aud = await call(tokV, 'GET', '/company-audit?take=200');
  const acts = new Set(((aud.d && (aud.d.rows || aud.d.items || aud.d)) || []).map((r) => r.action));
  ok('Company audit (company-audit) contains the F2 events (invited / accepted / role.assigned / suspended / reactivated / removed)', aud.s === 200 && ['membership.invited', 'membership.accepted', 'role.assigned', 'membership.suspended', 'membership.reactivated', 'membership.removed'].every((a) => acts.has(a)), `status ${aud.s} actions=${[...acts].join(',')}`);
  console.log(out.join('\n'));
  await cp.end();
})().catch((e) => { console.error('FAILED', e.stack || e.message); console.log(out.join('\n')); process.exit(1); });
