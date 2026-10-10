import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const ev = require('../../../tools/testing/biz-evidence');

/**
 * T-10 (REQ-FIN-004) — consolidates R1–R10 across the business-test runs. FROZEN criteria: every R in every run is PASS or explained by the
 * run's declared exceptions; an unexplained difference is STOP. The per-run reconciliations were executed on each run's own disposable
 * database BEFORE its cleanup (reconcileAndRecord → `reconciliation-R1-R10.json`); this spec reads that preserved evidence — it needs no
 * database — so it can run last, after every dependent scenario, without keeping any database alive.
 * Expected runs (frozen set): the latest run of each of the test ids below must exist, belong to the SAME commit, and contain all ten checks.
 */
const EXPECTED_RUNS = ['T-00', 'T-01', 'T-03', 'T-05', 'T-06', 'T-07', 'T-08', 'T-09', 'T-11', 'T-12'];
const RECONCILING = new Set(['T-01', 'T-03', 'T-05', 'T-06', 'T-07', 'T-08', 'T-11']); // runs that own accounting/stock state (T-00 smoke, T-09 HTTP, T-12 connection loss record their own proofs)

describe('T-10 — consolidated reconciliation R1…R10 over the preserved evidence of every business run', () => {
  jest.setTimeout(120_000);

  it('every reconciling run has all ten R checks PASS (or explained); one consistent commit; nothing unexplained', () => {
    const run = ev.createRun('T-10');
    const latest: Record<string, { dir: string; header: any; recon: any } | null> = {};
    const problems: string[] = [];
    for (const id of EXPECTED_RUNS) {
      const base = join(ev.EVIDENCE_BASE, id);
      const runs = existsSync(base) ? readdirSync(base).sort() : [];
      const dir = runs.length ? join(base, runs[runs.length - 1]) : null;
      if (!dir) { latest[id] = null; problems.push(`${id}: no evidence run found`); continue; }
      const header = JSON.parse(readFileSync(join(dir, 'run-header.json'), 'utf8'));
      const reconFile = join(dir, 'reconciliation-R1-R10.json');
      const recon = existsSync(reconFile) ? JSON.parse(readFileSync(reconFile, 'utf8')) : null;
      const result = existsSync(join(dir, 'result.json')) ? JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) : null;
      latest[id] = { dir, header, recon };
      if (!result) problems.push(`${id}: result.json missing`);
      if (result && result.results.some((r: { status: string }) => r.status === 'STOP' || r.status === 'FAIL')) problems.push(`${id}: contains FAIL/STOP cases`);
      if (RECONCILING.has(id)) {
        if (!recon) problems.push(`${id}: reconciliation-R1-R10.json missing`);
        else {
          const ids = recon.checks.map((c: { id: string }) => c.id).sort();
          if (JSON.stringify(ids) !== JSON.stringify(['R1', 'R10', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'])) problems.push(`${id}: expected ten R checks, got ${ids.join(',')}`);
          for (const c of recon.checks) if (c.status !== 'PASS') problems.push(`${id}/${c.id}: ${c.status} ${JSON.stringify(c.detail).slice(0, 200)}`);
        }
      }
    }
    const commits = [...new Set(Object.values(latest).filter(Boolean).map((r) => r!.header.commit))];
    if (commits.length > 1) problems.push(`runs come from different commits: ${commits.join(', ')}`);
    const consolidated = {
      commit: commits[0],
      runs: Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, v ? { dir: v.dir.replace(ev.ROOT, '<root>'), checks: v.recon ? v.recon.checks.map((c: { id: string; status: string }) => `${c.id}:${c.status}`) : null } : null])),
      problems,
    };
    ev.writeHeader(run, { commits, consolidatedFrom: EXPECTED_RUNS });
    ev.writeJson(run, 'consolidated-reconciliation.json', consolidated);
    ev.writeResult(run, [{ id: 'T-10', status: problems.length === 0 ? 'PASS' : 'STOP', note: problems.join(' | ').slice(0, 800) }]);
    ev.finalize(run);
    expect(problems).toEqual([]);
  });
});
