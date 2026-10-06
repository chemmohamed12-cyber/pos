# ADR-073 — Multi-Company Company-DB User-Identity FK Contradiction

**Status: APPROVED — OPTION D — IMPLEMENTED — REAL-PG VERIFIED — CLOSED
(2026-09-25).** §7 (Model B Preservation / Integrity Pre-Gate) found
Candidate Option D viable; CTO approved it. Implemented as
`applyCompanyAuthorizationSchemaAdjustment` (`company-authorization-schema-adjustment.ts`),
wired into `DatabaseProvisioningService.provision()` immediately after
Area 16's unmodified migration pipeline, before role seeding — exactly
the narrow scope approved, no migration file touched, Platform DB's own
`user_roles` FK left intact (independently proven in
`database-provisioning.service.spec.ts`, 4/4 pass, including the negative
Platform-User-existence proof and explicit `pg_constraint` checks for both
databases). Options A/B/C remain in §5 below as considered alternatives,
not deleted. Filename keeps its original `-PENDING` suffix per this
repo's own convention (see ADR-052) — this Status line is authoritative,
not the filename.

## 1. Schema Evidence (verified against source + a real disposable Postgres database)

Area 4/16's design (already approved) reuses the single-database migration
pipeline **unmodified** for Company databases: `runMigrationsForDatabase`
passes a `tags` array to `createMigrationDataSource`
(`foundation/release/migration-datasource.ts:62-75`), which globs
`dist/database/migrations/<tag>/*.js`. Area 4 provisioning calls this with
`tags: ['core']`. Verified directly against a fresh, disposable Company
database (`daii_test_area16_company_a`, created and migrated for real
during this session's Area 16 verification): `SELECT to_regclass('public.users')`
returns non-null — the `users` table genuinely exists in a Company database.

Every migration file under `src/database/migrations/core/` that creates a
table with a foreign key to `users(id)` (verified by grepping the literal
`REFERENCES "users"` string in that directory):

| Table | FK column | Migration | Live write path into a Company DB today? |
|---|---|---|---|
| `credentials` | `userId` (PK) | `1755840200000-CreateAuthTables.ts:10` | **No** — `AuthService` only ever uses `@InjectRepository(Credential)`, the ambient/platform DataSource (verified: no Company-scoped injection anywhere) |
| `refresh_tokens` | `userId` | `1755840200000-CreateAuthTables.ts:20` | **No** — same `AuthService`, ambient-only |
| `user_roles` | `userId` | `1755840300000-CreateAuthorizationTables.ts:25` | **Yes** — `provisionUserRoleForMembership` (`foundation/company/membership-role-provisioning.ts:27-37`) writes here via a real Company connection |
| `scope_assignments` | `userId` | `1755840500000-CreateScopeAssignments.ts:11` | **No** — `ScopeService` uses `@InjectRepository(ScopeAssignment)`, ambient-only |
| `org_memberships` | `userId` | `1755840600000-CreateOrganizationTables.ts:22` | **No** — `OrganizationService` uses `@InjectRepository(OrgMembership)`, ambient-only |
| `user_locale_preferences` | `userId` (PK) | `1755841100000-CreateUserLocalePreferences.ts:10` | **No** — no Company-scoped caller found |

So the schema-level exposure is five tables, but the **live, actually-exercised
contradiction today is exactly one**: `user_roles.userId`. The other four
exist as dormant, duplicated, never-written schema inside every Company
database — a related but separate finding (§4 below), not itself a runtime
failure today.

`role_permissions.roleId → roles.id` and `roles` itself have no dependency
on `users` — unaffected, confirmed by grep (`CreateRolePermissions.ts:11`,
`CreateAuthorizationTables.ts:14-16`).

**The actual failure, reproduced against a real disposable Company database
this session:**
```
insert or update on table "user_roles" violates foreign key constraint "user_roles_userId_fkey"
```
raised from `provisionUserRoleForMembership`'s `userRoleRepo.save(...)`
(`membership-role-provisioning.ts:37`) — an `INSERT`, which Postgres's FK
enforcement checks. `deprovisionUserRoleForMembership`'s `.delete(...)`
(line 46) is **not** subject to this constraint — a `DELETE` never needs the
referenced row to exist. So **grant/create is blocked; revoke is not.**

## 2. Model B Evidence (verified against source)

`AuthorizationService`'s class doc comment (2026-09-23, Model B decision):
> "`Role`/`UserRole` ALSO exist as real, physically separate tables inside
> each Company's own database (seeded by `company-role-seeding.ts` during
> provisioning — the exact same entity classes, a different connection)."

