// Phase 0 — READ-ONLY authorization data analysis (SELECT statements only).
// Usage: PGHOST=127.0.0.1 PGPORT=5656 PGUSER=<user> PGPASSWORD=<pw> CP_DB=<control-plane db> node p0-db.js <out.json>
// Default target in this project: the ISOLATED environment (CP_DB=bv_cp). Running it against a shared/production database requires an explicit CTO authorization
// and CONFIRM_SHARED=yes (the script refuses a database name containing 'daii_dev' otherwise).
const base = process.env.BACKEND_DIR || (__dirname + '/../../../');
const { Client } = require(base + 'node_modules/pg');
const { MODULE_ROLE_TEMPLATES } = require(base + 'dist/foundation/module-registry/role-templates');
const CP = process.env.CP_DB || 'bv_cp';
if (/daii_dev/.test(CP) && process.env.CONFIRM_SHARED !== 'yes') throw new Error('refusing to read a shared database without CONFIRM_SHARED=yes (CTO authorization)');
const cfg = (database) => ({ host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5656), user: process.env.PGUSER, password: process.env.PGPASSWORD, database });
const LEGACY = ['admin', 'driver', 'finance', 'inventory_controller', 'sales_manager', 'sales_rep', 'sales_supervisor', 'warehouse_supervisor', 'warehouse_worker'];
const TEMPLATE_KEYS = new Set(Object.values(MODULE_ROLE_TEMPLATES).flat().map((t) => t.key));
const tplByKey = Object.fromEntries(Object.values(MODULE_ROLE_TEMPLATES).flat().map((t) => [t.key, t]));

