#!/usr/bin/env node
/**
 * Company migration catch-up (owner tool, 2026-10-17). Stage B of the repair; Stage A is company-migration-status.js (read-only).
 *
 * WHY: a release deployed with RELEASE_COMPANY_MIGRATIONS=off migrates only the PLATFORM database. When the release adds columns/tables to Company-owned
 * tables (1.1.10: customers, products, suppliers + 4 new tables) the new code answers HTTP 500 on every Company database that was not migrated.
 * The deploy cannot simply be repeated (the engine refuses to re-deploy a version that is already live), so this tool runs the SAME, approved
 * CompanyFanoutService of the INSTALLED build (plan -> restore point -> migrate -> verify). It contains NO SQL that changes data and re-implements nothing.
 *
 * Without --apply it is read-only (plan). With --apply it first runs a PREFLIGHT and changes nothing unless every check passes:
 *   P1 active release root   : dist/main.js + node_modules present; package.json version = <installed version>
 *   P2 release identity      : --release-id is a UUID, the row exists in `releases`, status = succeeded, version = the installed version
 *   P3 live release          : the engine's last-known-good record names the same release (the build that is live); --skip-lkg-check only if the record is absent
 *   P4 actor identity        : --actor-email is an existing, active user
 *   P5 Company DB identity   : --confirm-databases lists EXACTLY the Company databases that have pending migrations (copy it from Stage A)
 *   P6 restore points        : --i-confirm-restore-points (the owner has reviewed that a usable restore point is available for every affected Company);
 *                              then the engine itself takes (policy `create`, default) or requires (`require-recent`) a VERIFIED backup per Company BEFORE any
 *                              migration and refuses to start otherwise.
 * Stage B1 (--restore-points-only, same identity arguments, needs RELEASE_COMPANY_BACKUP_POLICY=create): runs the same preflight, takes and verifies the restore points,
 * prints their file paths, sizes and SHA-256, and STOPS. It migrates nothing and does not change any Company status. Stage B2 (--apply) can then use them with
 * RELEASE_COMPANY_BACKUP_POLICY=require-recent.
 * Then, per Company (READY only), sequentially: READY -> MIGRATING -> migrate -> READY. The first failure STOPS the run: later Companies are "not attempted"
 * and untouched; the tool exits 2 and prints STATUS: FAILED. Nothing is ever dropped, reset or rolled back. Each migration is recorded exactly once by TypeORM;
 * a second run finds nothing pending and does nothing.
 *
 * Run it from the application root of the ACTIVE release with the SAME environment the application runs with (DB_*, DATABASE_CREDENTIAL_ENCRYPTION_KEY, release/backup
 * paths, PG_DUMP_BIN ...). Node.js >= 20 (engines of the application). Credentials are read from that environment and never printed (output is redacted).
 *
 *   node company-migration-catchup.js --app-root <ACTIVE root>
 *   node company-migration-catchup.js --app-root <ACTIVE root> --apply --actor-email <admin e-mail> --release-id <uuid> \
 *        --confirm-databases <db1,db2,...> --i-confirm-restore-points
 *
 * Schema (CTO 2026-10-21): when the installed build carries the shared schema check, the plan also lists each Company's schema findings, and after the migration step the
 * Companies are RE-CHECKED against the new code's entity registry: a Company that is migrated but still does not match is FAILED, never SUCCESS. A Company with nothing
 * pending but a schema that differs is reported as SCHEMA_DRIFT (no migration can repair it; nothing is changed; exit 2) instead of NOTHING_TO_DO.
 *
 * Exit codes: 0 success or nothing to do | 2 migration failed / verification failed (STATUS: FAILED) | 3 refused before any change | 4 finished but some Companies were skipped
 * (not READY) and still need attention (STATUS: PARTIAL) | 1 unexpected error.
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
let SECRETS = [];
const redact = (s) => {
  let t = String(s);
  for (const x of SECRETS) if (x && String(x).length >= 4) t = t.split(String(x)).join('***');
  return t.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, '$1***@').replace(/(password\s*[=:]\s*)\S+/gi, '$1***');
};
const out = (o) => console.log(redact(JSON.stringify(o, null, 2)));
const refuse = (m, extra) => {
  console.error(redact('REFUSED (nothing was changed): ' + m));
  if (extra) out(extra);
  process.exit(3);
};

const APP_ROOT = path.resolve(opt('--app-root') || process.cwd());
const APPLY = flag('--apply');
const RP_ONLY = flag('--restore-points-only'); // Stage B1: take and verify the restore points, then STOP (no migration, no Company status change)
if (!fs.existsSync(path.join(APP_ROOT, 'dist', 'main.js')) || !fs.existsSync(path.join(APP_ROOT, 'node_modules'))) refuse(`${APP_ROOT} is not an installed release root (dist/main.js or node_modules missing); pass --app-root <ACTIVE root>`);
if (Number(process.versions.node.split('.')[0]) < 20) refuse(`Node.js ${process.versions.node} is too old; the application requires >= 20`);
if (APPLY && RP_ONLY) refuse('--apply and --restore-points-only are different stages; use one of them');
if (APPLY || RP_ONLY) {
  const what = APPLY ? '--apply' : '--restore-points-only';
  for (const n of ['--actor-email', '--release-id', '--confirm-databases']) if (opt(n) === undefined) refuse(`${what} needs ${n}`);
  if (APPLY && !flag('--i-confirm-restore-points')) refuse('--apply needs --i-confirm-restore-points (the owner confirms a usable restore point exists for every affected Company database)');
}

const nm = (p) => require(path.join(APP_ROOT, 'node_modules', p));
const R = (p) => require(path.join(APP_ROOT, 'dist', p));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

(async () => {
  const core = nm('@nestjs/core');
  const { DataSource } = nm('typeorm');
  const confApp = await core.NestFactory.createApplicationContext(R('foundation/configuration/configuration.module').ConfigurationModule, { logger: ['error'] });
  const config = confApp.get(R('foundation/configuration/app-config.service').AppConfigService);
  const db = config.database;
  SECRETS = [db.password, config.databaseCredentialEncryptionKey];
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

    const installedVersion = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
    const platform = await ds.query('SELECT count(*)::int n, max(timestamp)::text head FROM migrations');
    const before = await fanout.plan(APP_ROOT);
    const withPending = before.planned.filter((c) => c.pending.length > 0);
    const report = {
      mode: APPLY ? 'apply' : RP_ONLY ? 'restore points only (no migration)' : 'plan (read-only)',
      installedBuild: installedVersion,
      platformDatabase: { name: db.database, migrationsRecorded: platform[0].n, head: platform[0].head },
      before: summarizePlan(before),
      companyDatabasesWithPending: withPending.map((c) => c.databaseName).sort(),
    };
    if (!APPLY && !RP_ONLY) {
      report.note = 'Nothing was changed. Companies with pendingCount > 0 are on the OLD schema under the NEW code. To repair, review this plan, then run with --apply (see the header).';
      return out(report);
    }

    const hasSchemaFindings = (c) => !!c.schema && c.schema.ran && (c.schema.findings.missingTables.length > 0 || Object.keys(c.schema.findings.missingColumns).length > 0);
    const driftNoPending = before.planned.filter((c) => c.pending.length === 0 && hasSchemaFindings(c));
    if (withPending.length === 0 && before.blockers.length === 0 && driftNoPending.length > 0) {
      report.status = 'SCHEMA_DRIFT';
      report.schemaDriftCompanies = driftNoPending.map((c) => c.databaseName).sort();
      report.note = 'No Company has pending migrations, but the listed Companies do not match the schema the installed build queries. No migration can repair that; NOTHING was changed. Investigate (see before.companies[].schemaCheck) before any manual action.';
      out(report);
      console.log('STATUS: SCHEMA_DRIFT');
      process.exitCode = 2;
      return;
    }
    if (withPending.length === 0 && before.blockers.length === 0) {
      report.status = 'NOTHING_TO_DO';
      report.note = 'No Company database has pending migrations; nothing was changed.';
      out(report);
      console.log('STATUS: NOTHING_TO_DO');
      return;
    }

    // ---------------- PREFLIGHT (read-only) ----------------
    const checks = [];
    const check = (name, ok, detail) => checks.push({ check: name, result: ok ? 'PASS' : 'FAIL', detail });
    check('P1 active release root', true, `${APP_ROOT} runs version ${installedVersion}`);
    const releaseId = opt('--release-id');
    let releaseRow = null;
    if (UUID.test(releaseId)) {
      const { Release } = rel('release.entity');
      releaseRow = await ds.getRepository(Release).findOne({ where: { id: releaseId } });
    }
    check('P2 release identity', !!releaseRow && releaseRow.status === 'succeeded' && releaseRow.version === installedVersion,
      releaseRow ? `release ${releaseId}: version ${releaseRow.version}, status ${releaseRow.status}; installed ${installedVersion}` : `no release row for "${releaseId}" (must be a UUID of a row in releases)`);
    let lkg = null;
    try {
      lkg = await new (rel('lkg-registry.service').LkgRegistryService)(config).read();
    } catch {
      lkg = null;
    }
    if (lkg) check('P3 live release', lkg.current && lkg.current.release_id === releaseId, `last-known-good names release ${lkg.current && lkg.current.release_id} (${lkg.current && lkg.current.version})`);
    else check('P3 live release', flag('--skip-lkg-check'), 'last-known-good record not readable' + (flag('--skip-lkg-check') ? ' (skipped by --skip-lkg-check)' : '; pass --skip-lkg-check only if you know why'));
    const actorRow = await ds.query('SELECT id, status FROM users WHERE email = $1', [opt('--actor-email')]);
    check('P4 actor identity', actorRow.length === 1 && actorRow[0].status === 'active', actorRow.length === 1 ? `user found, status ${actorRow[0].status}` : 'no unique user with that e-mail');
    const confirmed = [...new Set(String(opt('--confirm-databases')).split(',').map((s) => s.trim()).filter(Boolean))].sort();
    const expected = [...new Set(withPending.map((c) => c.databaseName))].sort();
    check('P5 Company database identity', JSON.stringify(confirmed) === JSON.stringify(expected), `confirmed [${confirmed.join(', ')}] vs plan [${expected.join(', ')}]`);
    check('P6 restore points', RP_ONLY || flag('--i-confirm-restore-points'), RP_ONLY ? 'this run takes them' : 'owner flag present; the engine verifies a backup per Company before any migration');
    if (RP_ONLY) check('P6b backup policy is create', config.releaseDeploy.companyBackupPolicy === 'create', `RELEASE_COMPANY_BACKUP_POLICY=${config.releaseDeploy.companyBackupPolicy} (must be create for this stage)`);
    check('P7 plan has no blockers', before.blockers.length === 0, before.blockers.length === 0 ? 'none' : before.blockers.join(' | '));
    check('P8 something to do', withPending.length > 0, `${withPending.length} Company database(s) with pending migrations`);
    report.preflight = checks;
    if (checks.some((c) => c.result === 'FAIL')) {
      report.status = 'REFUSED';
      out(report);
      console.error('REFUSED (nothing was changed): a preflight check failed.');
      process.exit(3);
    }

    // ---------------- APPLY ----------------
    const actor = actorRow[0].id;
    let backups;
    try {
      backups = await fanout.ensureBackups(before, actor); // throws before ANY migration if a Company has no verified restore point
    } catch (e) {
      if (e && e.name === 'CompanyFanoutBlockedError') {
        report.status = 'REFUSED';
        report.refusedBecause = redact(e.message);
        out(report);
        console.error('REFUSED (no migration was run, no Company status was changed): a restore point is missing or could not be verified.');
        process.exit(3);
      }
      throw e;
    }
    report.restorePoints = backups;
    if (RP_ONLY) {
      const ids = backups.map((x) => x.backupRunId);
      const rows = await ds.query(
        `SELECT c.name AS company, r.id AS "backupRunId", r."completedAt", a.type, a.status, a."sizeBytes"::text AS "sizeBytes", a."checksumSha256", a."verifiedAt", a."filePath"
           FROM backup_runs r JOIN backup_artifacts a ON a."backupRunId" = r.id LEFT JOIN companies c ON c.id = r."companyId" WHERE r.id = ANY($1) ORDER BY c.name, a.type`,
        [ids],
      );
      const root = path.resolve(APP_ROOT, config.releaseBackup.storagePath);
      report.restorePointDetails = rows.map((r) => ({ company: r.company, backupRunId: r.backupRunId, artifact: r.type, status: r.status, sizeBytes: r.sizeBytes, sha256: r.checksumSha256, verifiedAt: r.verifiedAt, file: path.join(root, r.filePath) }));
      report.verificationMeans = 'pg_dump custom format; file non-empty; PGDMP magic; pg_restore --list parses it; size and SHA-256 recorded and re-checked. This is a structural check, NOT a test restore.';
      report.next = 'Check the files yourself (pg_restore --list <file>), then run Stage B with RELEASE_COMPANY_BACKUP_POLICY=require-recent so it uses exactly these restore points (valid for RELEASE_COMPANY_BACKUP_MAX_AGE_HOURS, default 24).';
      const ok = rows.length >= backups.length && rows.every((r) => r.status === 'verified');
      report.status = ok ? 'RESTORE_POINTS_READY' : 'FAILED';
      out(report);
      console.log(`STATUS: ${report.status}`);
      process.exitCode = ok ? 0 : 2;
      return;
    }
    const result = await fanout.migrate(before, APP_ROOT, actor, releaseId, backups);
    report.result = summarizeResult(result);
    report.stillPendingAfterVerify = await fanout.verify(before, APP_ROOT); // must be empty
    const afterPlan = await fanout.plan(APP_ROOT);
    report.after = summarizePlan(afterPlan);
    const schemaAfterBad = typeof fanout.verifySchema === 'function' ? await fanout.verifySchema(before, APP_ROOT) : null;
    if (schemaAfterBad) {
      report.schemaAfter = Object.fromEntries(Object.entries(schemaAfterBad).map(([k, v]) => [k, { ran: v.ran, checkedTables: v.checkedTables, missingTables: v.findings.missingTables.slice(0, 20), missingColumns: v.findings.missingColumns, ...(v.error ? { error: v.error } : {}) }]));
    }
    const schemaBadAfter = schemaAfterBad ? Object.values(schemaAfterBad).some((v) => !v.ran || v.findings.missingTables.length > 0 || Object.keys(v.findings.missingColumns).length > 0) : false;
    const ids = before.planned.map((c) => c.companyId);
    report.companyStatusAfter = (await ds.query('SELECT name, status FROM companies WHERE id = ANY($1)', [ids])).map((r) => ({ company: r.name, status: r.status }));
    const failed = !result.ok || Object.keys(report.stillPendingAfterVerify).length > 0 || afterPlan.planned.some((c) => c.pending.length > 0) || report.companyStatusAfter.some((c) => c.status !== 'READY') || schemaBadAfter;
    const skipped = before.skipped.length > 0;
    report.status = failed ? 'FAILED' : skipped ? 'PARTIAL' : 'SUCCESS';
    if (failed) report.recovery = 'See the runbook section "Failed or partial run". Do not re-run blindly: run Stage A, read which Company stopped and why (result.failed[].error), fix the cause, then re-run Stage B (idempotent).';
    if (skipped && !failed) report.skippedNeedAttention = before.skipped;
    out(report);
    console.log(`STATUS: ${report.status}`);
    process.exitCode = failed ? 2 : skipped ? 4 : 0;
  } finally {
    await ds.destroy().catch(() => undefined);
    await confApp.close().catch(() => undefined);
  }
})().catch((e) => {
  console.error(redact('ERROR: ' + (e && e.stack ? e.stack : e)));
  console.log('STATUS: FAILED (unexpected error; see above)');
  process.exit(1);
});