`membership-role-provisioning.ts`'s doc comment (same decision):
> "`Membership` (Platform DB) is the source of the User↔Company
> relationship; this is the mechanical follow-through into a Company's own
> database."

Neither this ADR's source comments, nor `Membership`'s own entity, nor
`CompanyMembershipProvisioningService`, nor any other file found this
session states or implies that a `User` row is ever created inside a
Company database. `User` is explicitly a Platform-DB-only concept;
`Membership(userId, companyId, roleKey)` in the Platform DB is the sole
record of which Users may act in which Company. Confirmed: no code path
anywhere in `src/` inserts a `users` row into a Company database.

**The contradiction, stated precisely:** Model B says a Company database
never holds `User` identity — only `Role`/`UserRole` as a local grant
catalog referencing a `userId` by value. The reused single-database
migration schema says the opposite: `user_roles.userId` is not just a
value, it is a referentially-enforced foreign key requiring a matching
`users` row in that same database. The two decisions were both individually
correct and individually verified/CLOSED; they were never checked against
each other until real-Postgres verification became possible today.

## 3. Impact Map

Every code path that calls `provisionUserRoleForMembership` (grant path) —
all of them hit this FK the moment they run against a real, fully-migrated
Company database:

| Caller | File | Effect today |
|---|---|---|
| Area 4 initial-admin provisioning | `database-provisioning.service.ts:224` | **Confirmed broken** — reproduced this session |
| Track A — `grantMembership` | `company-membership-provisioning.service.ts:53` | Same call, same FK — never previously proven against a real Company DB (its own spec mocks `membership-role-provisioning` entirely) |
| Track A — `changeMembershipRole` | `company-membership-provisioning.service.ts:167` | Same |
| `MembershipReconciliationScheduler` replaying a `grant`/`role_change` | `membership-reconciliation.scheduler.ts:87` | Same |

Not affected (delete path, no FK check on `DELETE`):
- Track A — `revokeMembership` (`company-membership-provisioning.service.ts:109`)
- `MembershipReconciliationScheduler` replaying a `revoke` (`membership-reconciliation.scheduler.ts:83`)

Not affected (no `users` dependency at all):
- Area 6 role-catalog seeding (`seedCompanyRoleTemplates`, `seedCompanyAdminRole`) — only touches `roles`/`role_permissions`
- `AuthorizationService.getRoleKeysForUser(userId, manager)` with a Company `manager` — a `SELECT`, not subject to FK enforcement; Company-scoped permission **reads** work today even though Company-scoped grant **writes** don't
- Area 16 migration pipeline itself — runs to completion; the FK is part of the schema it correctly, faithfully applies
- Permission Engine (`PermissionService.resolve`) — reads only

Separate, lower-severity finding: `credentials`, `refresh_tokens`,
`scope_assignments`, `org_memberships`, `user_locale_preferences` exist as
dormant, unreachable schema inside every Company database (dead weight,
confusing to anyone inspecting a Company DB directly, no current functional
harm since nothing writes there).

**Track A status:** remains CLOSED as a historical status per your
instruction. This is new contradicting evidence against its live
Company-DB grant/role-change path specifically, not a reopening of Track A
as a whole.

## 4. What is NOT a valid way to resolve this

Per your directive — none of the following has been done, and none should
be chosen without a decision:
- Creating a `User` stub/mirror row in a Company DB
- Dropping or altering the `user_roles_userId_fkey` constraint
- Excluding auth/user migrations from the `'core'` tag for Company DBs
- Changing migration tags generally
- Changing the Model B decision itself
- Modifying Area 6 architecture
- Redesigning Membership provisioning
- Touching Track A's implementation

## 5. Decision Options (not a recommendation — CTO decision required)

### Option A — Company-local `User` mirror row
Insert a minimal row (`id`, maybe `fullName`/`email` for local display) into
the Company DB's own `users` table whenever a `Membership` grant provisions
a `UserRole` there, keeping the Platform DB as the sole source of truth and
the Company-DB row as a derived, denormalized copy.
- **Architecture impact:** Extends Model B rather than replacing it — User
  identity is still Platform-owned; the Company row is explicitly a mirror,
  not a second identity.
