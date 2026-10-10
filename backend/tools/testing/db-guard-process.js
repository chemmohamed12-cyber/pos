'use strict';
/**
 * Guard layers beyond pg.Client.connect (CTO D-13): everything that can reach a database WITHOUT going through the
 * patched `pg.Client`, closed fail-closed:
 *   - libpq command-line clients (pg_dump, pg_restore, psql, createdb, dropdb, …) are checked per command from their explicit
 *     --host/--port/--dbname arguments; if the target is not explicit they are REFUSED (libpq defaults and PG* variables are not trusted);
 *   - cluster-management binaries (pg_ctl, initdb, …) are always refused from a guarded process;
 *   - free-form shell strings (exec/execSync/shell:true) that mention a DB binary are refused (they cannot be verified);
 *   - `pg.native` (a separate libpq binding) is refused outright;
 *   - every Node child process spawned from a guarded process inherits the guard through NODE_OPTIONS=--require db-guard-register.
 */
const path = require('path');
const util = require('util');
const guard = require('./db-guard');

const REGISTER_PATH = path.join(__dirname, 'db-guard-register.js').replace(/\\/g, '/');
const PG_CLIENT_BINS = new Set(['pg_dump', 'pg_dumpall', 'pg_restore', 'psql', 'createdb', 'dropdb', 'createuser', 'dropuser', 'vacuumdb', 'reindexdb', 'clusterdb', 'pg_basebackup', 'pg_isready']);
const PG_CLUSTER_BINS = new Set(['pg_ctl', 'initdb', 'pg_upgrade', 'pg_resetwal', 'postgres']);
const NODE_LIKE = new Set(['node', 'ts-node', 'npx', 'npm', 'jest']);

const binName = (cmd) => path.basename(String(cmd || '')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');

/** The connection identity a libpq CLI would use, from its argument array; null when it is not fully explicit. */
function parseCliTarget(args) {
  const a = (args || []).map(String);
  const val = (long, short) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === long || (short && a[i] === short)) return a[i + 1];
      if (a[i].startsWith(long + '=')) return a[i].slice(long.length + 1);
    }
    return undefined;
  };
  let host = val('--host', '-h');
  let port = val('--port', '-p');
  let database = val('--dbname', '-d');
  if (database && (/^postgres(ql)?:\/\//.test(database) || database.includes('='))) {
    try {
      if (/^postgres/.test(database)) {
        const u = new URL(database);
        host = host || u.hostname;
        port = port || u.port;
        database = decodeURIComponent(u.pathname.replace(/^\//, ''));
      } else {
        const kv = Object.fromEntries(database.split(/\s+/).map((s) => s.split('=')));
        host = host || kv.host;
        port = port || kv.port;
        database = kv.dbname;
      }
    } catch (_) {
      return null;
    }
  }
  if (!host || !port || !database) return null;
  return { host, port, database };
}

function checkCommand(cmd, args, policy, shellString) {
  if (shellString !== undefined) {
    const names = [...PG_CLIENT_BINS, ...PG_CLUSTER_BINS];
    const hit = names.find((b) => new RegExp(`(^|[\\s\\\\/"'])${b}(\\.exe)?(\\s|$|["'])`, 'i').test(shellString));
    if (hit) throw new guard.DbGuardError(`DB guard REFUSED a shell command mentioning "${hit}": shell strings cannot be verified; use execFile with explicit --host/--port/--dbname.`);
    return;
  }
  const bin = binName(cmd);
  const argv = (args || []).map(String);
  if (PG_CLUSTER_BINS.has(bin)) throw new guard.DbGuardError(`DB guard REFUSED to run "${bin}": starting, stopping or creating PostgreSQL servers is not allowed from a guarded process.`);
  const looksLikeDbCli = PG_CLIENT_BINS.has(bin) || argv.some((x) => /^--dbname(=|$)/.test(x));
  if (!looksLikeDbCli) return;
  const listOnly = bin === 'pg_restore' && argv.some((x) => x === '--list' || x === '-l') && !argv.some((x) => /^(--dbname|-d)(=|$)/.test(x));
  if (listOnly) return; // reads an archive file, opens no connection
  const target = parseCliTarget(argv);
  if (!target) throw new guard.DbGuardError(`DB guard REFUSED to run "${bin}": no explicit --host/--port/--dbname (libpq defaults and PG* variables are not trusted).`);
  const d = guard.evaluate(target, policy);
  if (!d.allowed) throw new guard.DbGuardError(`DB guard REFUSED "${bin}" against ${target.host}:${target.port}/${target.database} — ${d.reason}. No process was started.`);
}

function nodeOptionsWithGuard(existing) {
  const cur = String(existing || '');
  return cur.includes('db-guard-register') ? cur : `${cur ? cur + ' ' : ''}--require "${REGISTER_PATH}"`;
}

function installChildProcessGuard(opts = {}) {
  const cp = opts.child_process || require('child_process');
  if (cp.__daiiGuarded) return;
  const policy = opts.policy || guard.loadPolicy();
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = cp[name];
    if (typeof original !== 'function') continue;
    cp[name] = function guardedProcess(...args) {
      const cmd = args[0];
      if (name === 'exec' || name === 'execSync') {
        checkCommand(cmd, [], policy, String(cmd));
        return original.apply(this, args);
      }
      const hasArgv = Array.isArray(args[1]);
      const argv = hasArgv ? args[1] : [];
      const optIdx = hasArgv ? 2 : 1;
      const o = args[optIdx] && typeof args[optIdx] === 'object' && typeof args[optIdx] !== 'function' ? args[optIdx] : undefined;
      if (name !== 'fork') checkCommand(cmd, argv, policy);
      if (o && (o.shell === true || typeof o.shell === 'string')) checkCommand(cmd, argv, policy, [cmd, ...argv].join(' '));
      // Node children inherit the guard (fork always runs node; spawn/execFile of node/ts-node/npx etc.)
      if (name === 'fork' || NODE_LIKE.has(binName(cmd)) || binName(cmd) === binName(process.execPath)) {
        const env = { ...((o && o.env) || process.env) };
        env.NODE_OPTIONS = nodeOptionsWithGuard(env.NODE_OPTIONS);
        const patched = { ...(o || {}), env };
        if (o) args[optIdx] = patched;
        else if (hasArgv) args.splice(2, 0, patched);
        else args.splice(1, 0, [], patched);
      }
      return original.apply(this, args);
    };
    // util.promisify(execFile/exec) must keep resolving { stdout, stderr } — and must go through THIS guarded function, not the original.
    if (original[util.promisify.custom]) {
      cp[name][util.promisify.custom] = (...a) =>
        new Promise((resolve, reject) => {
          cp[name](...a, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
        });
    }
  }
  cp.__daiiGuarded = true;
}

/** Every layer. Idempotent. `noEnv` skips the NODE_OPTIONS propagation (used by unit tests of the guard itself). */
function installAll(opts = {}) {
  guard.install(opts);
  const pg = opts.pg || require('pg');
  try {
    Object.defineProperty(pg, 'native', {
      configurable: true,
      get() {
        throw new guard.DbGuardError('DB guard REFUSED pg.native: the native driver is not covered by the guard.');
      },
    });
  } catch (_) {
    /* not configurable: leave it, the native binding is not installed in this project */
  }
  installChildProcessGuard(opts);
  if (!opts.noEnv) process.env.NODE_OPTIONS = nodeOptionsWithGuard(process.env.NODE_OPTIONS);
}

module.exports = { installAll, installChildProcessGuard, checkCommand, parseCliTarget, nodeOptionsWithGuard, REGISTER_PATH };
