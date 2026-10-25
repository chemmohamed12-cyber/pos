# Gate B-1 — HR employee↔user link hardening (same-Company membership) — 2026-10-25

**Authorization:** CTO decision "C16 Resolution, Contract Closure & Controlled GO" — B-1 conditional GO (after T-1; "implement only the approved HR employee-user link hardening within the authorized HR files; enforce same-company membership on the server; test positive, negative and cross-company cases; preserve existing HR behaviour; stop on scope expansion or regression").
**Branch:** `feature/hr-b1-user-link-membership` (from `docs/hr-payroll-integration-audit` @ `fab31f3`). Not merged, no release, no migration, no database change outside the disposable test databases.

## 1. Condition check
| Condition | State |
|---|---|
| T-1 passed | **Partially**: the runnable scope passed (tsc + HR/Attendance isolation 11/11); the 3 ambient functional suites are BLOCKED by the DB guard (`evidence-t1-2026-10-25/T-1-BASELINE-REPORT.md`). Treated as satisfied for B-1 because the regression net that exercises `linkUser` (HR isolation spec) ran and passed; recorded as a judgement, open to the CTO's veto |
| Exact scope confirmed | Taken from the directive text: **membership enforcement on the link only**. Items from the closure report's B-1 list that the directive does **not** name were **not implemented**: B1-b candidate directory + UI picker, B1-c `unlink`, B1-d leave-on-behalf guard |

## 2. Change (3 source files, `backend/src/domains/hr/**` only)
| File | Change |
|---|---|
| `application/hr.service.ts` | `linkUser(..., manager?, companyId?)`; new private `assertActiveCompanyMember`: with a Company `manager`, `companyId` and the membership source are **required** (fail closed → 500 `InternalServerErrorException`) and the user must have an **active** `Membership` in that Company (`MembershipService.findActiveByUserAndCompany`: status `active`, unexpired) else `ConflictException` (409). Ambient mode (no `manager`) is unchanged. Audit `hr.employee.user_linked` now also records `membershipId`. `MembershipService` is an `@Optional()` trailing constructor parameter so existing manual constructions compile |
| `interface/hr.controller.ts` | passes `req.companyContext!.companyId` (the server-resolved Company, never a client value) |
| `interface/hr.company-isolation.spec.ts` | constructor gets `h.memberships`; existing link test extended; one new test (below) |

No new module wiring (`HrModule` already imports `CompanyModule`, which exports `MembershipService`), no permission node, no migration, no schema change, no other domain touched. Dependency direction unchanged.

## 3. Tests (what exists, what ran)
| Case | Where | Result |
|---|---|---|
| Negative: no membership anywhere → 409, employee stays unlinked | isolation test 3 | PASS |
| Cross-Company: member of A only cannot be linked in B → 409, B employee unlinked | isolation test 3 | PASS |
| Positive: active member links in A | isolation test 3 | PASS |
| Positive: same person member of both Companies links in each independently (existing behaviour kept) | isolation test 3 | PASS |
| Duplicate link still 409 (existing) | isolation test 3 | PASS |
| `invited` / `suspended` / `removed` membership refused | new test "B-1 …" | PASS |
| Fail closed: Company manager without `companyId`; and no membership source configured → 500 | new test | PASS |
| Refusals write nothing (employee `userId` null, 0 `user_linked` audit rows) | new test | PASS |
| Success writes exactly 1 audit row containing the membership id | new test | PASS |
| Other Company's employees untouched | new test | PASS |

**Commands (snapshot `D:\s\t1\backend` = tree of this branch's working copy at the time; node_modules junction; cluster 5546, namespace `biz_t41_`):**
1. `tsc -p tsconfig.build.json` → exit 0 (13 s); `tsc -p tsconfig.json --noEmit` (includes specs) → exit 0 — **PASS**
2. `eslint` on the 3 changed files → no findings — **PASS**
3. `REGRESSION_NS=biz_t41_ node tools/testing/biz-run.js --regression tools/testing/b1-regression.txt` (list in snapshot only) 19:42:43 → 19:45:06 (+03:00): **5/5 suites PASS** — HR 7/7 (6 existing + 1 new), Attendance 5/5, Commission 5/5, Payroll 5/5, Targets 3/3 (those four construct `HrService` or call into it; run as the regression net). Log: `b1-regression-run.log`. No `daii_test_biz_t41_*` database left afterwards.
After the run only a doc-comment was moved in `hr.service.ts` (re-checked with tsc + eslint, DB suites not re-run; code identical).

## 4. Not done / not verified (stated plainly)
- **Red-first not executed:** the new assertions were not run against the pre-change service (it has no 9th constructor parameter, so the spec would not compile against it). The pre-change behaviour is established by reading the old `linkUser` (it checked only that the user existed).
- `hr-phase1.spec.ts` (ambient mode link/duplicate checks) and `commission-phase1`/`payroll-phase1`/E2E specs that call `linkUser` **without** a manager: **NOT RUN** (ambient DB blocked by the guard). They exercise the unchanged ambient path; compile checked by `tsc` only.
- No HTTP/controller-level test of the 409/500 mapping or of the route; no browser check. The UI is unchanged: it still loads candidate users from `/admin/users` (known gap G-09, out of B-1 scope) and now simply receives a 409 for a non-member.
- `kind = 'support'` memberships count as members (same as access decisions do). Whether support-kind users may be linked to employees is a policy question — raised, not decided.
- Existing links created before B-1 are not re-validated (no data migration, by design).

## 5. Rollback
Code-only revert of the branch (`git revert`/drop the commit). No schema/data to undo; links created while B-1 was active are valid links and stay.

## 6. Stop conditions encountered
None triggered: no scope expansion beyond the link, no regression in the executed suites, no tenant-isolation failure.
