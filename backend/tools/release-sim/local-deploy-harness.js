#!/usr/bin/env node
/**
 * Local production-path deployment simulation (CTO 2026-10-08).
 *
 * Hosts the REAL Release Engine services of the INSTALLED build (the tree in the ACTIVE slot — exactly as production, where the installed build deploys the next
 * one) and drives the official sequence against a named database:
 *     backup  ->  upload  ->  link  ->  deploy      (Verified Backup Gate, preflight, candidate, integrity, migrations, atomic swap, restart trigger, health, LKG)
 * It does NOT start the application (no HTTP, no schedulers): the application's background sweeps would touch Company databases, which a deployment simulation
 * has no business doing. The HTTP layer (controller + auth) is the only part not exercised; every engine service behind it is the real one.
 *
 * Windows adaptation (not an engine change): a process cannot rename a directory that is its current working directory, so this harness runs from <SIM_ROOT>/host
 * (whose package.json mirrors the INSTALLED version, because the engine reads `process.cwd()/package.json` as "the installed version"), never from inside ACTIVE.
 *
 * SAFETY: refuses to run unless SIM_TARGET_DB names the database in the env file — an explicit acknowledgement of exactly which database this will upgrade.
 *
 *   env: SIM_ROOT (default D:/DAII-LOCAL-DEPLOY) · SIM_ENV_FILE (the .env holding DB_*; never printed) · SIM_TARGET_DB (must equal DB_NAME) · SIM_ACTOR_EMAIL
 *   usage: node local-deploy-harness.js info | backup | upload <zip> | link <releaseId> <backupRunId> | gate <releaseId> | deploy <releaseId> | events <releaseId>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SIM_ROOT = path.resolve(process.env.SIM_ROOT || 'D:/DAII-LOCAL-DEPLOY');
const DEPLOY_ROOT = path.join(SIM_ROOT, 'deploy');
const ACTIVE_DIRNAME = 'app';
const ENGINE = path.join(DEPLOY_ROOT, ACTIVE_DIRNAME);
const HOST = path.join(SIM_ROOT, 'host');
const STORAGE = path.join(SIM_ROOT, 'storage');
const ENV_FILE = process.env.SIM_ENV_FILE;
const out = (o) => console.log(JSON.stringify(o, null, 2));
const die = (m) => {
  console.error('HARNESS REFUSED: ' + m);
  process.exit(3);
};

if (!fs.existsSync(path.join(ENGINE, 'dist', 'main.js'))) die(`no installed build at ${ENGINE}`);
if (!ENV_FILE || !fs.existsSync(ENV_FILE)) die('SIM_ENV_FILE must point to the .env holding DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME');
const nm = (p) => require(path.join(ENGINE, 'node_modules', p));
const R = (p) => require(path.join(ENGINE, 'dist', p));

// ---- environment: DB_* and the credential/JWT material come from the env file (values are never printed); everything release-related is set here ----
const parsed = nm('dotenv').parse(fs.readFileSync(ENV_FILE));
for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v;
if (!process.env.SIM_TARGET_DB || process.env.SIM_TARGET_DB !== process.env.DB_NAME) die(`SIM_TARGET_DB must equal DB_NAME (${process.env.DB_NAME}) — name the database you intend to upgrade`);
Object.assign(process.env, {
  NODE_ENV: 'development',
  RELEASE_APP_ROOT: ENGINE,
  RELEASE_DEPLOY_ROOT: DEPLOY_ROOT,
  RELEASE_ACTIVE_DIRNAME: ACTIVE_DIRNAME,
  RELEASE_STAGING_PATH: path.join(STORAGE, 'release-staging'),
  RELEASE_MANIFESTS_PATH: path.join(STORAGE, 'release-manifests'),
  RELEASE_BACKUP_STORAGE_PATH: path.join(STORAGE, 'backups'),
  FRONTEND_RUNTIME_PATH: path.join(ENGINE, 'public'),
  PASSENGER_RESTART_FILE: path.join(ENGINE, 'tmp', 'restart.txt'),
  RELEASE_STAGED_ACTIVATION: 'true',
  PG_DUMP_BIN: process.env.PG_DUMP_BIN || 'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe',
  PG_RESTORE_BIN: process.env.PG_RESTORE_BIN || 'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_restore.exe',
  NODE_BIN: process.execPath,
  NPM_BIN: process.env.NPM_BIN || 'C:\\Program Files\\nodejs\\npm.cmd',
  ENTITLEMENT_MODE: 'unlicensed-full',
});
for (const d of [HOST, STORAGE, path.join(ENGINE, 'tmp')]) fs.mkdirSync(d, { recursive: true });
// the engine reads `process.cwd()/package.json` as the INSTALLED version: mirror the installed build's, and run from outside ACTIVE (a cwd cannot be renamed on Windows)
fs.copyFileSync(path.join(ENGINE, 'package.json'), path.join(HOST, 'package.json'));
process.chdir(HOST);

(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  const core = nm('@nestjs/core');
  const { DataSource } = nm('typeorm');
  const confApp = await core.NestFactory.createApplicationContext(R('foundation/configuration/configuration.module').ConfigurationModule, { logger: ['error'] });
  const config = confApp.get(R('foundation/configuration/app-config.service').AppConfigService);
  const db = config.database;
  const ds = new DataSource({ type: 'postgres', host: db.host, port: db.port, username: db.username, password: db.password, database: db.database, entities: [path.join(ENGINE, 'dist', '**', '*.entity.js')], synchronize: false, logging: false });
  await ds.initialize();
  try {
    const actorEmail = process.env.SIM_ACTOR_EMAIL || 'admin@daii.example';
    const actorRow = await ds.query('SELECT id FROM users WHERE email = $1', [actorEmail]);
    if (actorRow.length !== 1) die(`actor ${actorEmail} not found in ${db.database}`);
    const actor = actorRow[0].id;

    // ---- the real services, wired exactly as ReleaseModule does (minus controllers and background schedulers) ----
    const rel = (p) => R(`foundation/release/${p}`);
    const { AuditService } = R('foundation/audit/audit.service');
    const audit = new AuditService(ds);
    const { Company } = R('foundation/company/company.entity');
    const { CompanyService } = R('foundation/company/company.service');
    const { DatabaseRegistry } = R('foundation/database-registry/database-registry.entity');
    const { DatabaseCredential } = R('foundation/database-registry/database-credential.entity');
    const { DatabaseRegistryService } = R('foundation/database-registry/database-registry.service');
    const { DatabaseCredentialCipherService } = R('foundation/database-registry/database-credential-cipher.service');
    const dbRegistry = new DatabaseRegistryService(ds.getRepository(DatabaseRegistry), ds.getRepository(DatabaseCredential), new DatabaseCredentialCipherService(config));
    const companies = new CompanyService(ds.getRepository(Company));
    const pgDump = new (rel('pg-dump-runner.service').PgDumpRunnerService)(config);
    const backupOps = new (rel('backup-operation.service').BackupOperationService)(ds.getRepository(rel('backup-operation.entity').BackupOperation));
    const backupMgr = new (rel('backup-manager.service').BackupManagerService)(ds, config, pgDump, audit, dbRegistry, backupOps, companies);
    const restoreMgr = new (rel('restore-manager.service').RestoreManagerService)(ds, config, pgDump, backupMgr, audit, dbRegistry);
    const releaseMgr = new (rel('release-manager.service').ReleaseManagerService)(ds, audit);
    const staged = new (rel('staged-activation.service').StagedActivationService)(config);
    let fanout;
    try {
      fanout = new (rel('company-fanout.service').CompanyFanoutService)(config, dbRegistry, companies, backupMgr, ds, audit); // present only in builds that have the capability
    } catch {
      fanout = undefined;
    }
    const exec = new (rel('release-execution.service').ReleaseExecutionService)(
      ds, config, new (rel('package-validator.service').PackageValidatorService)(), releaseMgr, new (rel('release-health-check.service').ReleaseHealthCheckService)(ds, config), restoreMgr,
      new (rel('deploy-preflight.service').DeployPreflightService)(ds, config), staged, new (rel('lkg-registry.service').LkgRegistryService)(config), audit, undefined, fanout,
    );

    const events = async (id) => ds.query(`SELECT seq, action, result, left(coalesce(after::text,''), 400) AS after FROM audit_records WHERE "resourceId" = $1 ORDER BY seq`, [id]);

    if (cmd === 'info') {
      const head = await ds.query('SELECT count(*)::int n, max(name) FILTER (WHERE timestamp = (SELECT max(timestamp) FROM migrations)) head FROM migrations');
      out({ target: db.database, port: db.port, installedBuild: JSON.parse(fs.readFileSync(path.join(ENGINE, 'package.json'), 'utf8')).version, engineHasCompanyFanout: !!fanout, companyMigrationsMode: config.releaseDeploy.companyMigrations ?? 'n/a (engine predates the capability)', migrations: head[0], actor });
    } else if (cmd === 'backup') {
      const run = await backupMgr.createBackup('pre_update', actor);
      const arts = await ds.query('SELECT type, status, "sizeBytes"::text, "filePath", "checksumSha256" FROM backup_artifacts WHERE "backupRunId" = $1', [run.id]);
      out({ backupRunId: run.id, status: run.status, artifacts: arts });
    } else if (cmd === 'upload') {
      const r = await exec.uploadPackage(path.resolve(a1), 'full', actor);
      out({ releaseId: r.id, version: r.version, status: r.status, errorMessage: r.errorMessage });
    } else if (cmd === 'link') {
      const r = await releaseMgr.linkVerifiedBackup(a1, a2, actor);
      out({ releaseId: r.id, status: r.status, backupRunId: r.backupRunId });
    } else if (cmd === 'gate') {
      out(await releaseMgr.checkDeploymentGate(a1));
    } else if (cmd === 'deploy') {
      const r = await exec.deployRelease(a1, actor);
      out({ releaseId: r.id, version: r.version, status: r.status, errorMessage: r.errorMessage, events: await events(a1) });
    } else if (cmd === 'events') {
      out(await events(a1));
    } else {
      die('unknown command. usage: info | backup | upload <zip> | link <releaseId> <backupRunId> | gate <releaseId> | deploy <releaseId> | events <releaseId>');
    }
  } finally {
    await ds.destroy().catch(() => undefined);
    await confApp.close().catch(() => undefined);
  }
})().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});
