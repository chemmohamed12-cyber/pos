'use strict';
/**
 * Database-free UNIT mode (CTO directive, phase 3). `npm run test:unit` runs ONLY the specs listed in tools/testing/unit-specs.txt,
 * and this file (jest setupFiles) makes any connection attempt a hard error — it does NOT approve anything and it does NOT weaken
 * the DB guard that governs every database-backed run (jest.config.js).
 *
 * Denied in this mode, fail-closed:
 *   - every outbound socket connection (net.Socket#connect) — PostgreSQL, HTTP clients, anything, including loopback;
 *   - listening servers (net.Server#listen) — no local HTTP servers for supertest-style tests;
 *   - DNS lookups;
 *   - every child process (spawn/exec/fork…);
 *   - loading the `pg` driver or any other DB driver, AppModule, the real-PG harnesses and the TypeORM CLI data source
 *     (jest.unit.config.js maps those module names to tools/testing/unit-mode-blocked.js, which throws on load);
 *   - the ambient database environment: DB_* / PG* / DATABASE_URL are removed from process.env before any spec runs.
 */
const UNIT = 'DAII unit mode (database-free)';
class UnitModeError extends Error {
  constructor(what) {
    super(`${UNIT}: ${what} is not allowed. This spec needs a database or the network and must run under the DB guard (npm test) with an approved database — remove it from tools/testing/unit-specs.txt.`);
    this.name = 'UnitModeError';
  }
}

const deny = (what) => () => {
  throw new UnitModeError(what);
};

const net = require('net');
net.Socket.prototype.connect = function deniedConnect() {
  throw new UnitModeError('opening a network/socket connection');
};
net.Server.prototype.listen = deny('listening on a port');
net.connect = net.createConnection = deny('net.connect');

const dns = require('dns');
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']) dns[fn] = deny(`DNS ${fn}`);
if (dns.promises) for (const fn of Object.keys(dns.promises)) dns.promises[fn] = deny(`DNS ${fn}`);

const cp = require('child_process');
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[fn] = deny(`starting a child process (${fn})`);

for (const k of Object.keys(process.env)) if (/^(DB_|PG[A-Z]*$|PG_|DATABASE_URL|TYPEORM_)/.test(k)) delete process.env[k];
process.env.DAII_UNIT_MODE = '1';

module.exports = { UnitModeError };