- **Data impact:** Introduces duplicated (denormalized) PII (name/email) in
  every Company database — a new data-residency/duplication surface.
- **Migration impact:** None — no schema change, only new write behavior.
- **Security/isolation impact:** A revoked/deleted Platform User's mirror
  row would need explicit cleanup logic (new failure mode: stale mirror);
  Company DB now holds a copy of identity data it previously never held.
- **Existing ADR impact:** None directly, but touches the same territory as
  ADR-004 (identity/authentication) and ADR-005 (authorization/permission
  scope) — would likely need an explicit amendment or a new ADR cross-reference.
- **Area 6 impact:** `provisionUserRoleForMembership` gains a new
  precondition step; `AuthorizationService`'s doc comment would need
  updating to describe the mirror.
- **Track A impact:** `grantMembership`/`changeMembershipRole` need the same
  new step; existing mocked spec (`company-membership-provisioning.service.spec.ts`)
  would need a real-Postgres companion test to prove it, mirroring what Area
  4/16 just gained.
- **Area 20 impact:** Initial-admin provisioning gets the same new step.
- **Portability impact:** A disposable/backed-up Company database now
  carries PII duplication — Track D's backup/restore semantics would need
  re-review for whether a Company backup should include or scrub these
  mirror rows.
- **Backward compatibility:** Existing Company databases with `UserRole`
  rows already impossible to create (none exist today, since this path has
  never succeeded against a real DB) — no live data to migrate.
- **Verification requirements:** Real-Postgres proof that mirror-then-grant
  succeeds, that a Platform User revoke correctly cleans up (or explicitly
  does not need to) the mirror, and that no other code accidentally treats
  the Company-DB mirror as authoritative.
- **Rollback/recovery:** Straightforward to revert (stop writing the mirror
  row) since it's pure addition, not a schema change.
- **Production risk:** Low blast radius (additive), but introduces an
  ongoing consistency-maintenance obligation between two databases.

### Option B — Relax/remove the FK for Company-DB context
Company databases no longer enforce `user_roles.userId → users.id`
referentially — `userId` becomes a plain UUID column there, matching what
Model B's own design already implicitly assumes (`Membership`/`UserRole`'s
`userId` is a foreign identifier from the Platform DB, not a locally
verifiable one).
- **Architecture impact:** Most directly matches Model B's stated intent —
  treats the constraint mismatch as the actual bug (a single-database
  assumption baked into a schema now reused across a security boundary it
  wasn't designed for).
- **Data impact:** None — no new data introduced; only the enforcement
  guarantee is removed for this one column, in Company DBs specifically.
- **Migration impact:** Requires either a Company-DB-specific schema
  variant (a new/altered migration path only Company provisioning uses) or
  a post-provisioning `ALTER TABLE ... DROP CONSTRAINT` step — either way,
  breaks the current "the exact same, unmodified single-database migration
  pipeline" guarantee Area 16 was explicitly built and verified around.
- **Security/isolation impact:** None for cross-Company isolation
  specifically (Area 21's concern is untouched — this is about intra-database
  referential integrity, not Company boundary enforcement) — but does
  remove a database-level guard against an orphaned/typo'd `userId` ever
  being written to `user_roles` (previously impossible by construction, now
  possible and would rely entirely on application-level correctness).
- **Existing ADR impact:** None found directly addressing this.
- **Area 6 impact:** `AuthorizationService`/`membership-role-provisioning.ts`
  unchanged in behavior; their comments describing "the exact same entity
  classes, a different connection" become slightly less true (integrity
  guarantees differ by connection).
- **Track A impact:** `grantMembership`/`changeMembershipRole` would work
  as originally written, no code change needed there.
- **Area 20 impact:** Same — no code change needed in the initial-admin step.
- **Portability impact:** None.
- **Backward compatibility:** No existing data affected (same reasoning as
  Option A).
- **Verification requirements:** Real-Postgres proof the constraint is
  actually absent post-provisioning, and that no other invariant silently
  depended on it existing.
