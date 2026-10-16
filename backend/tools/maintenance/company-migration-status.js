#!/usr/bin/env node
/**
 * Company migration status (owner tool, 2026-10-17). Stage A of the repair: STRICTLY READ-ONLY.
 *
 * For the platform database and EVERY Company database in the registry it reports: Company name/id, lifecycle status, registry status, database name, how many
 * migrations are recorded, and exactly which shipped migrations are missing (per tag the Company already has, as the engine's fan-out would plan them) and which
 * recorded migrations the installed build does not know. Company connections are opened with `default_transaction_read_only = on` (PostgreSQL refuses any write); the platform database is only ever queried with SELECT.
 * Nothing is created, updated or deleted; no backup is taken; no audit record is written. Credentials are never printed (output is redacted); only database NAMES appear.
 *
 * Run it from the application root of the ACTIVE release, with the SAME environment the application runs with. Node.js >= 20.
 *
 *   node company-migration-status.js --app-root <ACTIVE root> [--json]
 *
 * Exit codes: 0 every Company database is complete | 5 at least one Company database has pending migrations (or could not be read) | 3 refused | 1 error.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
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
const APP_ROOT = path.resolve(opt('--app-root') || process.cwd());
if (!fs.existsSync(path.join(APP_ROOT, 'dist', 'main.js')) || !fs.existsSync(path.join(APP_ROOT, 'node_modules'))) {
  console.error(`REFUSED: ${APP_ROOT} is not an installed release root (dist/main.js or node_modules missing); pass --app-root <ACTIVE root>`);
  process.exit(3);
}
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`REFUSED: Node.js ${process.versions.node} is too old; the application requires >= 20`);
  process.exit(3);
}
const nm = (p) => require(path.join(APP_ROOT, 'node_modules', p));
const R = (p) => require(path.join(APP_ROOT, 'dist', p));

async function readMigrations(cfg) {
  const { Client } = nm('pg');
  const c = new Client({ host: cfg.host, port: cfg.port, user: cfg.username, password: cfg.password, database: cfg.database, connectionTimeoutMillis: 15000 });
  await c.connect();
  try {
    await c.query('SET default_transaction_read_only = on');
    const rows = (await c.query('SELECT name, timestamp::text AS ts FROM migrations')).rows;
    return rows.map((r) => String(r.name));
  } finally {
    await c.end().catch(() => undefined);
  }
}

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
    const { DatabaseRegistry } = R('foundation/database-registry/database-registry.entity');
    const { DatabaseCredential } = R('foundation/database-registry/database-credential.entity');
    const { DatabaseRegistryService } = R('foundation/database-registry/database-registry.service');
    const { DatabaseCredentialCipherService } = R('foundation/database-registry/database-credential-cipher.service');
    const registry = new DatabaseRegistryService(ds.getRepository(DatabaseRegistry), ds.getRepository(DatabaseCredential), new DatabaseCredentialCipherService(config));
    const fan = R('foundation/release/company-fanout.service');
    const { discoverMigrationTags } = R('foundation/release/migration-datasource');
    const tags = discoverMigrationTags(APP_ROOT);
    const byTag = fan.migrationNamesByTag(APP_ROOT, tags);
    const shipped = new Set();
    for (const s of byTag.values()) for (const n of s) shipped.add(n);

    const installedVersion = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
    const platformNames = await (async () => {
      const rows = await ds.query('SELECT name FROM migrations');
      return rows.map((r) => String(r.name));
    })();
    const platformSet = new Set(platformNames);
    const report = {
      installedBuild: installedVersion,
      shippedMigrations: shipped.size,
      platformDatabase: { name: db.database, migrationsRecorded: platformNames.length, missing: [...shipped].filter((n) => !platformSet.has(n)).sort() },
      companies: [],
    };

    const regs = await ds.query(
      `SELECT r.id AS "registryId", r."companyId", r."databaseName", r.status AS "registryStatus", c.name, c.status AS "companyStatus"
         FROM database_registries r LEFT JOIN companies c ON c.id = r."companyId" ORDER BY c.name NULLS LAST, r."databaseName"`,
    );
    for (const r of regs) {
      const row = { company: r.name, companyId: r.companyId, companyStatus: r.companyStatus, registryStatus: r.registryStatus, database: r.databaseName };
      try {
        const cfg = await registry.getConnectionConfigForCompany(r.companyId);
        const names = await readMigrations(cfg);
        const set = new Set(names);
        const tagsHad = fan.tagsReceivedByCompany(byTag, set);
        const expected = new Set();
        for (const t of tagsHad) for (const n of byTag.get(t) ?? []) expected.add(n);
        row.migrationsRecorded = names.length;
        row.tags = tagsHad;
        row.missing = [...expected].filter((n) => !set.has(n)).sort();
        row.unknownToThisBuild = names.filter((n) => !shipped.has(n)).sort();
        row.verdict = row.missing.length === 0 ? 'COMPLETE' : `INCOMPLETE (${row.missing.length} missing)`;
      } catch (e) {
        row.verdict = 'UNREADABLE';
        row.error = redact(e instanceof Error ? e.message : String(e));
      }
      report.companies.push(row);
    }
    report.summary = {
      companyDatabases: report.companies.length,
      complete: report.companies.filter((c) => c.verdict === 'COMPLETE').length,
      incomplete: report.companies.filter((c) => /^INCOMPLETE/.test(c.verdict)).length,
      unreadable: report.companies.filter((c) => c.verdict === 'UNREADABLE').length,
      platformComplete: report.platformDatabase.missing.length === 0,
    };
    const bad = report.summary.incomplete + report.summary.unreadable > 0 || !report.summary.platformComplete;
    if (args.includes('--json')) console.log(redact(JSON.stringify(report, null, 2)));
    else {
      console.log(`Installed build ${installedVersion}; this build ships ${shipped.size} migrations.`);
      console.log(`PLATFORM  ${db.database}: ${platformNames.length} recorded, ${report.platformDatabase.missing.length} missing`);
      for (const c of report.companies) {
        console.log(`COMPANY   ${c.company ?? '(no company)'} [${c.companyStatus}/${c.registryStatus}] db=${c.database}: ${c.verdict}` + (c.migrationsRecorded !== undefined ? `, ${c.migrationsRecorded} recorded` : ''));
        for (const m of c.missing ?? []) console.log(`            missing: ${m}`);
        if (c.error) console.log(`            error: ${c.error}`);
      }
      console.log(redact(JSON.stringify(report.summary)));
    }
    process.exitCode = bad ? 5 : 0;
  } finally {
    await ds.destroy().catch(() => undefined);
    await confApp.close().catch(() => undefined);
  }
})().catch((e) => {
  console.error(redact('ERROR: ' + (e && e.stack ? e.stack : e)));
  process.exit(1);
});
