# DAII — Capacity: workload assumptions and PROPOSED targets (2026-10-10)

**Status: PROPOSAL — NOT APPROVED.** Nothing here is an official business requirement. Every number is labelled by origin: **VERIFIED** (read from code/config/docs), **MEASURED** (from a local test), **ASSUMED** (the agent's proposal, to be confirmed or replaced by the CTO). Capacity results are reported as measurements and are **not classified PASS/FAIL** until the targets in §3 are approved (single consolidated decision, §6).

## 1. Workload assumptions
| Item | Value | Origin |
|---|---|---|
| Deployment model | single Node process, PostgreSQL, one database **per Company** (control-plane DB + Company DBs) | VERIFIED (architecture / Release Engine) |
| Companies sharing one installation | 2 Companies in the local benchmark (the test harness provides two); 5 would be the next profile on a staging host | ASSUMED |
| Branches / warehouses per Company | 3 warehouses, 5 treasury accounts | ASSUMED |
| Data volume per Company (steady state) | 2,000 products, 500 customers, 50,000 stock movements, 20,000 ledger rows, 50,000 audit rows | ASSUMED |
| Concurrent *active* users (making a write every ~10–30 s) | 50 (Profile S), 200 (Profile M), 1,000 listed in the earlier plan (D-10) | ASSUMED; the 50→1,000 range has no approved source |
| Write rate implied | 50 users ≈ 2–5 writes/s; 200 users ≈ 7–20 writes/s; 1,000 users ≈ 35–100 writes/s (across all Companies) | derived from the line above |
| Operation mix (writes) | 35 % stock reservation / warehouse-document steps, 25 % customer payments & collection, 15 % treasury cash movements, 15 % invoices/orders, 10 % other; every write also writes an audit row | ASSUMED |
| Read/write ratio | 80 % reads, 20 % writes | ASSUMED |
| Peak periods | month-end / end-of-day batches: 3× the average write rate for 15 minutes | ASSUMED |
| Acceptable response time | interactive writes ≤ 1 s p95; reads ≤ 500 ms p95 | ASSUMED (typical ERP expectation) |
| Local test machine | i7-7600U 2C/4T, 15.9 GB, PostgreSQL 18 on the same host, fsync=off, autovacuum=off | MEASURED/VERIFIED |
| Hosting topology / sizing | unknown | **not verified** |

## 2. What the local benchmark can and cannot claim
It can: show correctness under concurrency (no duplicate financial effect, exact balances, intact audit chain, clean reconciliation), expose lock-contention shape (hot account/product/audit chain), and give relative cost per operation. It cannot: predict hosting capacity (different CPU, disk with fsync, network, pool sizes, co-located services), and does not model real users (think time, reads, browsers).

## 3. Proposed targets (to approve in one decision)
| Target | Proposal | Rationale |
|---|---|---|
| Correctness under load (all profiles) | 0 duplicate financial effects, 0 unexplained reconciliation differences (R1–R10), audit chain valid, no negative stock, no unauthorized inventory outcome | non-negotiable integrity; unrelated to speed |
| Error rate | 0 % errors for business operations at ≤ the target rate; ≤ 0.1 % transient (timeouts) at the 3× peak | an ERP must not lose or duplicate money |
| Write latency (HTTP, server-side) at target rate | p50 ≤ 300 ms, p95 ≤ 1 s, p99 ≤ 2 s | interactive use |
| Read latency | p95 ≤ 500 ms | interactive use |
| Throughput, Profile S (50 users) | ≥ 5 writes/s overall sustained for 30 min | from §1 |
| Throughput, Profile M (200 users) | ≥ 20 writes/s sustained 30 min; ≥ 60 writes/s for the 15-min peak | from §1, 3× peak |
| Single hot resource (one account / one product / audit chain per Company) | ≥ 30 ops/s each, with p95 ≤ 1 s | the audit chain is one serialization point per Company |
| Resource ceilings during sustained load | app CPU ≤ 70 %, DB CPU ≤ 70 %, memory growth ≤ 10 % over 30 min (no leak), DB connections ≤ 60 % of `max_connections` | headroom for peaks |
| Recovery | after a 3× peak, latency back within target ≤ 2 min after load drops; no stuck locks/transactions; outbox drained | operational resilience |
| Degradation | past capacity, requests slow or are rejected cleanly (429/503), never partial or duplicate effects | safety over speed |
| 1,000-user profile | measured and reported only; not a target until a sizing decision exists | no source (D-10) |

## 4. Test design (what was built/run locally)
See `T-16` (`src/foundation/testing/t16-capacity-http.biz.real-pg.spec.ts`, results in `FINAL-VERIFICATION-AND-RELEASE-READINESS-REPORT-2026-10-10.md`): HTTP end-to-end (real controllers, guards, validation and filters; auth and company-resolution doubles), several Companies and many accounts/products vs a single hot resource, stepped concurrency, a sustained phase, a controlled peak phase, a recovery phase, resource sampling (CPU/memory of node and postgres, connection counts), and the same integrity oracle after the run.

## 5. Hosting-like profile (reproducible, not executed)
`tools/testing/capacity-profile.json` records the parameters of the benchmark (companies, accounts, products, mix, phases, durations, thresholds as *proposed*), so the identical run can be repeated on an authorised staging host: install the release, provide an approved database cluster and role, set `CAPACITY_PROFILE` and run the runner. Hosting capacity stays **UNVERIFIED** until that is authorised (no access to hosting/production/shared databases was used).

## 6. Decisions needed from the CTO (single consolidated decision)
1. Approve or replace the workload assumptions in §1 (users, Companies, data volume, mix, peak factor).
2. Approve or replace the targets in §3 (latency, error budget, throughput, resource ceilings).
3. Provide an authorised staging/hosting-like environment for the profile in §5 (or confirm that hosting capacity is out of scope for this program).
