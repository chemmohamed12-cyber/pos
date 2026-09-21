# Migration Report — v1.1.0

## Scope

8 new migrations, all additive (no `DROP TABLE`/`DROP COLUMN` on any
existing, previously-shipped table; the one `DROP CONSTRAINT` is
immediately followed by an `ADD CONSTRAINT` widening the same check,
never narrowing it). All 8 applied successfully against this session's
live development database and verified via direct query
(`SELECT * FROM migrations`) — 234/234 total migrations in the database
now, 8 of them new in this release.

| # | Migration | Tag | Type | Effect |
|---|---|---|---|---|
| 1 | `CreateTargetsCore1789750000000` | `targets` | Schema | Creates `targets` table + a `BEFORE INSERT OR UPDATE` trigger enforcing the ADR-068 §E non-overlap invariant — **corrected during this release's own candidate review**: the original version used a Postgres `EXCLUDE USING gist` constraint requiring the `btree_gist` contrib extension, which is unavailable on this project's real Hosting target; see `RELEASE_CANDIDATE_REVIEW.md`'s "Hosting-compatibility defect" entry |
| 2 | `SeedAdminPermissionsForTargets1789750100000` | `targets` | Permission seed | Grants the `admin` role the `targets` permission node (`ON CONFLICT DO NOTHING`) |
| 3 | `SeedTargetsPhase1Terminology1789750200000` | `targets` | Terminology seed | Bilingual (ar/en) UI strings for the Targets screen (idempotent upsert) |
| 4 | `CreateCommissionCore1789751000000` | `commission` | Schema | Creates `commission_policies`, `commission_tiers`, `commission_approval_batches`, `commission_results`, `commission_adjustments` |
| 5 | `SeedAdminPermissionsForCommission1789751100000` | `commission` | Permission seed | Grants the `admin` role the `commission` permission node |
| 6 | `SeedCommissionPhase1Terminology1789751300000` | `commission` | Terminology seed | Bilingual UI strings for the Commission screens |
| 7 | `CorrectPayrollCommissionPendingNotice1789751400000` | `commission` | Terminology correction | Updates one pre-existing terminology row (`panel.payroll_commission_pending_notice`) whose text had gone stale once Commission consumption was actually wired into Payroll |
| 8 | `AddTransientDatabaseErrorClosingExceptionCategory1789760000000` | `accounting` | Schema (constraint widen) | Drops and recreates `CHK_accounting_closing_exceptions_category` to add `'TRANSIENT_DATABASE_ERROR'` as a 7th valid value alongside the original six |

## Reversibility

Every migration above has a `down()` implementation. Migrations 1–7 are
pure `CREATE`/`INSERT` — their `down()` drops what `up()` created, with
no data-loss risk beyond the rows the migration itself introduced.
Migration 8's `down()` restores the original 6-value constraint — this
is only safe to run if no `accounting_closing_exceptions` row has been
given the new `'TRANSIENT_DATABASE_ERROR'` category yet; the migration's
own comment documents this.

## Dependency order

`commission`'s migrations depend on `targets` existing first at the
application-code level (`CommissionModule` imports `TargetsModule`), but
there is **no database foreign key** between the two schemas — the
migration tag order in `data-source.ts` lists `targets` before
`commission`, matching the code dependency, but this is a code-quality
convention, not a hard database constraint.

## What ships in the release package — and what does not

The release package built by `tools/build/build-release.sh` contains
**compiled migration files only** (`dist/database/migrations/<tag>/*.js`)
— never a database dump, never seed/test data, never a snapshot of this
development database's own accumulated rows. Deploying this package to
any target (a fresh Hosting-test instance or otherwise) runs these
migrations against **that target's own existing database state** —
schema changes only. No production or recovery data from this
development session is bundled, referenced, or required by this
package. See `RELEASE_CANDIDATE_REVIEW.md`'s "Clean test/hosting
dataset" row and `DEPLOY_INSTRUCTIONS.md` for the operational
consequence of this.

## Pre-existing schema state (context, not part of this release)

234 total migrations are applied in this development database as of
this release, spanning every domain built to date (Core, Sales,
Inventory, Logistics, Finance, HR, Accounting, Procurement,
Manufacturing, Attendance, Payroll, and now Targets/Commission). This
release report covers only the 8 new ones listed above.
