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
const DENIED_DATABASE_PATTERN = /(prod|production|live|staging)/i;
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

function isCompleteApproval(e) {
  return !!(e && e.host && Number.isInteger(e.port) && e.approvedBy && e.approvedOn && e.identityEvidence && (Array.isArray(e.databases) || Array.isArray(e.databasePatterns)));
}

/** Pure decision. `target` = { host, port, database }. Returns { allowed, reason, entryId }. */
function evaluate(target, policy) {
  const host = normaliseHost(target.host);
  const port = target.port === undefined || target.port === null || target.port === '' ? NaN : Number(target.port);
  const database = target.database === undefined || target.database === null ? '' : String(target.database).trim();

  if (!host) return deny('host is unknown or empty');
  if (host !== 'loopback') return deny(`host "${target.host}" is not a loopback address (shared/remote servers are never test targets)`);
  if (!Number.isInteger(port)) return deny('port is unknown or not a number');
  if (DENIED_PORTS.has(port)) return deny(`port ${port} is the shared development server`);
  if (!database) return deny('database name is unknown or empty');
  if (DENIED_DATABASE_NAMES.has(database.toLowerCase())) return deny(`database "${database}" is a protected shared/development database`);
  if (DENIED_DATABASE_PATTERN.test(database)) return deny(`database "${database}" looks like a production/staging database`);

  for (const e of policy.approved) {
    if (normaliseHost(e.host) !== host || e.port !== port) continue;
    const named = (e.databases || []).some((d) => String(d).toLowerCase() === database.toLowerCase());
    const patterned = (e.databasePatterns || []).some((p) => new RegExp(p).test(database));
    if (named || patterned) return { allowed: true, reason: 'approved', entryId: e.id || `${e.host}:${e.port}` };
  }
  return deny(`${host}:${port}/${database} is not on the approved test-database list (approved entries: ${policy.approved.length}, incomplete entries ignored: ${policy.incomplete || 0})`);
}

function deny(reason) {
  return { allowed: false, reason, entryId: null };
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
  const d = evaluate(target, policy);
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
      const violation = checkStatement(text, { host: p.host, port: p.port, database: p.database }, policy);
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

module.exports = { checkStatement, evaluate, loadPolicy, preflight, install, effectiveAmbient, parseDotenv, assertLoopbackApi, DbGuardError, POLICY_PATH };

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
