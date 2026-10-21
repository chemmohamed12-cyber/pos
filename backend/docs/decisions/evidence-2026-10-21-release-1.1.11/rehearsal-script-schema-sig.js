'use strict';
/** Schema signature of one database: tables/columns/types/nullability/defaults, indexes, constraints, and the migrations table. Usage: node schema-sig.js <db> <outfile> */
const path = require('path');
const { Client } = require(path.join(process.env.RH_APP, 'node_modules', 'pg'));
const fs = require('fs');
const crypto = require('crypto');
(async () => {
  const db = process.argv[2];
  const c = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: db });
  await c.connect();
  const cols = (await c.query(`SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, column_name`)).rows;
  const idx = (await c.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`)).rows;
  const con = (await c.query(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2`)).rows;
  const mig = (await c.query(`SELECT name, timestamp FROM migrations ORDER BY timestamp, name`)).rows;
  await c.end();
  const body = { columns: cols, indexes: idx, constraints: con };
  const sig = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const out = { db, schemaSha256: sig, tables: [...new Set(cols.map((r) => r.table_name))].length, columns: cols.length, indexes: idx.length, constraints: con.length, migrations: mig.length, migrationNames: mig.map((m) => m.name), body };
  fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ db, schemaSha256: sig, tables: out.tables, columns: out.columns, indexes: out.indexes, constraints: out.constraints, migrations: out.migrations }));
})().catch((e) => { console.error(e); process.exit(1); });
