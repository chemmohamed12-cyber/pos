# DAII — Quality Scorecard (Team 3 Independent Product Audit) — 2026-10-11

Deliverable 5 of 6. **No numeric rating is given.** The 9.5/10 ambition is a target, not a claim about current quality, and no agreed scoring method exists in the repository; the directive forbids a numeric rating without one and requires NOT ASSESSED where data is insufficient. This scorecard therefore reports an **evidence-maturity level per dimension**, with its basis, its limiting factor and its unverified areas, and proposes a method for the CTO to agree (§7). The overall figure is **NOT COMPUTED**.

**Baseline.** Audit cutoff 2026-10-11, HEAD `b591d1f`; evidence baseline `a6002fa` (last complete clean-snapshot verification). The N-02 fix and LA-1 Layer 2 made after `a6002fa` have no complete clean-snapshot verification (PA-42). Findings `PA-xx`: register; capability rows: matrix. Independent and read-only; no test was run by Team 3.

## 1. Evidence-maturity scale (used in place of a score)

| Level | Name | Meaning |
|---|---|---|
| **L0** | NOT ASSESSED | No evidence, not examined |
| **L1** | Exists | Code or document exists; no verification found |
| **L2** | Partially verified | Some specs, dated walkthroughs or code reading; key scenarios, concurrency, end-to-end or UI behaviour uncovered, or a known defect open |
| **L3** | Verified for stated scenarios | Scenario-level tests with oracle or numeric assertions passed on a named commit (clean snapshot) for the scenarios the row states |
| **L4** | Verified and protected | L3, plus an automated gate that re-runs it on every change (CI incl. real-Postgres) and independent review |

No dimension reaches L4: CI has never run on a hosted runner and has no real-Postgres job (PA-22), and independent review is partial (the N-01 review was by the code author).

## 2. Scorecard by dimension

| # | Dimension | Level | Basis (commit-tagged) | Limiting factor / unverified | Findings |
|---|---|---|---|---|---|
| 1 | Financial integrity — primitives (treasury, payments, valuation, sub-ledger agreement for covered flows) | **L3** | T-05, T-06/08, T-01/03, T-10 (R1–R10), T-16 integrity — clean snapshot `a6002fa` | Covered flows only; payroll is not in the oracle | PA-32, PA-34 |
| 2 | Financial integrity — HR/payroll seam | **L1–L2** | Code read: posting excludes commission, disbursement posts nothing, float arithmetic; integrated spec BLOCKED and does not assert amounts | Runtime effect not demonstrated; no clean-snapshot evidence for payroll/commission/attendance | PA-34, 35, 36, 17 |
| 3 | Financial integrity — statements, period/year-end, FX, tax | **L2** | Code reading; isolation and closing specs | No golden fixtures; year-end is a status lock | PA-32, 10, 11, 15, 39 |
| 4 | Audit-trail integrity | **L2** | Concurrent appends keep one chain (T-03/T-13/T-14 CS:`a6002fa`) | **Confirmed rollback defect** (T-22, WT:`ce924e2`+dirty) | PA-33 |
| 5 | Multi-company data isolation | **L3** | 80 isolation specs PASS (WT), two-Company business suite and HTTP run CS:`a6002fa` | 19 provisioning/pool/fan-out/restore specs NOT RUN; LA-1 Layer 2 on 3 of 10 sites | PA-22, 41 |
| 6 | Authorization correctness | **L2** | F1–F6 reports, T-09 36 assertions CS:`a6002fa`, isolation specs | Four controllers pending hand review; F-INV-001 compatibility; CTO items; salary-data scope unverified | PA-29 |
| 7 | Concurrency — numbering and transitions | **L3** | T-17/T-19 CS:`a6002fa` (200/200, capped transitions, 80/80 ×4, HTTP 120/120) | Closure recorded for local scope, sign-off pending; other sites by construction; multi-instance not run | PA-21 |
| 8 | Concurrency — inventory reservation, limits, shipments | **L2** | T-01…T-04 PASS; T-20 FAIL-DEFECT CS:`a6002fa`; fulfil fix verified by the implementing track (T-21, WT) | Delta has no clean-snapshot; release/limit races open; shipment transitions never probed | PA-04, 05, 42 |
| 9 | Concurrency — GL posting | **L2** | F03 retry verified at `9c746aa`; T-10/T-16 PASS CS:`a6002fa` | Retry mitigates, lock order deferred; not re-tested after N-01 | PA-13 |
| 10 | Functional completeness vs the ten audited scenarios | **L2** | Report §4: none verified end to end | Missing steps in five scenarios; no chain tests | PA-01, 03, 08, 09, 16 |
| 11 | HR–Accounting integration completeness | **L2** | Integration assessment §4: 17 hops; 14 implemented (with gaps), 1 partial (I-14), 2 absent (I-12, I-13) | Seam defects; BLOCKED E2E | PA-17, 34, 35, 37, 38, 40 |
| 12 | Test effectiveness | **L2** | Strong harness and oracle; historical escapes (Q-01); N-02 and PA-33 found by purpose-built probes, not existing tests | Probes not yet permanent gates; 19 specs unrun; 42 classes without spec by name | PA-22, 03 |
| 13 | Frontend quality | **L1–L2** | `tsc -b`, build, oxlint; manual browser acceptance on isolated environments (records) | Zero automated tests | PA-23 |
| 14 | Architecture maintainability | **L2** | Strict TS, contracts, layering (TEST-03 metrics) | 19 concrete imports, one large cycle, five services > 1,000 lines | PA-28 |
| 15 | Security posture (application) | **L2** | Controls read; some live-checked (dated); D-01 audit `d51a751` | 65 advisories, 15 runtime-reachable; no pen test; host hardening unverified | PA-25 |
| 16 | Operational readiness (release, deploy, rollback) | **L1–L2** | Release engine exists; incident history; verification report: NOT APPROVED | No hosting evidence; largest service unreferenced by specs | PA-26 |
| 17 | Backup / restore / DR | **L0–L1** | August development-database procedure; product restore specs NOT RUN | Not exercised through the product | PA-30 |
| 18 | Scalability and capacity | **L0 against targets** (measurements exist) | T-16 plateau ~31–39 req/s on a 2-core laptop | No approved targets, no hosting, no multi-instance | PA-24, 18 |
| 19 | Observability | **L1** | logger, health, metrics services exist | Alerts, dashboards, SLOs not found | PA-30 |
| 20 | Documentation and handover | **L2** | 50 ADRs, runbooks, governing docs imported (R1); no independent dry-run | Master status file stale; no living matrix | PA-27 |
| 21 | CI and reproducibility | **L2** | Clean archive → install → build → lint → unit → guard PASS locally; `a6002fa` unit 59/430, guard 50/50 | Never run on a hosted runner; no real-Postgres job | PA-22 |
| 22 | Provenance and IP | **L1** | History from 2026-09-18, single identity; licence undefined | Not a Team 3 domain; cross-referenced | TEST-03 P-01, L-01 |

