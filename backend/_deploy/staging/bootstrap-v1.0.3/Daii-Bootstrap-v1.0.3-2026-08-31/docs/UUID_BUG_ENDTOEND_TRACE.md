# "accountId / treasuryAccountId must be a UUID" — End-to-End Trace

**Status:** root cause confirmed. It is **not a code defect**. The fix for
existing data is a **Controlled Data Repair** (see `DATA_REPAIR_RUNBOOK.md`);
generation for new rows was already fixed in v1.0.3
(`1755852500000-FixGenRandomUuidRfc4122Compliance.ts`).

---

## The two failing flows

| Flow | Endpoint | Field that fails | Error |
|---|---|---|---|
| Deposit approval | `POST /deposits/:id/approve` | `treasuryAccountId` | `treasuryAccountId must be a UUID` |
| Treasury cash-in | `POST /treasury/cash-in` | `accountId` | `accountId must be a UUID` |

Both are 400s raised by `class-validator` **before the service runs**.

---

## The trace (both flows, identical shape)

```
Frontend                    treasury / deposit screen
  |                         renders <select> of accounts from GET /treasury/accounts
  |                         option value = treasury_accounts.id  (a string from the DB)
  v
Request payload             POST /treasury/cash-in
  { "accountId": "0a066947-1794-9892-6816-35f51ddf72c0", "amount": "..." }
  (deposit approve: { "treasuryAccountId": "0a066947-1794-9892-6816-35f51ddf72c0" })
  v
DTO + Validation            src/domains/treasury/interface/treasury.controller.ts  -> class CashMoveDto
                            src/domains/deposit-control/interface/deposits.controller.ts -> class ApproveDepositDto
    @IsUUID()  accountId!: string;              <-- REJECTS HERE (400)
    @IsUUID()  treasuryAccountId!: string;      <-- REJECTS HERE (400)
  |  (never reached:)
  v
Service                     TreasuryService.cashIn(accountId, ...)
                            DepositsService.approveDeposit(id, actorUserId, treasuryAccountId)
    this.dataSource.getRepository(TreasuryAccount).findOne({ where: { id: accountId } })
    -- the id is used verbatim as a lookup key. No remap. No regeneration.
  v
Entity / DB                 treasury_accounts.id  (uuid PRIMARY KEY DEFAULT gen_random_uuid())
                            treasury_account_types.id, users.id, ... — same column type everywhere
```

**Verified this session by direct source read:** the DTOs, the controller
handlers, `TreasuryService.cashIn` / `cashOut` / `createDepositTransaction`,
`DepositsService.approveDeposit`. There is no place where the id is
transformed, re-generated, or mapped to a different field. The value the
frontend submits is exactly the value stored in `treasury_accounts.id`, and
it is used exactly as a `WHERE id = $1` key.

## Why the stored value is not a valid UUID

`1755840100000-CreateUsers.ts` had to define `gen_random_uuid()` by hand —
this hosting plan has no `pgcrypto` and Postgres 10 has no core UUID
generator:

```sql
SELECT md5(random()::text || clock_timestamp()::text)::uuid;
```

That yields a **UUID-shaped** string (32 hex, hyphenated 8-4-4-4-12) but the
**version nibble** (1st char of group 3) and **variant nibble** (1st char of
group 4) are random. RFC4122 — and `class-validator`'s `@IsUUID()` — require
version ∈ `1-5` and variant ∈ `8/9/a/b`. Empirically only **~7.7%** of ids
this function produced pass (`src/database/uuid-repair.core.spec.ts` re-derives
this: `<15%` for the broken body, `100%` for the fixed body).

Every `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` row created before
`1755852500000` ran has ~92% odds of being non-compliant — **every table**,
not just treasury. Treasury/Deposit surface it because they are the one place
a server-generated id is picked from a dropdown and **submitted back** through
an `@IsUUID()` field.

## The captured evidence (prior session, live)

A live `window.fetch` interceptor on the deployed app captured the approve
payload: `{"treasuryAccountId":"0a066947-1794-9892-6816-35f51ddf72c0"}` —
correct field name, a real existing DB value, version nibble `9`, variant
nibble `6`: not RFC4122. The same reproduced on `POST /treasury/cash-in`
(`accountId`).

## What fixes what

| | Fixes | Does NOT fix |
|---|---|---|
| `1755852500000-FixGenRandomUuidRfc4122Compliance` (**shipped in v1.0.3**) | id **generation** for every row created from now on | the ~92% of **existing** rows |
| **Controlled Data Repair** (`RepairNonCompliantUuids` core, driven by `DataRepairService`) | the **existing** rows: rewrites every non-compliant PK to a fresh RFC4122 id and updates every FK / soft-ref / polymorphic reference to match | — |

## Regression guards added (v1.0.3 hardening)

- `src/database/uuid-repair.core.spec.ts` — broken vs fixed generator
  simulation; strict regex == `@IsUUID()`.
- `src/domains/treasury/interface/treasury.controller.spec.ts`,
  `src/domains/deposit-control/interface/deposits.controller.spec.ts` — the
  DTOs must keep **rejecting** `0a066947-1794-9892-6816-35f51ddf72c0` and
  **accepting** a real UUID (the literal "must be a UUID" strings).
- `ReleaseHealthCheckService` / `verify-deploy.sh` — UUID-function check is
  now strict RFC4122; a UUID-shaped-but-non-compliant result **fails**.
- `verify-deploy.sh` — legacy non-compliant PK census (warning) so an
  operator knows the errors will persist until the repair runs.

## Do NOT "fix" this by

- removing / weakening `@IsUUID()`
- `@IsString()` + a cast
- generating a UUID in the frontend
- accepting any string in the backend

The stored ids are wrong; correct them at the source (the Controlled Data
Repair), keep the validation strict.
