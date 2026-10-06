#!/usr/bin/env node
/**
 * Manufacturing completion (ADR-061 Addendum 1, 2026-10-06) — additive rollout of EXACTLY three migrations to a database that already
 * exists (a Company database or the Platform database). New Company databases receive them automatically at provisioning; existing ones
 * do not, and a blanket `migration:run` would ALSO apply unrelated pending migrations (notably the unapproved D3 manual-receipt
 * migrations 1789860000000 / 1789870000000) — so this tool applies ONLY the allow-list below and nothing else.
 *
 *   1790000000000-AddBomStatus                              (sales tag)  — bill_of_materials.status + CHECK, default 'active'
 *   1790000100000-CreateRoutingAndWorkCenterTables          (manufacturing) — 4 new tables, no existing table touched
 *   1790000200000-SeedManufacturingMasterDataTerminology    (manufacturing) — terminology upsert (mfg.* + nav.manufacturing_*)
 *
 *   node tools/maintenance/apply-manufacturing-master-data-migrations.js --user <u> --password <pw> --db company_xxx                # DRY RUN
 *   node tools/maintenance/apply-manufacturing-master-data-migrations.js ... --db company_xxx --apply --evidence <dir>            # applies
 *
 * Safety:
 *  - requires `npm run build` first (it runs the COMPILED migrations from dist/);
 *  - DRY RUN by default; --apply needs --db (never "all") and --evidence <dir>; refuses a database that is not company_* / daii_* ;
 *  - a Company/Platform database without the BASE schema (no `bill_of_materials` for the sales migration, no `migrations` table) is refused;
 *  - every migration runs in its own transaction (TypeORM `transaction: 'each'`); already-applied ones are skipped (re-run = no-op);
 *  - BACK UP FIRST (pg_dump of the target) — the evidence file records the dump path you pass with --backup <file> and the tool refuses
 *    --apply when that file does not exist;
 *  - rollback = each migration's own `down()` (drop 4 tables / drop the CHECK + column / delete the seeded codes); it is additive only.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { DataSource } = require('typeorm');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const cfg = {
  host: arg('host', '127.0.0.1'),
  port: Number(arg('port', '5433')),
  user: arg('user', process.env.PGUSER || 'daii'),
  password: arg('password', process.env.PGPASSWORD || ''),
  database: arg('db', null),
};
const apply = flag('apply');
const evidenceDir = arg('evidence', null);
const backup = arg('backup', null);

const ALLOW = [
  ['sales', '1790000000000-AddBomStatus.js'],
  ['manufacturing', '1790000100000-CreateRoutingAndWorkCenterTables.js'],
  ['manufacturing', '1790000200000-SeedManufacturingMasterDataTerminology.js'],
];

async function main() {
  if (!cfg.database) throw new Error('--db <database> is required (this tool never targets "all").');
  if (!/^(company_|daii_)/.test(cfg.database)) throw new Error(`Refusing database "${cfg.database}" (must start with company_ or daii_).`);
  if (apply && !evidenceDir) throw new Error('--apply requires --evidence <dir>.');
  if (apply && (!backup || !fs.existsSync(backup))) throw new Error('--apply requires --backup <existing pg_dump file> (take the dump first).');

  const root = path.join(__dirname, '..', '..');
  const files = ALLOW.map(([tag, f]) => path.join(root, 'dist', 'database', 'migrations', tag, f));
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`Missing compiled migration ${f} — run "npm run build" first.`);

  const probe = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database });
  await probe.connect();
  const has = async (t) => (await probe.query(`SELECT to_regclass($1) AS r`, [`public.${t}`])).rows[0].r !== null;
  if (!(await has('migrations'))) throw new Error('No "migrations" table — not a provisioned DAII database.');
  if (!(await has('bill_of_materials'))) throw new Error('No "bill_of_materials" table — the sales base schema is missing; refusing.');
  if (!(await has('terminology_entries'))) throw new Error('No "terminology_entries" table — refusing.');
  const executed = (await probe.query(`SELECT name FROM migrations`)).rows.map((r) => r.name);
  await probe.end();

  const names = files.map((f) => require(f)).map((m) => Object.values(m)[0].name);
  const pending = names.filter((n) => !executed.includes(n));
  console.log(`target: ${cfg.host}:${cfg.port}/${cfg.database}`);
  console.log(`allow-list: ${names.join(', ')}`);
  console.log(`already applied: ${names.filter((n) => executed.includes(n)).join(', ') || '(none)'}`);
  console.log(`PENDING (would apply): ${pending.join(', ') || '(none)'}`);
  if (!apply) {
    console.log('DRY RUN — nothing changed. Re-run with --apply --backup <dump> --evidence <dir>.');
    return;
  }
  if (pending.length === 0) {
    console.log('Nothing to apply.');
    return;
  }

  const ds = new DataSource({
    type: 'postgres',
    host: cfg.host,
    port: cfg.port,
    username: cfg.user,
    password: cfg.password,
    database: cfg.database,
    migrations: files,
    migrationsTransactionMode: 'each',
    logging: false,
  });
  await ds.initialize();
  let ran = [];
  try {
    const result = await ds.runMigrations({ transaction: 'each' });
    ran = result.map((m) => m.name);
  } finally {
    await ds.destroy();
  }
  console.log(`APPLIED: ${ran.join(', ')}`);

  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence = { database: cfg.database, appliedAt: new Date().toISOString(), backup, applied: ran, rollback: 'each migration down(): drop work_order_operations,routing_operations,routings,work_centers / drop bill_of_materials.status + CHECK / delete seeded terminology codes' };
  fs.writeFileSync(path.join(evidenceDir, `${cfg.database}.manufacturing-master-data.evidence.json`), JSON.stringify(evidence, null, 2));
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
