#!/usr/bin/env node
require('./db-guard-register'); // DB guard (M-R2 §11): default deny — no connection to an unapproved database
/**
 * Provisions a DISPOSABLE, SEEDED "ambient" test database for the suites that
 * boot the whole `AppModule` against the platform database and hard-wire the
 * fixture users (hr-phase1, attendance-*, payroll-*, commission-*, closing-snapshot-*,
 * grni/wip reconciliation, work-order e2e, ...). Those suites used to depend on a
 * hand-seeded `daii_dev`; they now run against this database instead, so nothing
 * is ever written to the shared development database and no permanent test users
 * are kept there.
 *
 *   node tools/testing/provision-isolated-ambient-db.js [--db daii_test_ambient]
 *        [--host 127.0.0.1] [--port 5544] [--user isolated_admin] [--password ...]
 *
 * Then run a suite against it:
 *   DB_HOST=127.0.0.1 DB_PORT=5544 DB_USER=isolated_admin DB_PASSWORD=... DB_NAME=daii_test_ambient npx jest <spec>
 *
 * What it does (idempotent — drops and recreates ONLY the named database):
 *   1. CREATE DATABASE (never on a protected target — see the guard below)
 *   2. run every migration through the compiled data source (`npm run build` first)
 *   3. insert the singleton `installation` row (dev, unsigned DAII_STANDARD)
 *   4. insert the three fixture users the specs reference by UUID, each with an
 *      `admin` role and a credential (random password, never printed)
 *   5. import the standard IFRS-SME chart of accounts (the financial specs post to
 *      control accounts such as `ar`, `wages_payable`, `wip`); this is the same
 *      opt-in template the product offers, built from the compiled application code.
 *      The template itself carries the `wip` control account (1150) since handoff H2 —
 *      it is not added by hand here
 *   6. open fiscal years covering today, a `grni` control account, a GL-mapped treasury
 *      account, and one supplier / warehouse / product — the minimum base rows the
 *      financial and procurement suites select with `LIMIT 1`
 * Everything else (config keys, role templates, terminology) is seeded by the
 * application's own boot seeders when a suite starts, exactly as in production.
 */
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : def;
}

const cfg = {
  host: arg('host', '127.0.0.1'),
  port: Number(arg('port', '5544')),
  user: arg('user', 'isolated_admin'),
  password: arg('password', process.env.ISOLATED_PG_PASSWORD || 'isolated_only_pw'),
  db: arg('db', 'daii_test_ambient'),
};

// SAFETY: this tool drops its target. It must never be pointed at the shared dev server / dev database.
const PROTECTED_PORTS = new Set([5433]);
const PROTECTED_DBS = new Set(['daii_dev', 'postgres', 'daii_dev_rollback_20261004_2358']);
if (PROTECTED_PORTS.has(cfg.port) || PROTECTED_DBS.has(cfg.db) || cfg.db.startsWith('company_') || !/^daii_test_[a-z0-9_]+$/.test(cfg.db)) {
  console.error(`REFUSED: target ${cfg.host}:${cfg.port}/${cfg.db} is protected or not a daii_test_* database.`);
  process.exit(2);
}

