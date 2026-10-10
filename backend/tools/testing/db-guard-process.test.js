'use strict';
// node --test tools/testing/db-guard-process.test.js — no database, no network, no real process is started (child_process is a fake).
const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('util');
const guard = require('./db-guard');
const proc = require('./db-guard-process');

const policy = {
  approved: [{ id: 'p', host: '127.0.0.1', port: 6001, databases: ['postgres'], databasePatterns: ['^daii_test_'], approvedBy: 'cto', approvedOn: 'x', identityEvidence: 'fixture' }],
  incomplete: 0,
};
const dump = (host, port, db) => ['--host', host, '--port', String(port), '--username', 'u', '--dbname', db, '-Fc', '-f', 'out.dump'];

test('parseCliTarget: long, short, = forms, URI and key=value', () => {
  assert.deepEqual(proc.parseCliTarget(dump('127.0.0.1', 6001, 'daii_test_a')), { host: '127.0.0.1', port: '6001', database: 'daii_test_a' });
  assert.deepEqual(proc.parseCliTarget(['-h', 'localhost', '-p', '6001', '-d', 'daii_test_a']), { host: 'localhost', port: '6001', database: 'daii_test_a' });
  assert.deepEqual(proc.parseCliTarget(['--host=localhost', '--port=6001', '--dbname=daii_test_a']), { host: 'localhost', port: '6001', database: 'daii_test_a' });
  assert.deepEqual(proc.parseCliTarget(['-d', 'postgresql://u:p@127.0.0.1:6001/daii_test_a']), { host: '127.0.0.1', port: '6001', database: 'daii_test_a' });
  assert.deepEqual(proc.parseCliTarget(['-d', 'host=127.0.0.1 port=6001 dbname=daii_test_a']), { host: '127.0.0.1', port: '6001', database: 'daii_test_a' });
  assert.equal(proc.parseCliTarget(['--dbname', 'daii_test_a']), null, 'host/port missing → not explicit');
});

test('libpq CLIs: approved explicit target passes; everything else is refused', () => {
  assert.doesNotThrow(() => proc.checkCommand('C:\\pg\\bin\\pg_dump.exe', dump('127.0.0.1', 6001, 'daii_test_a'), policy));
  assert.throws(() => proc.checkCommand('pg_dump', dump('127.0.0.1', 5433, 'daii_test_a'), policy), /REFUSED/);
  assert.throws(() => proc.checkCommand('pg_dump', dump('127.0.0.1', 6001, 'daii_dev'), policy), /REFUSED/);
  assert.throws(() => proc.checkCommand('pg_restore', dump('db.example.com', 6001, 'daii_test_a'), policy), /REFUSED/);
  assert.throws(() => proc.checkCommand('psql', [], policy), /no explicit/);
  assert.throws(() => proc.checkCommand('psql', ['-c', 'select 1'], policy), /no explicit/);
  assert.throws(() => proc.checkCommand('createdb', ['x'], policy), /no explicit/);
});

test('pg_restore --list without a target reads a file only and is allowed; with a target it is checked', () => {
  assert.doesNotThrow(() => proc.checkCommand('pg_restore', ['--list', 'f.dump'], policy));
  assert.throws(() => proc.checkCommand('pg_restore', ['--list', '--dbname', 'x', 'f.dump'], policy), /no explicit/);
});

test('cluster management binaries are always refused; a renamed shim with --dbname is still treated as a DB client', () => {
  for (const b of ['pg_ctl', 'initdb', 'C:\\pg\\bin\\pg_ctl.exe', 'postgres']) assert.throws(() => proc.checkCommand(b, ['start'], policy), /REFUSED to run/);
  assert.throws(() => proc.checkCommand('my-dump-wrapper', ['--dbname', 'daii_dev'], policy), /no explicit/);
  assert.doesNotThrow(() => proc.checkCommand('tar', ['-czf', 'a.tgz', 'dir'], policy));
});

test('shell strings mentioning DB binaries are refused (cannot be verified); harmless strings pass', () => {
  assert.throws(() => proc.checkCommand('x', [], policy, 'pg_dump -h 127.0.0.1 -p 6001 -d daii_test_a'), /shell/);
  assert.throws(() => proc.checkCommand('x', [], policy, '"C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe" -c "select 1"'), /shell/);
  assert.throws(() => proc.checkCommand('x', [], policy, 'pg_ctl -D data start'), /shell/);
  assert.doesNotThrow(() => proc.checkCommand('x', [], policy, 'echo hello && tar -czf a.tgz dir'));
});

