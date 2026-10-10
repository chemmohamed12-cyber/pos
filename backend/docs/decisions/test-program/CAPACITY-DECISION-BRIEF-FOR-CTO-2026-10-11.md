# D-10 — Capacity decision brief (one decision requested)

Status: **PROPOSAL FOR APPROVAL.** Nothing below is an approved requirement; T-16 is **not** labelled PASS or FAIL. Detail and rationale: `CAPACITY-WORKLOAD-ASSUMPTIONS-AND-PROPOSED-TARGETS-2026-10-10.md`; reproducible staging profile: `STAGING-CAPACITY-PROFILE-2026-10-11.md` + `tools/testing/capacity-loadgen.js`; event-outbox behaviour: `EVENT-OUTBOX-DISPATCH-BEHAVIOUR-2026-10-11.md`.

## A. Measured facts (local, 2-core laptop, app + load generator + PostgreSQL on one machine, fsync off)
| Fact | Value |
|---|---|
| Requests / errors | 10,495 HTTP requests, 0 non-2xx; integrity oracle PASS for both Companies; R1–R10 PASS |
| Throughput | 31–39 req/s from 5 virtual users upward (flat) — Node process ≈ 93 % of one core |
| Latency (mixed workload) | p95: 345 ms at 5 users · 771 ms at 10 · 1.9 s at 25 · 3.8 s at 50 · 5.8 s at a 60-user peak; p99 up to 9.2 s |
| Hot account/product vs spread | ~20 % lower throughput on one hot resource at 25–50 users |
| Recovery | p95 back to 280–350 ms in the first 5 s window after the peak |
| Single-path service-level rates (T-15) | audit ≈ 200/s, cash-out ≈ 200/s, reservation ≈ 200/s, on-account payment ≈ 75/s |
| Memory | process RSS +19 % over 5 min (harness included); leak not shown nor excluded |
**Not established:** any hosting figure; behaviour above 60 virtual users; a 30-minute soak; separate load generator; multi-instance.

## B. Assumptions (the agent's, not business requirements) — please confirm or replace
| # | Assumption | Proposed value |
|---|---|---|
| 1 | Companies on one installation | 2 now, 5 next profile |
| 2 | Warehouses / treasury accounts per Company | 3 / 5–8 |
| 3 | Concurrent active users (a write every 10–30 s) | **50** (Profile S) and **200** (Profile M); 1,000 is listed in the earlier plan but has no source |
| 4 | Resulting write rate | S: 2–5 writes/s · M: 7–20 writes/s · 3× peak for 15 min at month-end/end-of-day |
| 5 | Mix | 35 % payments · 20 % stock receipts/warehouse steps · 25 % treasury cash · 20 % reads (see profile) |
| 6 | Data volume per Company | 2,000 products · 500 customers · 50k stock movements · 50k audit rows |
## C. Proposed requirements (to approve as acceptance targets)
| Target | Proposed |
|---|---|
| Integrity under load | 0 duplicate financial effects · 0 unexplained reconciliation differences · audit chain valid · no negative stock |
| Errors | 0 at target rate; ≤ 0.1 % transient at 3× peak |
| Write latency (server side, target rate) | p50 ≤ 300 ms · p95 ≤ 1 s · p99 ≤ 2 s; reads p95 ≤ 500 ms |
| Throughput | Profile S ≥ 5 writes/s for 30 min · Profile M ≥ 20 writes/s for 30 min and ≥ 60 writes/s for a 15-min peak |
| Hot resource | ≥ 30 ops/s per account/product/audit chain with p95 ≤ 1 s |
| Resources | CPU ≤ 70 % · memory growth ≤ 10 % per 30 min · DB connections ≤ 60 % of max |
| Recovery / degradation | latency back in target ≤ 2 min after load drops; beyond capacity requests slow or are refused cleanly, never partial or duplicate effects |
Relation to the measurements (information only): the local setup already shows p95 345 ms at 5 users and ~35 req/s; Profile S (2–5 writes/s) is well inside what was measured, Profile M (7–20 writes/s) is inside the measured throughput but the p95 ≤ 1 s target was met only up to ~10 users here; whether hosting meets either profile is unknown until the staging run.

## D. Decision requested (reply with one line)
1. **Approve / replace** assumptions B1–B6.  2. **Approve / replace** targets in C.  3. **Provide** an authorised staging-like host and a separate load-generator machine (or state that hosting capacity is out of scope).  4. Name the **approver** who may authorise load against it (`CAPACITY_AUTHORISED_BY`).
After approval, T-16 results are re-reported against the approved targets as PASS/FAIL per target.