// The fixture users the existing specs reference by UUID (see the `ADMIN_A` / `SECOND_APPROVER` constants).
const FIXTURE_USERS = [
  { id: 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80', email: 'admin@daii.example', fullName: 'MOHAMED KHAIRY' },
  { id: 'f539302e-9ae7-4cc2-99cf-381f08acab83', email: 'debug-admin@daii.example', fullName: 'Debug Admin' },
  { id: '04531f67-b087-4459-93de-55c61da9d66b', email: 'wh-admin@daii.example', fullName: 'Warehouse Admin' },
];

async function main() {
  const root = path.join(__dirname, '..', '..');
  const admin = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: 'postgres' });
  await admin.connect();
  console.log(`target: ${cfg.host}:${cfg.port} (${(await admin.query('show data_directory').catch(() => ({ rows: [{ data_directory: 'n/a' }] }))).rows[0].data_directory})`);
  await admin.query(`DROP DATABASE IF EXISTS "${cfg.db}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${cfg.db}"`);
  await admin.end();
  console.log(`created ${cfg.db}`);

  const env = { ...process.env, DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_USER: cfg.user, DB_PASSWORD: cfg.password, DB_NAME: cfg.db };
  const mig = spawnSync(process.execPath, ['./node_modules/typeorm/cli.js', '-d', 'dist/database/data-source.js', 'migration:run'], { cwd: root, env, encoding: 'utf8' });
  if (mig.status !== 0) {
    console.error(mig.stdout.slice(-1500), mig.stderr.slice(-1500));
    throw new Error('migration run failed — is the backend built (npm run build)?');
  }
  const applied = (mig.stdout.match(/has been executed successfully/g) || []).length;
  console.log(`migrations applied: ${applied}`);

  const db = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.db });
  await db.connect();
  await db.query(
    `INSERT INTO installation ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest","status","verificationState")
     VALUES ('installation','test-installation','Isolated Test Installation','DAII_STANDARD','1.0.0','{}','active','unlicensed')`,
  );
  const role = (await db.query(`SELECT id FROM roles WHERE key = 'admin'`)).rows[0];
  if (!role) throw new Error('admin role missing after migrations');
  for (const u of FIXTURE_USERS) {
    const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
    await db.query(`INSERT INTO users ("id","fullName","email","status") VALUES ($1,$2,$3,'active')`, [u.id, u.fullName, u.email]);
    await db.query(`INSERT INTO credentials ("userId","passwordHash") VALUES ($1,$2)`, [u.id, hash]);
    await db.query(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2)`, [u.id, role.id]);
  }
  console.log(`seeded installation + ${FIXTURE_USERS.length} fixture users (admin role)`);

  // 5. the standard chart of accounts — straight from the application's own template + balance rule.
  const { getAccountTemplate } = require(path.join(root, 'dist/domains/accounting/domain/account-templates/ifrs-sme.template.js'));
  const { deriveNormalBalance } = require(path.join(root, 'dist/domains/accounting/domain/gl-account-type.js'));
  const templateKey = require(path.join(root, 'dist/domains/accounting/domain/account-templates/ifrs-sme.template.js')).ACCOUNT_TEMPLATES[0].key;
  const template = getAccountTemplate(templateKey);
  const ids = new Map();
  for (const a of template.accounts) {
    const isContra = a.isContra ?? false;
    const cf = a.controlFunction ?? null;
    const res = await db.query(
      `INSERT INTO accounting_gl_accounts ("code","name","nameAr","accountType","normalBalance","isContra","parentAccountId","isPostable","controlFunction","currencyMode","allowManualJournal","isActive")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'functional_only',$10,true) RETURNING id`,
      [a.code, a.nameEn, a.nameAr, a.accountType, deriveNormalBalance(a.accountType, isContra), isContra, a.parentCode ? ids.get(a.parentCode) ?? null : null, a.isPostable ?? true, cf, cf === null],
    );
    ids.set(a.code, res.rows[0].id);
  }
  console.log(`imported chart of accounts "${templateKey}": ${template.accounts.length} accounts`);

  // 6. period, account-mapping and base-row fixtures
  await db.query(`UPDATE treasury_accounts SET "glAccountCode" = '1101' WHERE code = 'MAIN-CASH'`);
  await db.query(
    `INSERT INTO accounting_gl_accounts ("code","name","nameAr","accountType","normalBalance","isContra","parentAccountId","isPostable","controlFunction","currencyMode","allowManualJournal","isActive")
     VALUES ('2115','Goods Received Not Invoiced','بضاعة مستلمة لم تُفوتر','liability','credit',false,$1,true,'grni','functional_only',false,true)`,
    [ids.get('21') ?? null],
  );
  await db.query(`INSERT INTO warehouses ("code","name","status","kind") VALUES ('WH-MAIN','Main Warehouse','active','main')`);
  await db.query(`INSERT INTO products ("sku","name","unitPrice","status") VALUES ('FIX-PROD-1','Fixture Product',10,'active')`);
  await db.query(`INSERT INTO suppliers ("code","legalName","status") VALUES ('SUP-FIX-1','Fixture Supplier','active')`);
  console.log('seeded grni control account, GL-mapped treasury account, warehouse/product/supplier');
  await db.end();

  // 7. the current fiscal year — created through the application's own service so its process instances
  //    (year + 12 periods) exist, exactly as a user would create it. Boots the app once against this database.
  Object.assign(process.env, env);
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(root, 'dist/app.module.js'));
  const { FiscalPeriodService } = require(path.join(root, 'dist/domains/accounting/application/fiscal-period.service.js'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const year = new Date().getUTCFullYear();
    const fiscal = app.get(FiscalPeriodService, { strict: false });
    const fy = await fiscal.createFiscalYear({ code: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` }, FIXTURE_USERS[0].id);
    await fiscal.activateFiscalYear(fy.id, FIXTURE_USERS[0].id);
    console.log(`created and activated fiscal year FY${year} (12 open periods)`);
  } finally {
    await app.close();
  }
  console.log(`READY: DB_HOST=${cfg.host} DB_PORT=${cfg.port} DB_USER=${cfg.user} DB_NAME=${cfg.db}`);
  return;
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