## 3. Counted evidence (no weighting; classes never summed)

| Measure | Value | Source | Commit / class |
|---|---|---|---|
| Capability rows | 88: Implemented 60 · Partial 7 · Specified-not-implemented 12 · Not implemented 9; Verified 5 · Partly 53 · Unverified 6 · Blocked 1 · Not assessed 23 | matrix §6 | cutoff `b591d1f` reading; evidence per row |
| Findings | 42: High 12 · Medium–High 6 · Medium 20 · Low–Medium 1 · Low 3; missing 13 · evidence-gap 11 · confirmed-by-reading 7 · confirmed-tested 5 · debt 3 · suspected 3 | register | — |
| Business suite on the evidence baseline | T-00…T-20 sequential run exit 0; T-19 15/15; R1–R10 PASS | reconciliation §4 | CS:`a6002fa` |
| N-02 probes | 6 FAIL-DEFECT, 2 PASS, 1 BLOCKED (before the fulfil fix) | reconciliation §4 | CS:`a6002fa` |
| Fulfil-reservation integrity spec | cases A–G PASS, case H (audit chain after rollback) FAIL-DEFECT | N-02 report §4 | WT (working tree on `ce924e2`) |
| Audit rollback reproducer | control PASS; after one rolled-back audit write the chain is invalid | N-02 report §6 | WT:`ce924e2`+12 dirty paths |
| Schema drift probe T-18 | 3 FAIL-DEFECT (naming/default drift) | reconciliation §4 | CS:`a6002fa` |
| Real-Postgres isolation specs | 80 PASS · 1 BLOCKED · 19 NOT RUN | verification report §2 | WT with namespace mechanism |
| Unit / guard | 59 suites, 430 tests / 50 of 50 | reconciliation §4 | CS:`a6002fa` |
| Frontend automated tests | 0 | `find` over `frontend/src` | HEAD |
| Dependency advisories | 65 backend (3 critical, 44 high), 3 frontend; 15 runtime-reachable backend packages | D-01 | working tree at `d51a751` |
| Capacity | ~31–39 req/s plateau, 10,495 requests, 0 errors, oracle PASS | verification report §3 | WT-era T-16; assertions PASS again CS:`a6002fa` |
| Size | ~81 k production LOC, 681 files, 288 migrations, 75 controllers / 616 routes, 212 specs, 50 ADRs | TEST-03 | `e9be53a` metrics |

