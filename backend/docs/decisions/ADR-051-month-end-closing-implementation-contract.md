# ADR-051 — Month-End Closing + Black Box: Implementation Contract (Phase 0)

**Status:** Approved baseline for implementation. Derived strictly from the
Month-End Closing / Black Box Architecture Study, Revision 2 (`docs/studies/
MONTH_END_CLOSING_AND_BLACKBOX_ARCHITECTURE_STUDY.md`), which the CTO
accepted as the Architecture Baseline. This ADR freezes the items Revision 2
left as recommendations into binding contracts for implementation. It
introduces no new architectural decision beyond what Revision 2 already
proposed and the CTO already approved — where this document makes a concrete
implementation choice Revision 2 left open as a dependency (signing-key
custody, §9 below), it is derived from an existing, already-established
codebase convention, disclosed here rather than decided silently, per the
CTO directive's "No Silent Decisions" rule.

Production remains HOLD throughout implementation.

---

## 1. Final entity/data contracts

**`ClosingException`** (Phase 2) — one row per finding, not a JSONB array
(Study §C.1):

```
id, closingAuditRunId, fiscalPeriodId, module, documentType, documentId,
transactionRef, accountOrSubledgerRef, amount, source, category, severity,
problem, requiredAction, status, resolvedByUserId, resolvedAt,
resolutionNote, annotation (nullable — HISTORICAL_TEST_ARTIFACT only),
createdAt
```

**`ClosingSnapshotSigningKey`** (Phase 1):

```
kid (PK), publicKey, validFrom, validUntil (nullable), createdByUserId,
reason, createdAt
```

**`ClosingSnapshotRun`** (Phase 5):

```
id, fiscalPeriodId, closeSequence, supersedesSnapshotId (nullable),
approvalRequestId, status (pending | complete | failed), contentHash,
signingKeyId (kid), signature, manifestPath, generatedByUserId,
generatedAt, appVersion, migrationHead, configVersion
```

**`ClosingWorkflowRun`** (Phase 3) — the per-closing-attempt evidence trail
(Study §D): `id, fiscalPeriodId, entryState (soft_close|reopened), auditRunId,
finalReconciliationRunId, approvalRequestId, status
(audit_run|exceptions_open|exceptions_resolved|
final_reconciliation_passed|approval_submitted|approved|snapshot_created|
period_locked|failed), createdAt, completedAt`.

No other schema changes. None of the five existing reconciliation services,
`FISCAL_PERIOD_PROCESS`/`FISCAL_YEAR_PROCESS`, `FinancialEvent`, or GL tables
are altered.

## 2. Final `ClosingException` lifecycle

```
open → acknowledged → resolved
open → acknowledged → waived        [UNREACHABLE IN V1]
```

