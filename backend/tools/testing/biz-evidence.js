'use strict';
/**
 * Evidence writer for the business-test program (T-01…T-12). Evidence is written INSIDE the approved project root, outside any test
 * database, and is verified (re-read + SHA-256 manifest) BEFORE the disposable databases are dropped.
 *
 *   const run = ev.createRun('T-03');                       // backend/docs/decisions/evidence-2026-10-10-biz/T-03/<runId>/
 *   ev.writeHeader(run, { systemIdentifier, databases, ... });
 *   ev.writeJson(run, 'raw-round-01.json', data);
 *   const manifest = ev.finalize(run);                      // throws if anything cannot be re-read with the same hash
 *
 * It refuses any directory outside <project root>/backend/docs/decisions/evidence-2026-10-10-biz.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(BACKEND, '..'); // .../release-new
const EVIDENCE_BASE = path.join(BACKEND, 'docs', 'decisions', 'evidence-2026-10-10-biz');
const RESULTS = Object.freeze(['PASS', 'FAIL', 'FAIL-DEFECT', 'BLOCKED', 'STOP']);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function assertInside(p, base = EVIDENCE_BASE) {
  const real = path.resolve(p);
  if (!(real + path.sep).startsWith(base + path.sep)) throw new Error(`evidence path escapes the approved evidence directory: ${real}`);
  return real;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return 'unavailable';
  }
}

function createRun(testId, opts = {}) {
  if (!/^(T-\d{2}[a-z]?|_selftest)$/.test(testId)) throw new Error(`bad test id: ${testId}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const runId = `${testId}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = assertInside(path.join(opts.base || EVIDENCE_BASE, testId, runId), opts.base || EVIDENCE_BASE);
  fs.mkdirSync(dir, { recursive: true });
  return { testId, runId, dir, files: new Set(), startedAt: new Date().toISOString(), base: opts.base || EVIDENCE_BASE };
}

function writeJson(run, name, obj) {
  if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) throw new Error(`bad evidence file name: ${name}`);
  const file = assertInside(path.join(run.dir, name), run.base);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  run.files.add(name);
  return file;
}

/** Version-pinning header (CTO amendment 1): without it two runs cannot be compared. Never records secrets. */
function writeHeader(run, extra = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
  const env = process.env;
  const header = {
    testId: run.testId,
    runId: run.runId,
    startedAt: run.startedAt,
    commit: git(['rev-parse', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: git(['status', '--porcelain', '--', 'backend/src', 'backend/tools']).split(/\r?\n/).filter(Boolean),
    applicationVersion: pkg.version,
    node: process.version,
    environment: { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT, DB_USER: env.DB_USER, DB_NAME: env.DB_NAME, COMPANY_DB_MODE: env.COMPANY_DB_MODE },
    projectRoot: ROOT,
    ...extra,
  };
  for (const k of Object.keys(header.environment)) if (header.environment[k] === undefined) delete header.environment[k];
  if (JSON.stringify(header).toLowerCase().includes('password')) throw new Error('header must not contain credentials');
  writeJson(run, 'run-header.json', header);
  return header;
}

/** md5 fingerprints of whole tables (ordered row text) — equal before/after proves a refused operation left no trace. */
async function fingerprint(ds, tables) {
  const out = {};
  for (const t of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`bad table name: ${t}`);
    const exists = await ds.query('SELECT to_regclass($1) IS NOT NULL AS e', [`public.${t}`]);
    if (!exists[0].e) { out[t] = 'absent'; continue; }
    const r = await ds.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`);
    out[t] = `${r[0].n}:${r[0].h}`;
  }
  return out;
}

const diffFingerprints = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => ({ table: k, before: a[k], after: b[k] }));

async function readSystemIdentifier(adminDs) {
  const r = await adminDs.query('SELECT system_identifier::text AS id FROM pg_control_system()');
  return r[0].id;
}

/** Writes MANIFEST.sha256, then RE-READS every file and recomputes hashes. Throws on any mismatch/missing file (=> STOP before cleanup). */
function finalize(run) {
  const lines = [];
  for (const name of [...run.files].sort()) {
    const buf = fs.readFileSync(path.join(run.dir, name));
    lines.push(`${sha256(buf)}  ${name}`);
  }
  fs.writeFileSync(path.join(run.dir, 'MANIFEST.sha256'), lines.join('\n') + '\n');
  for (const line of fs.readFileSync(path.join(run.dir, 'MANIFEST.sha256'), 'utf8').trim().split('\n')) {
    const [hash, name] = line.split(/\s{2}/);
    if (sha256(fs.readFileSync(path.join(run.dir, name))) !== hash) throw new Error(`evidence verification failed for ${name}`);
  }
  return { dir: run.dir, files: [...run.files].sort(), manifest: lines };
}

function writeResult(run, results) {
  for (const r of results) if (!RESULTS.includes(r.status)) throw new Error(`bad result status: ${r.status}`);
  return writeJson(run, 'result.json', { testId: run.testId, runId: run.runId, finishedAt: new Date().toISOString(), results });
}

module.exports = { createRun, writeJson, writeHeader, writeResult, finalize, fingerprint, diffFingerprints, readSystemIdentifier, assertInside, EVIDENCE_BASE, RESULTS, ROOT };
