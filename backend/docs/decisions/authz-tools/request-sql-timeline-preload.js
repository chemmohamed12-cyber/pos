require(require('path').join(__dirname, '..', '..', '..', 'tools', 'testing', 'db-guard-register')); // DB guard (M-R2 §11): default deny, all layers — no connection to an unapproved database
const pg = require(process.env.TRACE_PG);
let log = [];
const orig = pg.Client.prototype.query;
const t0 = () => Number(process.hrtime.bigint()) / 1e6;
pg.Client.prototype.query = function patched(...args) {
  const a = args[0]; const text = typeof a === 'string' ? a : a && a.text ? a.text : String(a);
  const s = t0(); const rec = { s, sql: text.replace(/\s+/g, ' ').slice(0, 60), db: this.database, c: this.processID };
  log.push(rec);
  const r = orig.apply(this, args);
  if (r && r.then) return r.then((x) => { rec.e = t0(); return x; }, (e) => { rec.e = t0(); throw e; });
  return r;
};
require('http').createServer((req, res) => { if (req.url === '/reset') { log = []; return res.end('0'); } res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(log)); }).listen(Number(process.env.TRACE_PORT), '127.0.0.1');
// request wall time
const http = require('http'); const oe = http.Server.prototype.emit;
http.Server.prototype.emit = function (ev, req, res) { if (ev === 'request' && res && req.url.startsWith('/api')) { const s = t0(); res.on('finish', () => { log.push({ s, e: t0(), sql: 'HTTP ' + req.url.slice(0, 40), db: '-' }); }); } return oe.apply(this, arguments); };
