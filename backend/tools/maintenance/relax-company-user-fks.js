#!/usr/bin/env node
/**
 * Area 21 (2026-10-05) — ADR-073 extension (CTO-ratified): Company databases hold no `users` rows (Model B — the Platform DB is the
 * sole User identity authority), so no Company database may keep a foreign key that references `users(id)`. New Company databases get
 * those constraints dropped at provisioning (`applyCompanyAuthorizationSchemaAdjustment`); this tool applies the same, idempotent
 * correction to Company databases that already exist.
 *
 *   node tools/maintenance/relax-company-user-fks.js --user <admin> --password <pw> --only company_xxx            # DRY RUN: lists the constraints
 *   node tools/maintenance/relax-company-user-fks.js ... --only company_xxx --apply --evidence <dir>               # drops them, ONE transaction per database
 *
 * Safety:
 *  - only databases whose name starts with `company_` are touched, and `--only` is REQUIRED with --apply (never "all");
 *  - the whole change for a database is one transaction: it records every dropped constraint (with its exact definition, as ready-to-run
 *    rollback SQL), drops them, then verifies that 0 FKs reference users(id) AND that every other FK/PK/unique/check constraint is
 *    unchanged — otherwise it ROLLS BACK;
 *  - constraints only — no row, column, table or user is changed; re-running is a no-op;
 *  - the evidence file (<dir>/<db>.relax-evidence.json) holds the before-list, after-counts and the rollback SQL.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const base = {
  host: arg('host', '127.0.0.1'),
  port: Number(arg('port', '5433')),
  user: arg('user', process.env.PGUSER || 'daii'),
  password: arg('password', process.env.PGPASSWORD || ''),
};
const apply = flag('apply');
const only = arg('only', null);
const evidenceDir = arg('evidence', null);

const USER_FKS = `SELECT cl.relname AS table_name, c.conname AS constraint_name, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      WHERE c.contype = 'f' AND c.confrelid = to_regclass('public.users') AND ns.nspname = 'public'
      ORDER BY 1, 2`;

async function constraintCounts(c) {
  const r = await c.query(
    `SELECT contype, count(*)::int n FROM pg_constraint WHERE connamespace = 'public'::regnamespace GROUP BY contype ORDER BY contype`,
  );
  const m = {};
  for (const row of r.rows) m[row.contype] = row.n;
  return m;
}

(async () => {
  if (apply && !only) {
    console.error('refused: --apply requires --only <company_database> (the tool never applies to "all databases")');
    process.exit(2);
  }
  if (only && !only.startsWith('company_')) {
    console.error(`refused: "${only}" is not a company_* database`);
    process.exit(2);
  }
  const root = new Client({ ...base, database: 'postgres' });
  await root.connect();
  let dbs = (await root.query(`SELECT datname FROM pg_database WHERE datname LIKE 'company\\_%' ORDER BY 1`)).rows.map((r) => r.datname);
  await root.end();
  if (only) dbs = dbs.filter((d) => d === only);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} on ${dbs.length} Company database(s) at ${base.host}:${base.port}`);
  let failed = 0;
  for (const db of dbs) {
    const c = new Client({ ...base, database: db });
    try {
      await c.connect();
      const users = (await c.query('SELECT count(*)::int n FROM users')).rows[0].n;
      const fks = (await c.query(USER_FKS)).rows;
      const before = await constraintCounts(c);
      console.log(`- ${db}: users rows=${users}, FK->users=${fks.length}`);
      if (!apply) {
        for (const fk of fks) console.log(`    ${fk.table_name}.${fk.constraint_name}`);
        continue;
      }
      await c.query('BEGIN');
      try {
        for (const fk of fks) await c.query(`ALTER TABLE "${fk.table_name}" DROP CONSTRAINT "${fk.constraint_name}"`);
        const left = (await c.query(USER_FKS)).rows.length;
        const after = await constraintCounts(c);
        const expectedAfter = { ...before, f: (before.f || 0) - fks.length };
        const unchangedOthers = JSON.stringify(after) === JSON.stringify(expectedAfter);
        if (left !== 0 || !unchangedOthers) {
          await c.query('ROLLBACK');
          failed++;
          console.log(`    ROLLED BACK — remaining FK->users=${left}, other constraints unchanged=${unchangedOthers} (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`);
          continue;
        }
        await c.query('COMMIT');
        console.log(`    dropped ${fks.length}; remaining FK->users=0; constraints before ${JSON.stringify(before)} -> after ${JSON.stringify(after)} (only FKs reduced by ${fks.length})`);
        if (evidenceDir) {
          fs.mkdirSync(evidenceDir, { recursive: true });
          const evidence = {
            database: db,
            appliedAt: new Date().toISOString(),
            usersRows: users,
            droppedForeignKeys: fks,
            constraintCountsBefore: before,
            constraintCountsAfter: after,
            rollbackSql: fks.map((fk) => `ALTER TABLE "${fk.table_name}" ADD CONSTRAINT "${fk.constraint_name}" ${fk.definition};`),
          };
          fs.writeFileSync(path.join(evidenceDir, `${db}.relax-evidence.json`), JSON.stringify(evidence, null, 2));
        }
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
    } catch (e) {
      failed++;
      console.log(`- ${db}: ERROR ${e.message}`);
    } finally {
      await c.end().catch(() => {});
    }
  }
  process.exit(failed ? 1 : 0);
})();
