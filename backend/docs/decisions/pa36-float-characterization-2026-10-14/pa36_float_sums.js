'use strict';
/**
 * PA-36 arithmetic characterization (STANDALONE; no product code, no database, no payroll run).
 * It replicates the exact expression the payroll service uses for run totals —
 *     lines.reduce((sum, l) => sum + Number(l.netPay), 0).toFixed(2)      (payroll.service.ts: totalNet / totalGross / grossPay)
 * over cent-valued strings (every payroll amount column is numeric(14,2)) and compares the result with exact integer-cent arithmetic.
 * It measures the JavaScript Number idiom only. It is NOT a payroll test, not a statement about any real run, and uses synthetic data.
 * Usage: node pa36_float_sums.js > result.json      (deterministic: fixed seed)
 */
let seed = 20261014;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const fmt = (cents) => { const neg = cents < 0n; const c = neg ? -cents : cents; const s = c.toString().padStart(3, '0'); return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`; };
const scenarios = [
  { name: 'worked-example-12-lines', lines: 12, maxAmount: 10000, trials: 5000 },
  { name: 'small-company-200-lines', lines: 200, maxAmount: 20000, trials: 5000 },
  { name: 'realistic-large-run-10k-lines-up-to-50k', lines: 10000, maxAmount: 50000, trials: 400 },
  { name: 'stress-100k-lines-up-to-100k (total ~5e9)', lines: 100000, maxAmount: 100000, trials: 40 },
  { name: 'extreme-1M-lines-up-to-100k (total ~5e10)', lines: 1000000, maxAmount: 100000, trials: 8 },
  { name: 'extreme-1M-lines-up-to-9999999 (total ~5e12)', lines: 1000000, maxAmount: 9999999, trials: 4 },
];
const out = [];
for (const sc of scenarios) {
  let mismatches = 0; let maxAbsErr = 0; let example = null; let totalMax = 0n;
  for (let t = 0; t < sc.trials; t += 1) {
    let fsum = 0; let csum = 0n;
    for (let i = 0; i < sc.lines; i += 1) {
      const cents = BigInt(Math.floor(rnd() * sc.maxAmount * 100) + 1);
      csum += cents;
      fsum += Number(fmt(cents)); // Number("1234.56") — as read from a numeric(14,2) column
    }
    if (csum > totalMax) totalMax = csum;
    const exact = fmt(csum); const got = fsum.toFixed(2);
    const err = Math.abs(fsum - Number(exact));
    if (err > maxAbsErr) maxAbsErr = err;
    if (got !== exact) { mismatches += 1; if (!example) example = { exact, got, absErr: err }; }
  }
  out.push({ scenario: sc.name, linesPerRun: sc.lines, trials: sc.trials, totalRunsWithWrongCents: mismatches, maxAbsoluteErrorBeforeRounding: maxAbsErr, largestExactTotal: fmt(totalMax), firstMismatch: example });
}
console.log(JSON.stringify({ expression: 'lines.reduce((sum, l) => sum + Number(l.amount), 0).toFixed(2)', node: process.version, seed: 20261014, results: out }, null, 1));