async function q(c, sql, p) { return (await c.query(sql, p)).rows; }
async function roleGrants(c) {
  const rows = await q(c, `SELECT r.key, rp."nodeKey" node, rp.access FROM roles r LEFT JOIN role_permissions rp ON rp."roleId"=r.id ORDER BY 1,2`);
  const m = {};
  for (const r of rows) { (m[r.key] = m[r.key] || new Set()); if (r.node) m[r.key].add(r.node + '@' + r.access); }
  return m;
}
(async () => {
  const out = { generatedAt: new Date().toISOString(), env: CP + ' (READ-ONLY SELECTs)' };
  const cp = new Client(cfg(CP)); await cp.connect();
  const companies = await q(cp, `SELECT c.id, c.name, c.status, d."databaseName" db, d.status dbstatus FROM companies c LEFT JOIN database_registries d ON d."companyId"=c.id ORDER BY c."createdAt"`);
  out.companies = companies;
  const memberships = await q(cp, `SELECT m."userId", m."companyId", m."roleKey", u.email FROM user_company_memberships m LEFT JOIN users u ON u.id=m."userId"`);
  out.memberships = memberships.length;
  const users = await q(cp, `SELECT id, email, status FROM users`);
  const ambientUserRoles = await q(cp, `SELECT u.email, r.key FROM user_roles ur JOIN users u ON u.id=ur."userId" JOIN roles r ON r.id=ur."roleId" ORDER BY 1`);
  out.platformAdminInventory = { ambientUserRoles, usersWithoutMembership: users.filter((u) => !memberships.some((m) => m.userId === u.id)).map((u) => u.email), usersWithoutAnyRole: users.filter((u) => !ambientUserRoles.some((r) => r.email === u.email)).map((u) => u.email) };
  const ambientGrants = await roleGrants(cp);
  out.ambient = { roles: Object.keys(ambientGrants).length, grants: Object.values(ambientGrants).reduce((a, s) => a + s.size, 0) };
  out.ambientOrg = { org_units: (await q(cp, 'SELECT count(*)::int n FROM org_units'))[0].n, org_memberships: (await q(cp, 'SELECT count(*)::int n FROM org_memberships'))[0].n, scope_assignments: (await q(cp, 'SELECT count(*)::int n FROM scope_assignments'))[0].n };

  out.perCompany = [];
  for (const co of companies.filter((c) => c.status === 'READY' && c.dbstatus === 'ACTIVE')) {
    const c = new Client(cfg(co.db)); await c.connect();
    const grants = await roleGrants(c);
    const roleRows = await q(c, 'SELECT key FROM roles ORDER BY key');
    const userRoles = await q(c, `SELECT ur."userId", r.key FROM user_roles ur JOIN roles r ON r.id=ur."roleId"`);
    const orgUnits = (await q(c, 'SELECT count(*)::int n FROM org_units'))[0].n;
    const orgMembers = (await q(c, 'SELECT count(*)::int n FROM org_memberships'))[0].n;
    const scopes = await q(c, 'SELECT "resourceType", count(*)::int n FROM scope_assignments GROUP BY 1');
    const dbUsers = (await q(c, 'SELECT count(*)::int n FROM users'))[0].n;

    // classification
    const classification = roleRows.map(({ key }) => ({ key, class: key === 'admin' ? 'system(company_admin)' : LEGACY.includes(key) ? 'legacy' : TEMPLATE_KEYS.has(key) ? 'template' : 'custom/unknown', grants: (grants[key] || new Set()).size }));
    // template drift: code template vs DB grants
    const templateDrift = [];
    for (const { key } of roleRows) {
      const t = tplByKey[key]; if (!t) continue;
      const want = new Set(t.grants.map((g) => g.node + '@' + g.access));
      const have = grants[key] || new Set();
      const missing = [...want].filter((x) => !have.has(x));
      const extra = [...have].filter((x) => !want.has(x));
      if (missing.length || extra.length) templateDrift.push({ key, missing, extra });
    }
    // ambient vs company drift (same role key)
    const ambientVsCompany = [];
    for (const key of new Set([...Object.keys(ambientGrants), ...Object.keys(grants)])) {
      const a = ambientGrants[key] || null, b = grants[key] || null;
      if (!a || !b) { ambientVsCompany.push({ key, onlyIn: a ? 'ambient' : 'company' }); continue; }
      const onlyA = [...a].filter((x) => !b.has(x)), onlyB = [...b].filter((x) => !a.has(x));
      if (onlyA.length || onlyB.length) ambientVsCompany.push({ key, onlyAmbient: onlyA, onlyCompany: onlyB });
    }
    // membership vs company user_roles
    const mine = memberships.filter((m) => m.companyId === co.id);
    const inconsistencies = [];
    for (const m of mine) {
      const roles = userRoles.filter((r) => r.userId === m.userId).map((r) => r.key);
      if (!roles.includes(m.roleKey)) inconsistencies.push({ email: m.email, membershipRole: m.roleKey, companyRoles: roles, issue: 'membership roleKey not present in Company user_roles' });
      else if (roles.length > 1) inconsistencies.push({ email: m.email, membershipRole: m.roleKey, companyRoles: roles, issue: 'Company has extra roles not represented by the single membership roleKey' });
    }
    for (const ur of userRoles) {
      if (!mine.some((m) => m.userId === ur.userId)) inconsistencies.push({ userId: ur.userId, role: ur.key, issue: 'Company user_role without a membership (orphan)' });
    }
    // admins count
    const admins = userRoles.filter((r) => r.key === 'admin').length;
    out.perCompany.push({ company: co.name, db: co.db, roles: roleRows.length, grants: Object.values(grants).reduce((a, s) => a + s.size, 0), classification, templateDrift, ambientVsCompany, memberships: mine.length, userRoles: userRoles.length, inconsistencies, adminsInCompanyDb: admins, orgUnits, orgMembers, scopes, usersTableRows: dbUsers });
    await c.end();
  }
  await cp.end();
  require('fs').writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  console.log('ok', out.perCompany.map((c) => c.company + ':' + c.roles + 'r/' + c.grants + 'g/' + c.inconsistencies.length + 'inc/' + c.templateDrift.length + 'tdrift'));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