- **Rollback/recovery:** Re-adding the constraint later would first require
  auditing/cleaning any `user_roles` rows with no matching Platform User
  (if such an audit path even exists yet — it doesn't today).
- **Production risk:** Removes a safety net Postgres was providing for free;
  the application layer becomes the only thing preventing orphaned grants.

### Option C — Split migration tags: exclude auth/identity tables from Company DBs entirely
Give Company databases a narrower baseline than `'core'` — a schema that
still includes `roles`/`role_permissions`/`user_roles` (Model B's
Company-local catalog) but never creates `users`/`credentials`/
`refresh_tokens`/`scope_assignments`/`org_memberships`/
`user_locale_preferences` at all, since none of those are ever meant to
exist in a Company DB per Model B.
- **Architecture impact:** Largest of the three — introduces a genuine
  "Company-DB baseline schema" concept distinct from "platform/single-DB
  schema," which does not exist today (Area 16 was explicitly built and
  verified on the premise of reusing the single, unmodified pipeline).
  Also removes the dormant-table finding (§3) entirely, not just the live
  `user_roles` contradiction.
- **Data impact:** None new.
- **Migration impact:** Largest — either a new `company-core` tag
  (duplicating/forking migrations already tagged `core`) or restructuring
  which files live under which tag, with careful handling of any migration
  ordering dependency between the excluded tables and ones that must stay
  (e.g., does anything under `core/` depend on `users` existing before it
  runs, beyond the FK-bearing migrations themselves?) — not yet
  investigated, would need its own audit before this option is viable.
