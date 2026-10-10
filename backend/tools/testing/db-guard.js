'use strict';
/**
 * Test-database identity guard (M-R2 §11, CTO 2026-10-10 "decision 2").
 *
 * Purpose: no test, jest run or manual verification script may open a PostgreSQL connection to a database that is
 * not on the approved list in `approved-test-databases.json`. Default = DENY. Nothing here touches a database:
 *   - `evaluate()` is a pure decision over (target, policy);
 *   - `install()` wraps `pg`'s `Client.prototype.connect` so EVERY connection (TypeORM pools, `new Client`, admin
 *     connections that create disposable databases) is checked BEFORE the socket is opened;
 *   - `preflight()` checks the effective ambient configuration (process.env, then backend/.env, then the app's own
 *     defaults) before jest starts, so a wrong `.env` fails fast with a clear message.
 *
 * Approval is a reviewed commit to `approved-test-databases.json` (the git history is the audit trail). An entry only
 * counts when it carries `approvedBy` and `approvedOn` and `identityEvidence`. This module never approves anything.
 * The hard denials below can NOT be overridden by any policy entry.
 */
const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, 'approved-test-databases.json');
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

// The application's own fallbacks (src/database/data-source.ts). Used only to compute what an unset variable WOULD resolve to.
const APP_DEFAULTS = { DB_HOST: 'localhost', DB_PORT: '5432', DB_NAME: 'daii_dev' };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
// Hard denials — never overridable by policy.
const DENIED_DATABASE_NAMES = new Set(['daii_dev', 'daii', 'daii_prod', 'daii_production']);
// production/staging look-alikes, the shared dev database in any spelling (incl. restore_*_daii_dev copies), ambient databases and restore copies
const DENIED_DATABASE_PATTERN = /(prod|production|live|staging|daii_dev|ambient|^restore_)/i;
// PostgreSQL system databases: reachable ONLY as an ADMIN connection (see below), never as a business-test target
const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1']);
const DENIED_PORTS = new Set([5433]); // the shared dev server (see foundation/testing/saas-characterization.helpers.ts)

class DbGuardError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'DbGuardError';
    this.detail = detail;
  }
}

function normaliseHost(h) {
  const v = String(h ?? '').trim().toLowerCase();
  return LOOPBACK.has(v) ? 'loopback' : v;
}

function loadPolicy(file = POLICY_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new DbGuardError(`DB guard: cannot read the approval list (${file}): ${e.message}. Refusing (default deny).`);
  }
  const approved = Array.isArray(raw.approved) ? raw.approved : [];
  return { approved: approved.filter(isCompleteApproval), incomplete: approved.filter((e) => !isCompleteApproval(e)).length, raw };
}

// a placeholder such as "<CTO name>" / "TBD" is not an approver, and approvedOn must be a real ISO date
const realApprover = (v) => typeof v === 'string' && v.trim().length > 1 && !/^<.*>$/.test(v.trim()) && !/^(tbd|todo|n\/a|none|-)$/i.test(v.trim());
const realDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

function isCompleteApproval(e) {
  return !!(e && e.host && Number.isInteger(e.port) && realApprover(e.approvedBy) && realDate(e.approvedOn) && e.identityEvidence && (Array.isArray(e.databases) || Array.isArray(e.databasePatterns) || Array.isArray(e.adminDatabases)));
}

/**
 * Pure decision. `target` = { host, port, database }. Returns { allowed, role, reason, entryId }.
 * role 'business' = a database tests may read/write (named in `databases` or matching `databasePatterns`);
 * role 'admin'    = a maintenance database listed in `adminDatabases` (e.g. postgres): the connection is allowed ONLY for the minimal
 *                   statement set in checkAdminStatement (create/drop of approved disposable databases + read-only catalog statements).
 * `opts.businessOnly` (used for the ambient DB_* configuration) refuses admin databases outright.
 */
