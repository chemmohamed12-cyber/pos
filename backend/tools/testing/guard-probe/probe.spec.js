// Probe: proves the guard layers work INSIDE jest's module registry. Targets are a CLOSED port (127.0.0.1:1):
// if the guard failed, the error would be ECONNREFUSED; if it works, the error is a DbGuardError and no socket is opened.
const B = require('path').join(__dirname, '..', '..', '..').split('\\').join('/') + '/';
const { Client, Pool } = require(B + 'node_modules/pg');
const { DataSource } = require(B + 'node_modules/typeorm');
const cp = require('child_process');
const util = require('util');

test('pg.Client is refused before any socket', async () => {
  await expect(new Client({ host: '127.0.0.1', port: 1, database: 'x', user: 'u', password: 'p' }).connect()).rejects.toThrow(/DB guard REFUSED connection/);
});
test('pg.Pool is refused', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 1, database: 'x', user: 'u', password: 'p' });
  await expect(pool.query('select 1')).rejects.toThrow(/DB guard REFUSED connection/);
  await pool.end();
});
test('TypeORM DataSource.initialize is refused', async () => {
  const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: 1, database: 'x', username: 'u', password: 'p' });
  await expect(ds.initialize()).rejects.toThrow(/DB guard REFUSED connection/);
});
test('pg.native is refused', () => {
  expect(() => require(B + 'node_modules/pg').native).toThrow(/pg\.native/);
});
test('libpq CLI without explicit target and cluster binaries are refused; promisified execFile too', async () => {
  expect(() => cp.execFile('psql', ['-c', 'select 1'], () => {})).toThrow(/REFUSED/);
  expect(() => cp.spawn('pg_ctl', ['status'])).toThrow(/REFUSED/);
  await expect(util.promisify(cp.execFile)('pg_dump', ['--host', '127.0.0.1', '--port', '1', '--dbname', 'x'])).rejects.toThrow(/REFUSED/);
});
test('a harmless promisified execFile still resolves {stdout, stderr}', async () => {
  const r = await util.promisify(cp.execFile)(process.execPath, ['-e', 'process.stdout.write("ok")']);
  expect(r.stdout).toBe('ok');
});
test('a Node child inherits the guard (NODE_OPTIONS) and is refused too', async () => {
  const code = `const {Client}=require(${JSON.stringify(B + 'node_modules/pg')});new Client({host:'127.0.0.1',port:1,database:'x',user:'u',password:'p'}).connect().then(()=>console.log('CONNECTED'),e=>console.log(e.name+':'+e.message.slice(0,40)))`;
  const r = await util.promisify(cp.execFile)(process.execPath, ['-e', code], { env: { PATH: process.env.PATH } });
  expect(r.stdout).toMatch(/DbGuardError:DB guard REFUSED/);
});
