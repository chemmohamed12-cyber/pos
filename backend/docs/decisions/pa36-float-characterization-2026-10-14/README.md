# PA-36 — JavaScript Number arithmetic in payroll totals: standalone characterization — 2026-10-14

`pa36_float_sums.js` replicates the exact expression the payroll service uses for run totals (`lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2)` — `payroll.service.ts` lines 297, 381, 455, 456, 570) over synthetic cent-valued strings (every payroll amount column is `numeric(14,2)`) and compares it with exact integer-cent arithmetic. Deterministic (fixed seed), Node v20.20.2, no database, **no product code executed, no payroll run**: it measures the Number idiom, not the payroll module, and says nothing about any real run.
| Scenario (synthetic) | Runs | Runs with wrong cents | Max error before rounding | Largest exact total |
|---|---|---|---|---|
| 12 lines (the WP-PAY-01 shape) | 5000 | **0** | 2.9e-11 | 91,880.83 |
| 200 lines | 5000 | **0** | 2.8e-9 | 2,291,920.73 |
| 10,000 lines up to 50,000 | 400 | **0** | 2.1e-6 | 254,342,549.92 |
| 100,000 lines up to 100,000 | 40 | **0** | 1.4e-4 | 5,021,710,441.14 |
| 1,000,000 lines up to 100,000 | 8 | **0** | 2.3e-3 (about half of the 0.005 limit) | 50,049,390,449.10 |
| 1,000,000 lines up to 9,999,999 | 4 | **4 of 4** | 0.26 | 4,999,935,665,485.40 |
**Reading.** For run totals up to about 5×10^10 in these distributions the idiom produced no wrong cent; the error bound grows with the total and crosses the 0.005 rounding limit at totals of the order of 10^12. No plausible payroll run is that large, so the idiom is **not shown to produce a visible cent drift at realistic scale** — but it is also not exact (the margin shrinks as the total grows, and there is no decimal library or integer-cent type). Not measured here: per-line rounding of computed percentages (payroll computes none today — deductions are fixed-amount lines, PA-16), the commission module's own arithmetic, and any other module. PA-36 therefore moves from "not assessed at scale" to **measured for the sum idiom; open as design debt** (decision: accept for the current scale, or move to integer cents/decimal with the H0-4 posting work — a policy/engineering decision, not made here).
Re-run: `node pa36_float_sums.js > result.json` (about a minute).