function evaluate(target, policy, opts = {}) {
  const host = normaliseHost(target.host);
  const port = target.port === undefined || target.port === null || target.port === '' ? NaN : Number(target.port);
  const database = target.database === undefined || target.database === null ? '' : String(target.database); // NOT trimmed: the guard must judge the exact name PostgreSQL would receive

  if (!host) return deny('host is unknown or empty');
  if (host !== 'loopback') return deny(`host "${target.host}" is not a loopback address (shared/remote servers are never test targets)`);
  if (!Number.isInteger(port)) return deny('port is unknown or not a number');
  if (DENIED_PORTS.has(port)) return deny(`port ${port} is the shared development server`);
  if (!database) return deny('database name is unknown or empty');

  for (const e of policy.approved) {
    if (normaliseHost(e.host) !== host || e.port !== port) continue;
    if ((e.adminDatabases || []).some((d) => String(d).toLowerCase() === database.toLowerCase())) {
      if (opts.businessOnly) return deny(`"${database}" is an administrative database: business tests may never run against it`);
      return { allowed: true, role: 'admin', reason: 'approved (administrative connection, restricted statements)', entryId: e.id || `${e.host}:${e.port}` };
    }
  }

  if (SYSTEM_DATABASES.has(database.toLowerCase())) return deny(`"${database}" is a PostgreSQL system database: not a business-test target`);
  if (DENIED_DATABASE_NAMES.has(database.toLowerCase())) return deny(`database "${database}" is a protected shared/development database`);
  if (DENIED_DATABASE_PATTERN.test(database)) return deny(`database "${database}" is a protected database (production/staging look-alike, shared-dev copy, ambient or restore database)`);

  for (const e of policy.approved) {
    if (normaliseHost(e.host) !== host || e.port !== port) continue;
    const named = (e.databases || []).some((d) => String(d).toLowerCase() === database.toLowerCase());
    const patterned = (e.databasePatterns || []).some((p) => new RegExp(p).test(database));
    if (named || patterned) return { allowed: true, role: 'business', reason: 'approved', entryId: e.id || `${e.host}:${e.port}` };
  }
  return deny(`${host}:${port}/${database} is not on the approved test-database list (approved entries: ${policy.approved.length}, incomplete entries ignored: ${policy.incomplete || 0})`);
}

function deny(reason) {
  return { allowed: false, role: null, reason, entryId: null };
}

function parseDotenv(file = ENV_PATH) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch (_) {
    /* no .env */
  }
  return out;
}

/** The ambient identity the application would use: process.env, else backend/.env, else the application's own default. */
function effectiveAmbient(env = process.env, dotenv = parseDotenv()) {
  const pick = (k) => (env[k] !== undefined && env[k] !== '' ? env[k] : dotenv[k] !== undefined ? dotenv[k] : APP_DEFAULTS[k]);
  return { host: pick('DB_HOST'), port: pick('DB_PORT'), database: pick('DB_NAME') };
}

/** Fail-fast check of the ambient configuration. Throws DbGuardError. Opens nothing. */
function preflight(opts = {}) {
  const policy = opts.policy || loadPolicy();
  const target = effectiveAmbient(opts.env, opts.dotenv);
  const d = evaluate(target, policy, { businessOnly: true });
  if (!d.allowed) {
    throw new DbGuardError(
      `DB guard REFUSED to run: ambient database ${target.host}:${target.port}/${target.database} — ${d.reason}.\n` +
        `Nothing was connected and nothing was changed. To run tests, set DB_HOST/DB_PORT/DB_NAME (shell environment) to an approved isolated database, ` +
        `and have its identity approved in tools/testing/approved-test-databases.json (reviewed commit).`,
      { target, decision: d },
    );
  }
  return { target, decision: d };
}

