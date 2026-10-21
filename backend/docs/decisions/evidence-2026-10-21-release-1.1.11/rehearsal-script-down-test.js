'use strict';
/** Reverts the N newest migrations (using the NEW tree's own migration classes) on a CLONE database, then the caller compares its schema signature with the pre-upgrade one. env: RH_APP RH_CLONE N + DB_* */
const path = require('path');
const APP = process.env.RH_APP;
const nm = (p) => require(path.join(APP, 'node_modules', p));
const { DataSource } = nm('typeorm');
const { createMigrationDataSource } = require(path.join(APP, 'dist', 'foundation', 'release', 'migration-datasource'));
const db = process.env.RH_CLONE;
if (!/^daii_test_biz_t\d+_/.test(db)) throw new Error('refusing: clone name must be daii_test_biz_tNN_*');
(async () => {
  const ds = createMigrationDataSource(APP, { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), username: process.env.DB_USER, password: process.env.DB_PASSWORD, database: db });
  await ds.initialize();
  const n = Number(process.env.N);
  const reverted = [];
  for (let i = 0; i < n; i++) {
    const before = (await ds.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0];
    try { await ds.undoLastMigration({ transaction: 'each' }); reverted.push(before.name); } catch (e) { console.log('REVERT FAILED at ' + before.name + ': ' + e.message); break; }
  }
  console.log(JSON.stringify({ db, requested: n, revertedCount: reverted.length, reverted }));
  await ds.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
