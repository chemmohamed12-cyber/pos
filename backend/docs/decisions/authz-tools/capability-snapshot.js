require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard')).install(); // DB guard (M-R2 §11): default deny — no connection to an unapproved database
// READ-ONLY capability snapshot (before/after a migration) of EVERY user in EVERY isolated bv Company database (5656 only).
// Effective level per catalog node, computed with the product's own AuthorizationContext (ancestor-walk, most specific per role, most permissive across roles).
// usage: node bv-cap-snapshot.js <out.json>
const base = 'D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/';
const { Client } = require(base + 'node_modules/pg');
const { AuthorizationContext } = require(base + 'dist/foundation/authorization/authorization-context');
const { permissionCatalogNodes } = require(base + 'dist/foundation/permission/permission-catalog');
(async () => {
  const out = process.argv[2];
  if (!out) throw new Error('out file required');
  const mk = (db) => new Client({ host: '127.0.0.1', port: 5656, user: 'd3verify', password: 'x', database: db });
  const cp = mk('bv_cp'); await cp.connect();
  const dbs = (await cp.query(`SELECT c.name, d."databaseName" db FROM database_registries d JOIN companies c ON c.id = d."companyId" WHERE c.status = 'READY' ORDER BY c.name`)).rows;
  await cp.end();
  const nodes = permissionCatalogNodes();
  const snap = {};
  for (const { name, db } of dbs) {
    const c = mk(db); await c.connect();
    const rows = (await c.query(`SELECT ur."userId" u, r.id "roleId", r.key, rp."nodeKey" n, rp.access a FROM user_roles ur JOIN roles r ON r.id = ur."roleId" LEFT JOIN role_permissions rp ON rp."roleId" = r.id`)).rows;
    const byUser = new Map();
    for (const r of rows) { if (!byUser.has(r.u)) byUser.set(r.u, []); byUser.get(r.u).push(r); }
    for (const [u, rs] of byUser) {
      const roles = [...new Map(rs.map((r) => [r.roleId, { id: r.roleId, key: r.key }])).values()];
      const grants = rs.filter((r) => r.n).map((r) => ({ roleId: r.roleId, nodeKey: r.n, access: r.a }));
      snap[`${name}|${u}`] = { roles: roles.map((r) => r.key).sort(), caps: new AuthorizationContext(u, null, roles, grants).effectiveFor(nodes) };
    }
    await c.end();
  }
  require('fs').writeFileSync(out, JSON.stringify(snap));
  console.log('snapshot users:', Object.keys(snap).length, 'databases:', dbs.map((d) => d.name).join(','));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