- **Security/isolation impact:** Removes dormant, unreachable schema from
  every Company DB — arguably an isolation *improvement* (less attack
  surface/confusion inside a Company's own database), no downside found.
- **Existing ADR impact:** Directly touches ADR-025 (per-module migration
  partitioning, cited in `migration-datasource.ts`'s own doc comment) —
  would need to extend or amend that ADR's tag model.
- **Area 6 impact:** None to its own code; role-catalog seeding already
  only touches `roles`/`role_permissions`.
- **Track A impact:** Resolves the contradiction for Track A's grant path
  too, same as Options A/B, without any Track A code change.
- **Area 20 impact:** Resolves it there too, without code change to the
  initial-admin step itself (only to what migrations ran before it).
- **Portability impact:** Cleanest of the three — a Company DB backup/restore
  (Track D) never carries dormant identity-adjacent tables at all.
- **Backward compatibility:** No existing Company databases have ever
  completed provisioning with the current `'core'` tag in production (Area
  4 has never successfully closed) — no live migration-history rewrite risk
  found, but this needs explicit confirmation before treating it as safe.
- **Verification requirements:** Real-Postgres proof of the new tag's
  migration set, PLUS a full re-run of Area 16's own verification suite
  against the new tag definition (Area 16 is CLOSED against `'core']`
  as it exists today — a tag restructuring is exactly the kind of
  change that would need Area 16's evidence re-established, not silently
  assumed to still hold).
- **Rollback/recovery:** Hardest of the three to reverse cleanly, since it
  changes what "the `'core'` tag" (or a new tag) means for every future
  Company provisioned under it.
- **Production risk:** Highest short-term implementation/verification cost;
  potentially the most correct long-term shape.

## 6. What this document does not do

It does not recommend Option A, B, or C. It does not implement anything —
no code, no migration, no entity change accompanies this document. It
exists so the CTO decision is made against verified current-state facts,
per §8 of the Recovery & Completion Package.

## 7. Model B Preservation / Integrity Pre-Gate (2026-09-25)

Investigation only. No implementation, no migration, no schema change, no
workaround. `Candidate Option D` below is an investigation label, not a
decision.

### 1. Technical Question
Can Model B be preserved exactly as approved (no `User` identity in a
Company DB), while still preserving referential/data integrity
appropriately, without an architectural change larger than necessary?

### 2. Verified Constraints
- `UserRole` entity (`authorization/user-role.entity.ts:10-24`) declares
  `userId` as a plain `@Column('uuid')` — **no** `@ManyToOne`/`@JoinColumn`
  relation to `User` at the ORM level, and `synchronize: false` everywhere
  in this codebase (schema is migration-driven only). TypeORM itself does
  not know about, and does not enforce, any relationship for this column.
- The **only** place the constraint exists is one line of raw SQL:
  `CreateAuthorizationTables.ts:25` — `"userId" UUID NOT NULL REFERENCES
  "users"("id") ON DELETE CASCADE`.
- **Answering §1's three sub-questions directly:** the FK is imposed only
  by that one migration, not by the entity; the entity definition does not
  enforce it; and `userId` inside a Company DB can already be treated as a
  pure external Platform-identity reference from the ORM's perspective —
  the only obstacle is that one raw-SQL constraint.

### 3. Candidate Mechanisms Investigated
- **Mechanism 1 — narrow post-migration correction, Company DB only.** A
  small, idempotent step (e.g. `ALTER TABLE "user_roles" DROP CONSTRAINT IF
  EXISTS "user_roles_userId_fkey"`) run against a Company's own connection,
  immediately after `runMigrationsForDatabase` succeeds and before
  role-seeding — same placement pattern Area 6 already uses for
  `seedCompanyRoleTemplates`/`seedCompanyAdminRole` (run the shared,
  unmodified migration pipeline first, then apply a Company-specific
  step). Area 16's migration files are not touched at all; the Platform
  database is never touched (this step would only ever run during Company
  provisioning). No new migration tag.
- **Mechanism 2 — a new always-additional tag carrying just this
  correction.** Examined and set aside as closer to Option C's territory
  than to a minimal fix — introduces a tag-composition concept
  (`'core'` + `'company-correction'`, always together) that doesn't exist
  today, for a single one-line change. Mechanism 1 achieves the identical
  outcome without it.
- **Mechanism 3 — edit `CreateAuthorizationTables.ts` itself to drop the
  `REFERENCES` clause for every database.** Rejected as a candidate for
  "least architectural change": it touches an Area-16-verified migration
  file directly, and — unlike Mechanism 1 — would also remove the Platform
  database's own long-standing FK on its own `user_roles` table (used for
  platform-level grants, e.g. bootstrap admin — `AuthorizationService`'s
  own comment: "platform-level role grants... deliberately untouched, not
  part of the Company boundary"), which is a strictly larger, unrelated
  change this investigation was not asked to make.
- **Mechanism 4 — cross-database FK/trigger (e.g. `postgres_fdw`,
  `dblink`) to genuinely enforce the reference at the database level
  across Platform/Company DBs.** Examined and rejected as categorically
  disproportionate — introduces cross-database connectivity as a new
  infrastructure dependency for every Company database, a materially
  larger architectural change than anything else considered here.

### 4. Evidence
- **Direct, already-approved precedent for this exact pattern exists in
  this codebase.** `CreateUserCompanyMemberships.ts:8-11` (Area 6,
  Multi-Company Phase 3 V7, already CLOSED) creates
  `user_company_memberships.userId` with **no FK to `users(id)` at all** —
  and its own comment states the reasoning verbatim: *"`userId` also
  carries no FK here deliberately — `User` is a Control-Plane entity per
  earlier Phase 3 sections, but this migration does not touch the `users`
  table's own constraints, staying within Area 6's own literal scope."*
  This is the same database (Platform DB has both `users` and
  `user_company_memberships`), and Area 6 still chose no FK, on an
  ownership/boundary principle — not even a cross-database technical
  impossibility in that instance. The Company-DB `user_roles` case is the
  same principle, plus a genuine technical impossibility (the two tables
  are not even in the same database).
- **Integrity is not actually unguarded today at the application layer —
  it is already checked, redundantly, in the one place that can
  legitimately check it.** Every real call site that can insert a
  `user_roles` row traces back to a Platform-level existence check:
  - `DatabaseProvisioningService.provision()` — `await
    this.users.findById(params.initialAdminUserId)`
    (`database-provisioning.service.ts:211`) runs before the Membership
    row is created or `provisionUserRoleForMembership` is ever called.
  - `CompanyMembershipProvisioningService.grantMembership` —
    `await this.users.findById(userId)`
    (`company-membership-provisioning.service.ts:45`), documented inline
    as the D1 decision: *"Membership Management never creates a `User`; it
    must already exist."*
  - `MembershipReconciliationScheduler.runOnce` — for a `grant`/`role_change`
    replay, it first re-reads the current `Membership` row
    (`membership-reconciliation.scheduler.ts:70`) and only proceeds if it
    still matches; a `Membership` row is only ever created after the same
    `UsersService.findById` check above, so the chain of validation still
    holds for a replay, without needing its own direct re-check.
  
  In other words: the Company-DB FK was never the only, or even the
  primary, integrity guarantee — it was a redundant, structurally
  unsatisfiable duplicate of a check already correctly performed against
  the actual source of truth (the Platform DB) before any Company-DB write
  is attempted.

### 5. Can Model B be preserved? **YES.**
Mechanism 1 requires no `User` mirror/stub, no new identity source, and no
change to where `User`/`Membership`/`Role`/`UserRole` live. It removes one
constraint; it adds nothing.

### 6. Can integrity be preserved? **YES, at the layer where it is actually
meaningful.** Database-level cross-database FK enforcement was never truly
achievable here without Mechanism 4's disproportionate cost (Postgres has
no native cross-database FK). The realistic integrity guarantee — "this
`userId` corresponds to a real Platform User" — is already enforced,
correctly, at every call site, before any Company-DB write, exactly
mirroring how `Membership` itself already handles the identical situation
with no local FK.

### 7. Architecture impact
Minimal. No change to Model B, no change to where any entity lives, no new
identity source. Brings `user_roles.userId`'s enforcement posture in line
with the already-approved `user_company_memberships.userId` precedent
(consistency improvement, not a new pattern).

### 8. Migration impact
Zero changes to any existing migration file under `core/`. Area 16's
"exact same, unmodified single-database migration pipeline" guarantee
stays intact — Mechanism 1 runs strictly after that pipeline completes, as
a separate, Company-only step, the same placement Area 6's role-seeding
already established as approved practice.

### 9. Verification impact
Would need: real-Postgres proof the constraint is genuinely absent after
provisioning a fresh Company DB; a real-Postgres proof that
`provisionUserRoleForMembership` now succeeds end-to-end (closing Area 4);
confirmation the Platform database's own `user_roles` FK is untouched
(Mechanism 1 never runs against it); and a check for any other constraint
or code path that implicitly assumed the Company-DB FK's presence (none
found this session, but not yet exhaustively re-verified after a real
implementation would exist).

