# Live-app endpoint proof (companion to the scripted rehearsal)

A second, independent rehearsal on an isolated PostgreSQL 18 cluster
(port 55432) that additionally **boots the real NestJS app** and exercises
the two failing HTTP endpoints before and after the repair. The scripted
`scratch-rehearsal.ts` proves `@IsUUID()` via `validateSync`; this proves
it through the full HTTP → DTO → service → DB path against a running server.

## Legacy ids injected (this run)

| Table | Legacy id (non-RFC4122) |
|---|---|
| `treasury_accounts` (A-10001) | `0a066947-1794-9892-6816-35f51ddf72c0` |
| `treasury_accounts` (MAIN-CASH) | `c0ffee00-dead-c0de-beef-000000000001` |
| `treasury_account_types` (cash) | `fa11bad0-1111-f222-6333-444455556666` |
| `users` (rehearsal admin) | `badf00d0-2222-c333-d444-555566667777` |

## BEFORE repair — booted app, authenticated as the (legacy-id) admin

```
POST /api/treasury/cash-in   {"accountId":"c0ffee00-dead-c0de-beef-000000000001","amount":"500"}
  -> 400  {"code":"VALIDATION_ERROR","message":["accountId must be a UUID"]}

POST /api/deposits/<id>/approve   {"treasuryAccountId":"0a066947-1794-9892-6816-35f51ddf72c0"}
  -> 400  {"code":"VALIDATION_ERROR","message":["treasuryAccountId must be a UUID"]}
```

Exact reproduction of the production symptom.

## Repair — `uuid-repair.core` (audit → plan → repair-in-one-txn → verify)

```
audit:      4 non-compliant PKs across treasury_accounts(2), treasury_account_types(1), users(1)
mapping:    4 old→new pairs, every new id RFC4122
repair:     4 rows, one transaction
integrity:  PASS — 0 orphans (DB-enforced + soft/hidden FK sweep), 0 remaining non-compliant, credentials + 2 role rows still resolve for the repaired user
```

## AFTER repair — re-login (new user id), re-test

```
GET  /api/treasury/accounts
  -> 200  A-10001 id = bea47d9e-…  ·  MAIN-CASH id = 654ff9cc-…  (both RFC4122, accountTypeId resolves to "cash")

POST /api/treasury/cash-in   {"accountId":"654ff9cc-e930-43f2-8657-3ac31e561304","amount":"500", …}
  -> 201  {"success":true, transactionNumber:"TRS-IN-2026-000001", type:"cash_in", status:"posted", …}

POST /api/deposits/<real deposit>/approve   {"treasuryAccountId":"bea47d9e-a3b2-485e-9a73-b62767f37966"}
  -> 201  {"success":true, status:"approved", reviewedByUserId:"7c00e194-…"}
      side effects verified in DB:
        treasury_transactions  TRS-IN-2026-000002  cash_in 1000  depositId linked  status posted
        customer_ledger_entries  deposit / credit / 1000  treasuryTransactionId set
```

## Full-DB census after all app activity

```
auditNonCompliantUuids() over all 52 PK tables  ->  totalNonCompliant = 0
```

Every record the app created during the tests also got a compliant id —
confirming the generation fix (`1755852500000`) works in tandem.

## Rollback

```
pg_restore --clean --if-exists  pre-repair.dump
  -> treasury_accounts / users / types back to their legacy ids
  -> row counts identical to pre-repair
```

## Environment

Node **v26.7.0** (prod is 20.20.2), PostgreSQL **18** scratch cluster
(prod is 10). The real staging run is the operator's step via
`DATA_REPAIR_RUNBOOK.md` using the same `DataRepairService` flow.
