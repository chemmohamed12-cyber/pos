#!/usr/bin/env node
/**
 * Company migration catch-up (incident tool, 2026-10-17).
 *
 * WHY: a release deployed with RELEASE_COMPANY_MIGRATIONS=off migrates only the PLATFORM database. When the release adds columns/tables to Company-owned
 * tables (1.1.10: customers, products, suppliers + 4 new tables) the new code fails (HTTP 500) on every Company database that was not migrated.
 * The deploy cannot simply be repeated (the engine refuses to re-deploy a version that is already live), so this tool runs the SAME, approved
 * CompanyFanoutService of the INSTALLED build (plan -> restore point -> migrate -> verify), outside a deploy. Nothing is re-implemented here.
 *
 * It is read-only unless `--apply` is given. Applying:
 *   - only touches Companies whose status is READY and that have pending migrations (each: READY -> MIGRATING -> READY, forward-only);
 *   - takes (policy `create`, the default) or requires (policy `require-recent`) a VERIFIED restore point per Company BEFORE any migration, and
 *     refuses to start if any Company lacks one;
 *   - stops at the first failure and leaves later Companies untouched; a Company left MIGRATING is reported, never forced;
 *   - never drops, resets or rolls back anything. Migrations are recorded exactly once (TypeORM migration table); re-running is a no-op.
 *
 * Run it on the host from the application root of the ACTIVE release, with the SAME environment the application runs with (DB_*, DATABASE_CREDENTIAL_ENCRYPTION_KEY,
 * the release/backup paths, PG_DUMP_BIN ...). Credentials are read from that environment and never printed.
 *
 *   node tools/maintenance/company-migration-catchup.js --app-root <ACTIVE root> [--apply --actor-email <platform admin e-mail> --release-id <uuid of the deployed release>]
 *
 * --release-id is only the audit reference (resourceId); use the id of the release row (e.g. 1.1.10) shown by the Release Center / `release.releases`.
 * Output: one JSON document (plan before, outcomes, verification, plan after).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const die = (m) => {
  console.error('REFUSED: ' + m);
  process.exit(3);
};

const APP_ROOT = path.resolve(opt('--app-root') || process.cwd());
const APPLY = flag('--apply');
if (!fs.existsSync(path.join(APP_ROOT, 'dist', 'main.js'))) die(`no installed build at ${APP_ROOT} (dist/main.js missing); pass --app-root <ACTIVE root>`);
if (APPLY && (!opt('--actor-email') || !opt('--release-id'))) die('--apply needs --actor-email <platform admin> and --release-id <uuid>');

const nm = (p) => require(path.join(APP_ROOT, 'node_modules', p));
const R = (p) => require(path.join(APP_ROOT, 'dist', p));
const out = (o) => console.log(JSON.stringify(o, null, 2));

(async () => {
  const core = nm('@nestjs/core');
  const { DataSource } = nm('typeorm');
  const confApp = await core.NestFactory.createApplicationContext(R('foundation/configuration/configuration.module').ConfigurationModule, { logger: ['error'] });
  const config = confApp.get(R('foundation/configuration/app-config.service').AppConfigService);
  const db = config.database;
  const ds = new DataSource({ type: 'postgres', host: db.host, port: db.port, username: db.username, password: db.password, database: db.database, entities: [path.join(APP_ROOT, 'dist', '**', '*.entity.js')], synchronize: false, logging: false });
  await ds.initialize();
  try {
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
    const fanout = new (rel('company-fanout.service').CompanyFanoutService)(config, dbRegistry, companies, backupMgr, ds, audit);
    const { summarizePlan, summarizeResult } = rel('company-fanout.service');

    const platform = await ds.query('SELECT count(*)::int n, max(timestamp)::text head FROM migrations');
    const before = await fanout.plan(APP_ROOT);
    const report = {
      mode: APPLY ? 'apply' : 'plan (read-only)',
      installedBuild: JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version,
      platformDatabase: { name: db.database, migrationsRecorded: platform[0].n, head: platform[0].head },
      before: summarizePlan(before),
    };
    if (!APPLY) {
      report.note = 'Nothing was changed. Companies with pendingCount > 0 are on the OLD schema under the NEW code.';
      return out(report);
    }
    if (before.blockers.length > 0) {
      report.refused = 'plan has blockers; nothing was changed';
      return out(report);
    }
    const actorRow = await ds.query('SELECT id FROM users WHERE email = $1', [opt('--actor-email')]);
    if (actorRow.length !== 1) die(`actor ${opt('--actor-email')} not found`);
    const actor = actorRow[0].id;
    if (!before.planned.some((c) => c.pending.length > 0)) {
      report.note = 'No Company has pending migrations; nothing to do.';
      return out(report);
    }
    const backups = await fanout.ensureBackups(before, actor); // throws before ANY migration if a Company has no verified restore point
    report.restorePoints = backups;
    const result = await fanout.migrate(before, APP_ROOT, actor, opt('--release-id'), backups);
    report.result = summarizeResult(result);
    report.verification = await fanout.verify(before, APP_ROOT); // companies still pending after the run (must be empty)
    report.after = summarizePlan(await fanout.plan(APP_ROOT));
    out(report);
    if (!result.ok) process.exitCode = 2;
  } finally {
    await ds.destroy().catch(() => undefined);
    await confApp.close().catch(() => undefined);
  }
})().catch((e) => {
  console.error('ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});
