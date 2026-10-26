'use strict';
// Stage B verification environment: clones the upgraded 1.1.11 rehearsal DBs (t73) into daii_test_biz_t96_vw_* and repoints the Company registry row. Isolated test cluster only.
const path = require('path');
const { Client } = require(path.join(process.env.RH_APP, 'node_modules', 'pg'));
const base = { host: process.env.DB_HOST, port: +process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD };
(async () => {
  const c = new Client({ ...base, database: 'postgres' });
  await c.connect();
  for (const [s, d] of [['daii_test_biz_t73_rh_main', 'daii_test_biz_t96_vw_main'], ['daii_test_biz_t73_rh_co1', 'daii_test_biz_t96_vw_co1']]) {
    await c.query('DROP DATABASE IF EXISTS "' + d + '" WITH (FORCE)');
    await c.query('CREATE DATABASE "' + d + '" TEMPLATE "' + s + '"');
    console.log('cloned', d);
  }
  await c.end();
  const m = new Client({ ...base, database: 'daii_test_biz_t96_vw_main' });
  await m.connect();
  const r = await m.query('UPDATE database_registries SET "databaseName" = $1 WHERE "databaseName" = $2', ['daii_test_biz_t96_vw_co1', 'daii_test_biz_t73_rh_co1']);
  console.log(r.rowCount, 'registry row(s) repointed');
  await m.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
