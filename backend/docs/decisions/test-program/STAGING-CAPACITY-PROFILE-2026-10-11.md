# Staging-like capacity profile (reproducible; NOT executed)

Status: **PREPARED, NOT RUN.** No hosting, staging or production host was accessed or provisioned. Running this profile requires (1) an authorised staging-like environment and (2) the name of the person authorising load against it (`CAPACITY_AUTHORISED_BY`). Hosting capacity stays **UNVERIFIED** until then.

## 1. Why a separate profile
The local T-16 figures (~31–39 req/s) come from one Node process that hosts the application *and* the load generator, sharing a 2-core laptop with PostgreSQL. The limit seen (Node ≈ 93 % of one core) is a property of that setup. A staging-like run must: put the load generator on **another machine**; run the application as it will run in production (process model, `NODE_ENV=production`, real pool settings, fsync on); and use a PostgreSQL host sized like the target.

## 2. Topology to record with every run (fill in; do not assume)
| Item | Value to record |
|---|---|
| App host | CPU model/cores, RAM, OS, Node version, process count/manager, `DB pool size` per Company |
| Database host | CPU/RAM/disk type, PostgreSQL version, `shared_buffers`, `max_connections`, `fsync`, `synchronous_commit`, same host as app? |
| Network | app↔db and loadgen↔app: same LAN/region, measured RTT |
| Load generator host | a **separate** machine; CPU/RAM; its own CPU must stay < 60 % during the run (otherwise the run is invalid) |
| Release under test | version/commit and the migration state |
| Data | number of Companies, accounts, products, rows per large table at start |

## 3. Procedure
1. Provision a **test Company** (or two) on the staging installation with: the same chart/fiscal calendar as production templates, 8 bank-type treasury accounts each mapped to its own GL account, 40 products, 1 warehouse, 1 customer with a large credit limit, opening funding per account via a non-emitting cash-in (record it).
2. Create a TEST user with the roles needed (finance + inventory); obtain a bearer token for it; place it in `CAPACITY_TOKEN` on the load-generator machine only (never in files or logs).
3. Write `fixture.json` (ids of the test Company objects, plus the header(s) the target needs to select the Company):
   `{ "companies": [ { "header": { ... }, "customerId": "…", "warehouseId": "…", "accounts": ["…"], "products": ["…"] } ] }`
4. On the load-generator machine: `CAPACITY_BASE_URL=https://<staging>/api CAPACITY_TOKEN=… CAPACITY_FIXTURE=fixture.json CAPACITY_AUTHORISED_BY="<name>" node tools/testing/capacity-loadgen.js --scale 1 --out result.json` (profile: `tools/testing/capacity-profile.json`; use `--scale 20` for the 30-minute sustained phase of the proposed targets).
5. While it runs, sample from the app and database hosts (CPU %, RSS, DB connections, `pg_stat_activity` waiting locks, outbox backlog — query below) every 2–5 s and save the series.
6. After the run, execute the integrity oracle (below) on the target and save the output.
7. Return: `result.json`, resource series, oracle output, topology table. A run is valid only if the load generator stayed below 60 % CPU.

## 4. Integrity oracle (read-only SQL, per test Company database)
```sql
-- opening funding F per account must be known; successful movements are in the tables below.
-- 1. treasury balance per account (compare to F ± successful cash-in/out/payments counted by the load generator)
SELECT "treasuryAccountId", sum(CASE WHEN type IN ('cash_in','transfer_in') THEN amount ELSE -amount END) AS balance FROM treasury_transactions GROUP BY 1;
-- 2. no negative stock
SELECT "warehouseId","productId", sum(quantity) FROM stock_movements GROUP BY 1,2 HAVING sum(quantity) < 0;
-- 3. all financial events posted, journals balanced
SELECT status, count(*) FROM accounting_financial_events GROUP BY 1;
SELECT "journalEntryId" FROM accounting_journal_lines GROUP BY 1 HAVING sum("debitBase") <> sum("creditBase");
-- 4. outbox backlog and failures
SELECT status, count(*) FROM event_outbox GROUP BY 1;
-- 5. duplicate effects: same reference more than once for load-generator references
SELECT reference, count(*) FROM customer_payments WHERE reference IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
-- 6. audit chain: run the application's own verification (AuditService.verifyCompanyChain) or the admin endpoint for the Company
```
Interpretation: any row from queries 2, 3 (second statement), 5; any `failed` in 4; any non-`POSTED` status after the backlog drains; or a balance not equal to funding ± successes = **FAIL-DEFECT** (stop, preserve evidence).

## 5. Reporting
Use the same table as T-16 (phase, users, requests, 2xx, errors, req/s, p50/p95/p99, CPU, DB connections) plus the topology and the verdict against the **approved** targets (once approved). Until the targets are approved the result is a measurement only.

## 6. Scope, safe limits, abort criteria and evidence retention (added 2026-10-14; plan only — no load test is authorised or run)
**Scope.** Only the approved staging-like host, only test Companies created for the run, only the separate load-generator machine; never production, never a real Company database. A named `CAPACITY_AUTHORISED_BY` person must exist before any request is sent.
**Prerequisites (all must hold; otherwise the capacity gate stays BLOCKED):** signed workload assumptions and targets (`CAPACITY-WORKLOAD-ASSUMPTIONS-AND-PROPOSED-TARGETS-2026-10-10.md` §1, §3 — today proposals); staging-like host; separate load generator; named authoriser; topology table (§2) filled; release and migration state pinned to a commit.
**Safe limits.** Start at `--scale 1`, step up only after the previous step meets the approved latency and error targets; the 1,000-user profile is reported only. No more than the approved concurrency; no run outside the authorised window.
**Abort immediately (stop the generator, keep the system as is, preserve evidence) when any of:** a FAIL-DEFECT indicator of §4 (negative stock, unbalanced journal, duplicate effect, `failed` outbox row, non-`POSTED` financial event after drain, audit-chain verification failure); error rate above the approved budget for 60 s; app or DB CPU above the approved ceiling for 2 min; DB connections above 80 % of `max_connections`; memory growth beyond the approved ceiling; load-generator CPU above 60 % (run invalid, not a product result); the authoriser or environment owner orders a stop.
**Monitoring.** The series of §3 step 5 (CPU, RSS, connections, waiting locks, outbox backlog, audit-sequence lag) sampled every 2–5 s on app and database hosts; saturation indicators: lock waits on the audit chain and hot accounts, pool exhaustion, checkpoint pressure.
**Recovery expectation.** After the 3× peak, latency back within target in ≤ 2 min, no stuck locks or transactions, outbox drained, oracle clean.
**Evidence retention.** `result.json`, resource series, oracle output, topology table, the exact commit and migration state, the authoriser's name and time window — stored with a `MANIFEST.sha256` under an evidence folder named for the commit. Measured figures and estimates are labelled separately; estimates are never substituted for a measurement. Until all of this exists the capacity test is **NOT RUN — BLOCKED (targets, host, load generator, authoriser)**.