### 10. If viable: Candidate Option D
**Candidate Option D — Preserve Model B + Preserve Referential/Data
Integrity, via Mechanism 1** (a narrow, idempotent, Company-DB-only
post-migration correction dropping `user_roles_userId_fkey`, applied after
Area 16's unmodified pipeline completes, in the same placement pattern
Area 6's role-seeding already uses). Investigation label only — not
implemented, not chosen.

### 11. If not viable: why A/B/C remain the valid decision set
Not applicable — this investigation found Mechanism 1 viable. ADR-073 §5's
Options A/B/C remain fully documented and available as-is if the CTO
prefers one of them over Candidate Option D for reasons outside this
investigation's narrow technical-feasibility scope (e.g., a preference to
also clean up the four dormant tables identified in §1, which only Option
C addresses, and Candidate Option D does not).

### 12. Open CTO Decision
Choose one of: Option A, Option B, Option C, or Candidate Option D. This
document does not recommend a choice. If Candidate Option D is chosen, it
still requires its own explicit authorization before any code, migration,
or Company-DB DDL is written — nothing in this §7 is authorization to
implement.


---
## Addendum — Extension RATIFIED (2026-10-05, CTO)
Candidate Option D (§7) — Company databases hold no `users` rows, so integrity of a User reference is guaranteed at the Platform layer, not by a Company-DB foreign key — is extended from the single live contradiction (`user_roles.userId`) to **every** foreign key that references `users(id)` in a Company database (14 in the current schema: `collections`, `credentials`, `customer_assignments`, `delivery_outcomes`, `deposits` ×2, `org_memberships`, `refresh_tokens`, `return_dispositions`, `return_requests`, `sales_orders`, `sales_rep_profiles`, `scope_assignments`, `user_locale_preferences`). The correction is a required architectural fix, not a workaround: those FKs made architecturally-correct writes fail with SQLSTATE 23503.
* New Company databases: dropped at provisioning by `applyCompanyAuthorizationSchemaAdjustment` (discovered from the catalog, so future migrations cannot reintroduce it).
* Existing Company databases: `tools/maintenance/relax-company-user-fks.js` — applied 2026-10-05 to Alpha, Beta, Gamma and Delta only; evidence in `docs/acceptance/AREA21_CLOSURE_2026-10-05.md` §7. The Platform database keeps all its constraints.