/** Wrap pg's Client.connect so every connection is checked before the socket opens. Idempotent. */
function install(opts = {}) {
  const pg = opts.pg || require('pg');
  const Client = pg.Client;
  if (Client.prototype.__daiiGuarded) return;
  const policy = opts.policy || loadPolicy();
  const original = Client.prototype.connect;
  Client.prototype.connect = function guardedConnect(cb) {
    const p = this.connectionParameters || this._connectionOptions || {};
    const d = evaluate({ host: p.host, port: p.port, database: p.database }, policy);
    if (!d.allowed) {
      const err = new DbGuardError(`DB guard REFUSED connection to ${p.host}:${p.port}/${p.database} — ${d.reason}. No socket was opened.`);
      if (typeof cb === 'function') {
        process.nextTick(cb, err);
        return undefined;
      }
      return Promise.reject(err);
    }
    return original.apply(this, arguments);
  };
  // Statement-level guard: server-wide / cross-database DDL is checked against the approved entry for the connection's server.
  const originalQuery = Client.prototype.query;
  Client.prototype.query = function guardedQuery(config) {
    const text = typeof config === 'string' ? config : config && typeof config.text === 'string' ? config.text : null;
    if (text !== null) {
      const p = this.connectionParameters || this._connectionOptions || {};
      const conn = { host: p.host, port: p.port, database: p.database };
      const role = evaluate(conn, policy).role;
      const violation = (role === 'admin' ? checkAdminStatement(text, conn, policy) : null) || checkStatement(text, conn, policy);
      if (violation) {
        const err = new DbGuardError(`DB guard REFUSED statement on ${p.host}:${p.port}/${p.database} — ${violation}. Nothing was executed.`);
        const cb = arguments[arguments.length - 1];
        if (typeof cb === 'function') {
          process.nextTick(cb, err);
          return undefined;
        }
        return Promise.reject(err);
      }
    }
    return originalQuery.apply(this, arguments);
  };
  Client.prototype.__daiiGuarded = true;
}

const DB_DDL = /\b(CREATE|DROP|ALTER)\s+DATABASE\s+(?:IF\s+EXISTS\s+)?("(?:[^"]|"")+"|[A-Za-z0-9_$]+)/gi;
const ROLE_DDL = /\b(CREATE|DROP|ALTER)\s+(?:ROLE|USER)\s+(?:IF\s+EXISTS\s+)?("(?:[^"]|"")+"|[A-Za-z0-9_$]+)/gi;
const unquote = (s) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);


/**
 * Administrative connections (e.g. to `postgres`) may run ONLY:
 *   - transaction control and harmless session SET statements;
 *   - read-only SELECT / SHOW (no SELECT ... INTO, no data-modifying CTE);
 *   - EXACTLY `CREATE DATABASE "<name>"` and `DROP DATABASE [IF EXISTS] "<name>" [WITH (FORCE)]` where <name> matches `databasePatterns`
 *     of the approved entry (no OWNER / TEMPLATE / ENCODING / any other clause — a TEMPLATE could clone a protected database).
 * Everything else (INSERT/UPDATE/DELETE/TRUNCATE/ALTER/GRANT/CREATE TABLE/COPY/…) is refused, so business tests cannot run here.
 * Returns a violation message or null.
 */
function checkAdminStatement(text, conn, policy) {
  const sql = String(text).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const host = normaliseHost(conn.host);
  const entry = (policy.approved || []).find((e) => normaliseHost(e.host) === host && e.port === Number(conn.port));
  if (!entry) return 'no approved entry for this server';
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  if (!statements.length) return null;
  for (const s of statements) {
    if (/^(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION)\b/i.test(s)) continue;
    if (/^SET\s+(SESSION\s+|LOCAL\s+)?(TRANSACTION|TIME\s+ZONE|application_name|client_encoding|statement_timeout|lock_timeout|search_path|default_transaction_read_only)\b/i.test(s)) continue;
    if (/^(SELECT|SHOW)\b/i.test(s)) {
      if (/\bINTO\b/i.test(s) || /\b(INSERT|UPDATE|DELETE)\b/i.test(s)) return 'a SELECT with INTO or a data-modifying clause is not allowed on an administrative connection';
      continue;
    }
    const create = /^CREATE\s+DATABASE\s+(?:"((?:[^"]|"")+)"|([A-Za-z0-9_$]+))$/i.exec(s);
    const drop = /^DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?(?:"((?:[^"]|"")+)"|([A-Za-z0-9_$]+))(?:\s+WITH\s*\(\s*FORCE\s*\))?$/i.exec(s);
    const m = create || drop;
    if (m) {
      const name = unquote(m[1] !== undefined ? `"${m[1]}"` : m[2]);
      const ok = (entry.databasePatterns || []).some((p) => new RegExp(p).test(name)) && !DENIED_DATABASE_NAMES.has(name.toLowerCase()) && !DENIED_DATABASE_PATTERN.test(name) && !SYSTEM_DATABASES.has(name.toLowerCase());
      if (!ok) return `${create ? 'CREATE' : 'DROP'} DATABASE "${name}" is not an approved disposable database name`;
      continue;
    }
    return `statement not allowed on an administrative connection (only read-only SELECT/SHOW, transaction control, and exact CREATE/DROP DATABASE of approved disposable names): "${s.slice(0, 60)}"`;
  }
  return null;
}