## 4. NOT ASSESSED (data insufficient)

Hosting and production behaviour; capacity against targets; product-level backup and restore; DR objectives; alerting; penetration test; legal licence position; frontend code quality beyond counts; accessibility and RTL visual review; migration of the client's legacy spreadsheets; multi-instance behaviour; jurisdictional compliance (e-invoicing, statutory payroll); runtime behaviour of the CONFIRMED-BY-READING items (PA-34, 35, 36, 37, 39).

## 5. What would raise each dimension (closure-oriented, not a work order)

| Dimension | To reach L3 | To reach L4 |
|---|---|---|
| 2 HR/payroll seam | Disbursement and posting-amount correctness, payroll in the oracle, chain test with ledger and treasury assertions (HRX-1, HRX-3) | Chain test in CI |
| 3 Statements, year-end, FX, tax | Golden fixtures plus oracle extension; year-end decision | Fixtures in CI |
| 4 Audit trail | PA-33 fix; T-22 PASS on a clean snapshot | Rollback probe in CI |
| 6 Authorization | Hand review recorded; D-9 evidence; CTO items decided | Role × route matrix in CI |
| 8 Reservation/limits/shipments | Independent review and clean snapshot of the fulfil fix; N-02 remainder; shipment probe | Probes as permanent jobs |
| 9 GL posting | F03 retry re-run after N-01; lock-order decision | Nightly concurrency job |
| 10, 11 Scenarios and integration | Chain test per scenario on a clean snapshot; missing steps implemented | Chain tests in CI |
| 13 Frontend | Component tests and short browser E2E per phase path | Run in CI |
| 15 Security | T1 dependency fixes plus re-audit; host proxy check | Audit step in CI |
| 16 Operations | Staging host, rollback and restore drills | Drills repeated per release |
| 18 Scalability | Approved targets, staging profile, soak, multi-instance | Periodic capacity job |
| 20 Documentation | Independent dry-run from the repository alone | Doc-link check already in CI |

## 6. Reading rules

1. A level is the weakest honest description of the evidence for the whole dimension; a strong sub-area does not lift it.
2. L3 is always "for the stated scenarios on that commit"; a later commit that changes the code needs the evidence repeated (rows 8 and 4 are lowered by exactly this).
3. Open confirmed defects keep a dimension at L2 or below even when most tests pass (rows 4, 8, 9).
4. CONFIRMED-BY-READING findings cap the dimension at L2 until demonstrated and fixed.
5. Team 3 ran no test to produce this scorecard.

## 7. Proposed rating method (for CTO agreement before any numeric score is issued)

**Status of this method: PROPOSED — NOT REVIEWED, NOT APPROVED.** Dimension weights are not set, coverage rules are a draft, and no approver is named. Until the CTO reviews and approves the method (weights, coverage rules, named approver) no overall numeric quality score is issued, in this or any other document.

1. Fix the dimension list and weights **before** looking at results, with a named approver.
2. Score each dimension from its evidence-maturity level (L0 = 0 … L4 = 4) multiplied by a **coverage factor**: the share of the dimension's required scenarios with evidence at that level (denominator = the scenario list in the matrix and report §4).
3. Any open High finding in a dimension caps it at L2 until closed or accepted in writing.
4. Never average across dimensions with different evidence classes; report the minimum and the median beside any weighted figure.
5. Require a clean-snapshot, commit-pinned evidence bundle for each L3 claim, reviewed by someone other than the author of the changed code; re-score after every phase gate.
6. A 9.5-style target is meaningful only after steps 1–5 are agreed; until then the honest statement is the categorical table in §2.

## 8. Consistency check (internal)

Dimension findings cited exist in the register (42); counts match the matrix (88 rows) and the register (42 findings); the commit used for each evidence line is the one stated in the reconciliation record or finding; N-01 appears as closure recorded by its owner for the local scope with sign-off pending (row 7), not declared by Team 3; N-02 as not closed (row 8); no numeric overall figure appears in any of the six deliverables.