function fakeChildProcess() {
  const calls = [];
  const make = (name) => {
    const fn = (...args) => { calls.push({ name, args }); const cb = args[args.length - 1]; if (typeof cb === 'function') process.nextTick(cb, null, 'out', 'err'); return { pid: 1 }; };
    return fn;
  };
  const cp = {};
  for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) cp[n] = make(n);
  // mimic node's custom promisify shapes for execFile/exec
  cp.execFile[util.promisify.custom] = () => { calls.push({ name: 'ORIGINAL-promisified-execFile-called' }); return Promise.resolve({ stdout: 'x', stderr: 'y' }); };
  cp.exec[util.promisify.custom] = () => { calls.push({ name: 'ORIGINAL-promisified-exec-called' }); return Promise.resolve({ stdout: 'x', stderr: 'y' }); };
  return { cp, calls };
}

test('child_process wrapper: refused command never reaches the real function; allowed one does; Node children inherit the guard', () => {
  const { cp, calls } = fakeChildProcess();
  proc.installChildProcessGuard({ child_process: cp, policy });

  assert.throws(() => cp.spawn('pg_dump', dump('127.0.0.1', 5433, 'daii_dev')), /REFUSED/);
  assert.throws(() => cp.execFile('psql', ['-c', '1'], () => {}), /REFUSED/);
  assert.throws(() => cp.exec('pg_dump -d x'), /shell/);
  assert.throws(() => cp.spawn('pg_dump -d x', [], { shell: true }), /shell/);
  assert.equal(calls.length, 0, 'nothing refused reached the underlying implementation');

  cp.spawn('pg_dump', dump('127.0.0.1', 6001, 'daii_test_a'));
  assert.equal(calls.length, 1);

  cp.spawn(process.execPath, ['worker.js'], { env: { PATH: 'x' } });
  const nodeCall = calls[calls.length - 1];
  assert.match(nodeCall.args[2].env.NODE_OPTIONS, /db-guard-register/, 'a Node worker spawned with a custom env still carries the guard');
  cp.fork('worker.js');
  assert.match(calls[calls.length - 1].args[2].env.NODE_OPTIONS, /db-guard-register/, 'fork without options gets options injected');
  cp.spawn(process.execPath, ['w.js']);
  assert.match(calls[calls.length - 1].args[2].env.NODE_OPTIONS, /db-guard-register/, 'spawn without options/args gets options injected');
});

test('util.promisify(execFile) keeps resolving { stdout, stderr } and goes through the GUARDED function, not the original', async () => {
  const { cp, calls } = fakeChildProcess();
  proc.installChildProcessGuard({ child_process: cp, policy });
  const execFileAsync = util.promisify(cp.execFile);
  const r = await execFileAsync('tar', ['-czf', 'a', 'b']);
  assert.deepEqual(r, { stdout: 'out', stderr: 'err' });
  assert.ok(!calls.some((c) => c.name.startsWith('ORIGINAL')), 'the unguarded promisified original was bypassed');
  await assert.rejects(() => execFileAsync('pg_dump', dump('127.0.0.1', 5433, 'daii_dev')), /REFUSED/);
});

test('installAll: pg.Client connect guard + pg.native refused + idempotent (fake pg, no env propagation)', async () => {
  let reached = 0;
  class FakeClient { constructor(p) { this.connectionParameters = p; } connect() { reached += 1; return Promise.resolve(); } }
  const pg = { Client: FakeClient };
  const { cp } = fakeChildProcess();
  proc.installAll({ pg, child_process: cp, policy, noEnv: true });
  proc.installAll({ pg, child_process: cp, policy, noEnv: true });
  assert.throws(() => pg.native, /pg\.native/);
  await assert.rejects(() => new FakeClient({ host: '127.0.0.1', port: 5433, database: 'daii_dev' }).connect(), /REFUSED/);
  assert.equal(reached, 0);
  await new FakeClient({ host: '127.0.0.1', port: 6001, database: 'daii_test_z' }).connect();
  assert.equal(reached, 1);
});

test('nodeOptionsWithGuard is idempotent and keeps existing options', () => {
  const once = proc.nodeOptionsWithGuard('--max-old-space-size=512');
  assert.match(once, /--max-old-space-size=512 --require ".*db-guard-register\.js"/);
  assert.equal(proc.nodeOptionsWithGuard(once), once);
});
