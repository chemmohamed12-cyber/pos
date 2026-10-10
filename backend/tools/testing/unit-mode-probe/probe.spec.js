// Proves DATABASE-FREE unit mode really denies everything (run: npm run test:unit:probe). Targets a CLOSED port / nonexistent host so that a
// failure of the denial would show as ECONNREFUSED / ENOTFOUND, never as a connection to anything real.
const path = require('path');
const B = path.join(__dirname, '..', '..', '..').split('\\').join('/') + '/';
const { UnitModeError } = require('../unit-mode-setup');

describe('unit mode denies every route to a database or the network', () => {
  test('the ambient database environment is scrubbed', () => {
    expect(Object.keys(process.env).filter((k) => /^(DB_|PG|DATABASE_URL|TYPEORM_)/.test(k))).toEqual([]);
    expect(process.env.DAII_UNIT_MODE).toBe('1');
  });
  test('loading the pg driver (or any DB driver) fails', () => {
    expect(() => require(B + 'node_modules/pg')).toThrow(/unit mode \(database-free\)/);
    expect(() => require('pg')).toThrow(/unit mode/);
  });
  test('TypeORM cannot build or initialise a postgres DataSource', async () => {
    const { DataSource } = require(B + 'node_modules/typeorm');
    expect(() => new DataSource({ type: 'postgres', host: '127.0.0.1', port: 1, database: 'x', username: 'u', password: 'p' })).toThrow();
  });
  test('AppModule, the real-PG harnesses and the CLI data source cannot be loaded', () => {
    expect(() => require(B + 'src/app.module')).toThrow(/unit mode/);
    expect(() => require(B + 'src/foundation/testing/two-company-real-pg-harness')).toThrow(/unit mode/);
    expect(() => require(B + 'src/foundation/testing/ambient-test-datasource')).toThrow(/unit mode/);
    expect(() => require(B + 'src/database/data-source')).toThrow(/unit mode/);
  });
  test('any socket connection is a hard error, loopback included', () => {
    const net = require('net');
    expect(() => net.connect(1, '127.0.0.1')).toThrow(UnitModeError);
    expect(() => new net.Socket().connect(1, '127.0.0.1')).toThrow(/network\/socket connection/);
    expect(() => require('http').get('http://127.0.0.1:1/')).toThrow();
    expect(() => require('https').get('https://example.invalid/')).toThrow();
  });
  test('listening servers, DNS and child processes are denied', async () => {
    const net = require('net');
    expect(() => net.createServer().listen(0)).toThrow(/listening on a port/);
    expect(() => require('dns').lookup('example.invalid', () => {})).toThrow(/DNS/);
    expect(() => require('dns').promises.lookup('example.invalid')).toThrow(/DNS/);
    const cp = require('child_process');
    for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) expect(() => cp[fn]('node', ['-e', '1'])).toThrow(/child process/);
  });
});