/**
 * Returns a violation message, or null. Rules (all fail-closed):
 *  - CREATE/DROP/ALTER DATABASE only for a name matching `databasePatterns` of the approved entry for that server (a name listed
 *    only in `databases` — e.g. the maintenance database, or an ambient database — can never be created/dropped/altered by tests);
 *  - role DDL only for names matching the entry's `rolePatterns` (absent ⇒ refused);
 *  - ALTER SYSTEM, tablespace DDL, DROP OWNED, CREATE/ALTER EXTENSION on other servers: refused;
 *  - pg_terminate_backend / pg_cancel_backend only when the statement filters on datname AND application_name AND excludes its own pid.
 */
function checkStatement(text, conn, policy) {
  const sql = String(text).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const hasDdl = /\b(CREATE|DROP|ALTER)\b/i.test(sql) || /pg_terminate_backend|pg_cancel_backend/i.test(sql);
  if (!hasDdl) return null;
  const host = normaliseHost(conn.host);
  const entry = (policy.approved || []).find((e) => normaliseHost(e.host) === host && e.port === Number(conn.port));
  if (!entry) return null; // connection itself is checked by connect(); statements on unknown servers never get this far
  if (/\bALTER\s+SYSTEM\b/i.test(sql)) return 'ALTER SYSTEM is never allowed from a guarded process';
  if (/\b(CREATE|DROP|ALTER)\s+TABLESPACE\b/i.test(sql) || /\bDROP\s+OWNED\b/i.test(sql)) return 'tablespace / DROP OWNED statements are never allowed from a guarded process';
  for (const m of sql.matchAll(DB_DDL)) {
    const name = unquote(m[2]);
    const ok = (entry.databasePatterns || []).some((p) => new RegExp(p).test(name)) && !DENIED_DATABASE_NAMES.has(name.toLowerCase()) && !DENIED_DATABASE_PATTERN.test(name);
    if (!ok) return `${m[1].toUpperCase()} DATABASE "${name}" is not allowed (only names matching the approved disposable-database patterns)`;
  }
  for (const m of sql.matchAll(ROLE_DDL)) {
    const name = unquote(m[2]);
    const ok = (entry.rolePatterns || []).some((p) => new RegExp(p).test(name));
    if (!ok) return `${m[1].toUpperCase()} ROLE "${name}" is not allowed (no matching rolePatterns in the approved entry)`;
  }
  if (/pg_terminate_backend|pg_cancel_backend/i.test(sql) && !(/datname\s*=/i.test(sql) && /application_name\s*=/i.test(sql) && /pg_backend_pid\s*\(\s*\)/i.test(sql))) {
    return 'pg_terminate_backend/pg_cancel_backend must filter on datname AND application_name and exclude pg_backend_pid()';
  }
  return null;
}

/** For manual HTTP scripts: only a loopback API base is a legal target. */
function assertLoopbackApi(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    throw new DbGuardError(`DB guard: API base "${url}" is not a valid URL.`);
  }
  if (normaliseHost(u.hostname.replace(/^\[|\]$/g, '')) !== 'loopback') {
    throw new DbGuardError(`DB guard REFUSED API target ${u.host}: manual verification scripts may only talk to a loopback test instance.`);
  }
}

module.exports = { checkAdminStatement, SYSTEM_DATABASES, checkStatement, evaluate, loadPolicy, preflight, install, effectiveAmbient, parseDotenv, assertLoopbackApi, DbGuardError, POLICY_PATH };

if (require.main === module) {
  // CLI: `node tools/testing/db-guard.js --check`  → prints the decision for the ambient configuration; opens no connection.
  try {
    const r = preflight();
    console.log(`OK: ${r.target.host}:${r.target.port}/${r.target.database} approved (${r.decision.entryId})`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