`waived` is a defined enum value (for forward schema compatibility only) but
**no code path in V1 can set it** — Study §5 Decision 1 (no override/waiver
mechanism in V1). A `BLOCKING` exception can only leave `open`/`acknowledged`
via `resolved`, which requires the underlying data/config to actually be
fixed and a **fresh** re-run of the Closing Audit to confirm it no longer
reproduces (an exception is never hand-marked `resolved` on its own say-so —
resolution is *proven* by the next audit run not finding it again, exactly
matching §6's "Fresh Final Reconciliation" requirement).

## 3. Exception classification policy and rule ownership

Six categories, exact severity mapping and required actions as Study §2.2's
table, verbatim — not reproduced a second time here. **Ownership:** the
category-detection rule tables (`EXPECTED_BUSINESS_REJECTION` and
`CONFIGURATION_EXCEPTION` reason-pattern lists) are authored as a versioned
TypeScript module (`domains/accounting/domain/closing-exception-
classification.ts`), reviewed like any other source change — **not** exposed
through `ConfigurationEngineService`. `HISTORICAL_TEST_ARTIFACT` requires an
explicit, individual, permissioned annotation call — never inferred by any
rule — and is gated by a dedicated permission node (`accounting.
closing_exception.annotate_test_artifact`) so it is auditable who used it and
when, per Study §2.3.

## 4. Unified `submitPeriodClose` flow

One entry point handles both the first close (`soft_close` state) and a
reclose (`reopened` state) — Study §1.3. `FiscalPeriodService.
submitPeriodClose` is extended (not duplicated) to accept either starting
state, run the Closing Audit first (refusing with `ConflictException` and
zero FA-01 side effects on any `BLOCKING` exception), then submit the
appropriate request type (§5) and, at approval time, fire whichever
`FISCAL_PERIOD_PROCESS` transition (`close` or `close_after_reopen`) matches
the period's state under lock — mirroring the existing ADR-046 D10 re-check
pattern used for `FiscalYear.close`.

## 5. `accounting.fiscal_period.reclose` approval request type

New, distinct `ApprovalRequestType` code (Study §1.6): `accounting.
fiscal_period.reclose`, registered alongside the existing three F13 types.
V1 matrix rule is **identical** to `accounting.fiscal_period.close`'s
(`minApprovers`, `requiredPermissionNode: accounting.fiscal_period.approve`)
— giving it a distinct code costs nothing now and lets a future, stricter
reclose-specific rule be layered in later purely as configuration.

## 6. The closing invariant

**Closing Audit → Exception Gate → Exception Resolution → Fresh Final
Reconciliation → FA-01 → Period Lock** is enforced as one sequence inside
`PeriodClosingOrchestrationService` (Phase 3), tracked by `ClosingWorkflowRun`
(§1). No step may be skipped; no step's evidence is inferred from an earlier
step's result once time has passed — restated precisely in §7.

## 7. Final Reconciliation freshness

**"Final Reconciliation" is never the same stored result as the initial
Closing Audit run**, even if no exceptions were ever found. The orchestration
always performs a **second, independent** `ClosingAuditService`-style sweep
immediately before FA-01 submission, and that second run's id (not the
first's) is the one attached to the approval request as evidence. This is
what makes "resolved" in §2 a proven fact rather than a claim — the
resolution is confirmed by this fresh run finding nothing blocking, not by
the resolver's own assertion.

## 8. Black Box canonical manifest schema

Exact JSON shape as Study §3.4, frozen verbatim:

```json
{
  "manifestVersion": "1.0",
  "fiscalPeriodId": "...", "periodCode": "...", "closeSequence": 1,
  "supersedesSnapshotId": null, "previousManifestHash": null,
  "generatedAt": "...", "generatedByUserId": "...", "approvalRequestId": "...",
  "appVersion": "...", "migrationHead": "...", "configVersion": "...",
  "contentHash": "sha256:...", "signingKeyId": "...", "signature": "..."
}
```

`contentHash` covers the canonicalized **snapshot body** (Study §F.1's
content table); the manifest itself (all fields above except `signature`) is
what gets canonicalized and signed as a unit.

## 9. Dedicated installation-owned Ed25519 signing key and `kid` registry

**Custody model — derived from an existing, established convention, not a
new one:** this codebase's only existing installation-secret precedent
(`JWT_ACCESS_SECRET`, read once via `AppConfigService.get(...)`, required,
the process fails to authenticate without it — no auto-generation, no
database storage of the secret itself) is applied identically here:

- **Private key:** `CLOSING_SNAPSHOT_SIGNING_PRIVATE_KEY` (base64,
  PKCS8/raw-32-byte Ed25519 seed) + `CLOSING_SNAPSHOT_SIGNING_KID` — both
  required environment variables, read once via `AppConfigService`. Never
  written to the database. The application does not generate or rewrite its
  own `.env` — exactly like `JWT_ACCESS_SECRET`, provisioning a value is an
  operator action outside the application's own runtime.
- **Public key + `kid`:** persisted in `ClosingSnapshotSigningKey` (§1).
  Startup self-check: if a row for the configured `kid` does not exist yet,
  insert it (first registration of an operator-provisioned key — mirrors
  `SeedDefaultBaseCurrency`'s idempotent bootstrap pattern); if a row already
  exists for that `kid`, verify the derived public key matches exactly —
  mismatch is a startup-fatal `ConflictException` (never silently trust a
  changed key under an already-used `kid`).
- This is disclosed here, not decided silently, precisely because Study §6
  Decision 6 named the custody mechanism as an unresolved dependency — it is
  resolved now by direct precedent (an identical pattern already exists and
  is already trusted for another installation secret), which this contract
  treats as "implementation detail already determined by an existing
  convention" (CTO directive §5), not a new architectural decision requiring
  separate escalation.

## 10. Key rotation and historical verification rules

Rotation = provisioning a **new** `kid`/keypair via the same env-var
mechanism (§9) and restarting — the OLD `kid`'s row in the registry is never
deleted or modified (`validUntil` may be set, informationally; verification
never depends on it). Every snapshot manifest already names its own `kid`
(§8) — verification always looks up that exact `kid` in the registry,
**never** "whichever key is currently active." A snapshot signed under a
retired `kid` remains independently verifiable forever, by construction, as
long as that `kid`'s row is never deleted (enforced by never exposing a
delete path for this entity — append-only, matching `audit_records`).

## 11. Independent content hash + per-period predecessor chain

Every snapshot: its own `contentHash` (SHA-256 over the canonicalized body),
always present, always independently checkable (Study §3.5). Additionally,
when `supersedesSnapshotId` is set, `previousManifestHash` must equal the
predecessor's own manifest hash — checked as a **third**, separate
verification step (§13), scoped to that one period's own history, never
merged into the global `audit_records` hash-chain.

## 12. Snapshot generation Outbox/retry/idempotency behavior

Mirrors the existing Transactional Outbox (`EventBusService`) discipline
(Study §3.6), reusing the pattern rather than inventing a new one:

- The SAME transaction that applies the approved `close`/`close_after_reopen`
  transition also inserts a `ClosingSnapshotRun` row with `status: 'pending'`
  (never `'complete'` at this point — the file does not exist yet).
- Immediately after that transaction commits, the same handler attempts
  assembly → canonicalize → hash → sign → write file → update the row to
  `'complete'` with `contentHash`/`signature`/`manifestPath` populated.
- On any failure in that sequence, the row stays `'pending'`; nothing
  partially-written is treated as valid (a half-written file is never
  referenced by a `'complete'` row).
- A recovery sweep (reusing the same "find work still marked pending" shape
  `EventBusService.dispatchPending()` already uses for the outbox) finds any
  `ClosingSnapshotRun` still `'pending'` after its `FiscalPeriod` is already
  `'closed'`, and retries assembly. Retrying is naturally idempotent: the
  content-addressed file path (Study §F.4) means a retry that reassembles
  identical data writes to the identical path; if a retry's assembled
  content differs from what a first, partially-completed attempt already
  wrote to disk (a genuine risk after a crash mid-write), the row is marked
  `'failed'` and surfaced (§14) rather than silently overwritten.

## 13. Cryptographic tamper-evidence vs. filesystem immutability — explicit distinction

Two **independent** guarantees, never conflated:

- **Cryptographic tamper-evidence** (`contentHash` + `signature` +
  `previousManifestHash`) proves *whether* the recorded bytes were altered
  — it does not by itself *prevent* alteration; it only makes alteration
  **detectable** the next time `verify` runs.
- **Filesystem immutability** (content-addressed path, no application code
  path ever opens an existing snapshot file for writing, §F.4) is what
  *reduces the opportunity* for undetected alteration in the first place —
  it is an operational/application-discipline control, not a cryptographic
  one, and this contract does not claim OS-level write-protection is
  configured (that remains a deployment/ops decision outside this
  capability's own code, exactly as Study §F.4 already disclosed).
- Both are required; neither substitutes for the other. `verify` (§F.5)
  checks the cryptographic side only — a filesystem-level tamper that also
  updates the DB-recorded hash to match would defeat cryptographic
  detection, which is precisely why the signature (not just the hash) must
  also be checked: an attacker would additionally need the private key,
  which per §9 never touches the database or the snapshot storage at all.

## 14. Closed-period / missing-snapshot recovery and alert behavior

A `FiscalPeriod` in `'closed'`/`'reopened→closed'` state whose
`ClosingSnapshotRun` is not `'complete'` is a **detectable, named**
condition, not a silent gap: the recovery sweep (§12) logs and (via the
existing `AuditService`) records an `accounting.closing_snapshot.
generation_overdue` audit entry on each sweep pass that still finds a
`'pending'` or `'failed'` row past a defined grace period. No automatic
"pretend it's fine" fallback exists — a period can be genuinely `'closed'`
(for posting-gate purposes, §A.1's `assertOpenForPosting`) while its
evidence generation is still catching up or has failed and needs an
operator's attention; the two facts are tracked and surfaced separately, not
merged into one status.

## 15. Permission model and segregation of duties

New nodes (Study §H, frozen): `accounting.closing_exception.resolve`,
`accounting.closing_exception.annotate_test_artifact` (§3), `accounting.
closing_snapshot.view`, `accounting.closing_snapshot.verify`, `accounting.
closing_snapshot.rotate_key`. All new leaves under the existing
`accounting.*` tree — no new top-level module, no manifest restructuring.
Segregation of duties for close/reclose approval is **unchanged** —
inherited entirely from the existing FA-01 `ApprovalEngineService` (maker ≠
checker, already enforced and already verified live this session).

## 16. Migration and implementation sequence

Exactly the CTO directive's §4 phase order (Phase 1 → 7), executed as
described in that directive. Restated here only to confirm no reordering:
Foundation/Shared Contracts → ClosingException → Closing Orchestration →
Reclose Control → Black Box Snapshot → Reliability/Outbox/Recovery →
Verification/Security/Regression.

## 17. Acceptance / E2E test matrix

Exactly the scenario list in the CTO directive's §1 item 17 and §7 —
restated as the Phase 7 gate, not duplicated here; each earlier phase's own
PASS gate additionally covers the scenarios specific to that phase's scope
(e.g., Phase 4's gate specifically includes "`close_after_reopen` cannot be
reached through the old ungated routine path").

---

## Environment note (disclosed, not an architectural decision)

This working directory is **not a git repository** (confirmed at session
start). The CTO directive's §9 "Git / Change Discipline" (commit per phase,
`git diff`/`git status` review before advancing) is honored in spirit using
this project's actual tooling: each phase's evidence is a **Phase Report**
(§8-format block, per the directive) posted at the end of that phase, backed
by real build/test/migration output reviewed in the same turn, in place of a
git commit. If the working directory is later made a git repository, nothing
in this contract needs to change — the phase boundaries already match what
would become individual commits.

---

## Items requiring explicit note before proceeding

Everything in Study §6 remains true and is not re-litigated here. This
Phase 0 contract adds exactly one concrete resolution beyond Revision 2: the
signing-key custody mechanism (§9), derived from existing precedent as
described above. No other new architectural decision is introduced. Per the
CTO directive's own rule (§5/§7), this is disclosed as a resolved
implementation detail, not escalated, because it follows directly from an
existing, already-approved convention rather than introducing a new one.

**Verified against:** Revision 2 (`MONTH_END_CLOSING_AND_BLACKBOX_
ARCHITECTURE_STUDY.md`), ADR-046 (F13 Financial Closing), ADR-050 (Closing
Audit Engine), ADR-035 (Financial Event Engine), the existing Transactional
Outbox (`EventBusService`), and the existing `manifest-verify.ts`/
`audit-hash.ts` cryptographic primitives. No conflict found. Proceeding to
Phase 1.
