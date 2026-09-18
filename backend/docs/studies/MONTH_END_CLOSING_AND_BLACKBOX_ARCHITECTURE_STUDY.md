# Month-End Closing Engine + Immutable Monthly Black Box — Architecture Study

**Status: STUDY / DESIGN PREPARATION ONLY — Revision 2.** No migration, no
entity, no controller, no UI, no schema change, no code implementation is
authorized by this document. Revision 1 (Current-State audit + Gap Analysis)
was reviewed and accepted as a correct baseline. This revision resolves the
three mandatory control questions the review raised — reclose-after-reopen,
REJECTED-event classification, and the Black Box cryptographic trust model —
into concrete, final proposals, adds the full 9-decision Architecture
Decision Matrix, and lists everything that still requires explicit CTO
approval before implementation begins. Production remains HOLD.

**ملخص تنفيذي (ar):** هذه المراجعة الثانية للدراسة، بدون أي كود. تم حسم
النقاط الثلاث الحرجة التي حددها الفريق: (1) توحيد مسار الإغلاق الأول
وإعادة الإغلاق بعد الـreopen تحت نفس ضوابط الـFA-01 والـClosing Audit، بدون
أي اختصار صامت؛ (2) استبدال قاعدة "REJECTED = INFORMATIONAL" بسياسة تصنيف
حقيقية بستة تصنيفات محددة؛ (3) نموذج ثقة تشفيري للـBlack Box يعتمد مفتاح
توقيع مستقل خاص بكل تنصيب (installation)، منفصل تمامًا عن مفتاح الـEntitlement
(الذي تبيّن أنه أصلًا مفتاح يزوّده المورّد عبر متغيرات البيئة، وليس مفتاحًا
يخص هذا التنصيب — سبب إضافي قوي لعدم إعادة استخدامه). كل قرار من التسعة
موثّق في مصفوفة قرار كاملة (القسم 3) مع توصية صريحة وتصنيف: موجود/قابل
لإعادة الاستخدام/فجوة/قرار جديد. لا شيء من هذا يُنفَّذ الآن — العرض النهائي
فقط بانتظار موافقة معمارية.

---

## 0. What changed since Revision 1

Revision 1 (`§A–§M` below, kept intact as the audited baseline) found three
gaps the team flagged as mandatory-before-build:

- **B.1 / L.3** — `close_after_reopen` bypasses both FA-01 and the Closing
  Audit today. **Resolved in §1 below**, with a final state machine.
- **B.2 / L.2** — `REJECTED = INFORMATIONAL` was a blanket rule, not a
  policy. **Resolved in §2 below**, with six named categories and their
  exact effect on closing.
- **F.3 / L.4** — signing-key choice was left open. **Resolved in §3
  below**, with a concrete recommendation grounded in how the existing
  Entitlement key is actually sourced (traced this revision: it comes from
  `AppConfigService`, itself populated from **environment-variable**
  configuration — i.e. it is a vendor-supplied key, not one this
  installation generates or owns. That is an additional, concrete reason
  — not just a "different trust domain" argument — not to reuse it.)

Sections §1–§4 below are the four requested "Final ..." deliverables. §5 is
the full 9-decision matrix. §6 is the explicit CTO-approval checklist. §A–§M
(further down) is Revision 1, unchanged, kept as the audit trail for how §1–§5
were derived — nothing in it is contradicted by this revision.

---

## 1. Final Proposed State Machine — Reclose after Reopening

### 1.1 Principle

**One closing workflow, two legal entry states.** The FIRST close and every
RECLOSE after a reopen are the *same* gated operation — Closing Audit, then
FA-01 approval, then snapshot — differing only in which underlying
`FISCAL_PERIOD_PROCESS` transition (`close` vs `close_after_reopen`) gets
fired at the end, and in whether the resulting snapshot links to a
predecessor. No second, lighter-weight path is created. This directly
answers the review's "no silent shortcut is acceptable."

### 1.2 The process-engine layer (`FISCAL_PERIOD_PROCESS`) is unchanged

The five states and five transition names audited in Revision 1 (§A.1) stay
exactly as they are — `assertOpenForPosting` and every existing poster
depend on them. What changes is **which service-layer entry points are
allowed to fire `close_after_reopen`**.

**Concrete behavior change from today:** `close_after_reopen` is removed
from `transitionPeriod`'s (the plain, ungated, routine-transition endpoint)
legal action list — exactly like `close` and `reopen` already are excluded
from it today. It becomes reachable **only** through the same gated
submission path as `close`. *(This is a real, deliberate change to existing
F13 behavior — listed explicitly in §6 as requiring CTO sign-off, not
something this study enacts on its own authority.)*

### 1.3 Unified closing-workflow, final version

```
Legal starting states for a gated close: { soft_close, reopened }
                                                │
                                                ▼
                        submitPeriodClose(periodId, actorUserId)
                     [ONE entry point — services the review's
                      "first close and reclose must use the same door"]
                                                │
                                                ▼
                          Run Closing Audit (= Final Reconciliation,
                          using the classification policy in §2)
                                                │
                        ┌───────────────────────┴────────────────────────┐
                        │                                                  │
                ≥1 BLOCKING exception                              zero BLOCKING exceptions
                        │                                                  │
              REFUSED (409) — no FA-01                          Submit FA-01 request
              request created, no approval                      (request type:
              chain touched at all                               accounting.fiscal_period.close
                                                                   — SAME type used for both
                                                                     first close and reclose)
                                                                              │
                                                                  Checker decides
                                                                  (accounting.fiscal_period.approve
                                                                   — segregation of duties already
                                                                     enforced, unchanged)
                                                                              │
                                                                     Approved ──► Apply the transition
                                                                     that matches the period's CURRENT
                                                                     state at decision time, re-checked
                                                                     under lock (same defensive pattern
                                                                     ADR-046 D10 already uses for
                                                                     FiscalYear.close):
                                                                        soft_close → closed   (action 'close')
                                                                        reopened   → closed   (action 'close_after_reopen')
                                                                              │
                                                                    Generate Immutable Snapshot (§4)
                                                                    — supersedesSnapshotId set to the
                                                                      prior snapshot's id IF this was
                                                                      a reclose, else null
                                                                              │
                                                                     Period is 'closed' + locked
```

### 1.4 Full lifecycle example (matches the review's own naming)

```
2026-09: open → soft_close → [Audit clean] → FA-01 approved → close
         ⇒ Snapshot "September Close #1"                (supersedesSnapshotId = null)

Later:   closed → reopen requested → FA-01 approved → reopened
         ⇒ audit trail entry "September Reopen #1" (existing FA-01 record, A.1)

         reopened → adjustments posted (new workflow state,
                    informational only, no gate — see 1.5)
         ⇒ audit trail entries "September Adjustment" (ordinary posted
           financial events/journals, already fully traceable — no new
           mechanism needed here)

         reopened → submitPeriodClose() again → [Audit clean] →
         FA-01 approved → close_after_reopen
         ⇒ Snapshot "September Close #2"  (supersedesSnapshotId =
           "September Close #1"'s snapshot id)
```

Any number of reopen/reclose cycles is naturally supported — the process
definition already allows `closed → reopened → closed → reopened → ...`
indefinitely; nothing here caps it.

### 1.5 What is *not* proposed to change

- `soft_close` and `reopen_from_soft_close` (routine, ungated,
  pre-commitment states) stay exactly as they are — gating those would
  slow down ordinary month-end housekeeping for no control benefit; nothing
  irreversible happens until `close`/`close_after_reopen`.
- `reopen` itself (routine transition FROM `closed`) stays FA-01-gated
  exactly as ADR-046 already built it — unchanged.
- No new "adjustment period" sub-state is proposed. Between `reopened` and
  the next `submitPeriodClose` call, the period simply behaves like any
  `reopened` period does today (`assertOpenForPosting` already treats
  `reopened` as postable) — adjustments are ordinary, already-traceable
  postings. Introducing a distinct `adjustments_in_progress` label (as
  Revision 1's draft state machine sketched) is **not** carried forward
  into this final version — it added a label with no corresponding gate or
  entity, i.e. cosmetic, not control. If the review wants adjustments
  during a reopen to be visibly grouped/reported as a set, that is better
  served by the snapshot's own `supersedesSnapshotId` linkage (§4) showing
  "everything posted between snapshot N and snapshot N+1," not a new state.

### 1.6 Open sub-decision (also in §5 as Decision 3)

Should a **reclose** require the *same* approval matrix rule as a first
close, or a stricter one (e.g. a second, higher-authority approver,
reflecting that a reopened-and-adjusted period is inherently more sensitive
than a routine first close)? `ApprovalEngineService.upsertMatrixRule`
already supports a distinct rule per request type — so if the CTO wants
stricter reclose approval later, it is a **matrix-rule/configuration
change**, not a redesign, *provided* reclose is given its own request-type
code now rather than reusing `accounting.fiscal_period.close` verbatim.
**Recommendation:** give reclose its own request-type code —
`accounting.fiscal_period.reclose` — from the start (cheap now, expensive to
retrofit), even though V1 can point it at the identical matrix rule
(`minApprovers`, `requiredPermissionNode`) as the first-close type. This is
flagged as Decision 3 in §5, not decided unilaterally here.

---

## 2. Final Exception Classification Policy

### 2.1 Two separate fields, not one

The review's own list (`BLOCKING`, `INFORMATIONAL`, `EXPECTED_BUSINESS_
REJECTION`, `HISTORICAL_TEST_ARTIFACT`, `CONFIGURATION_EXCEPTION`, ...) mixes
two different questions. This study proposes splitting them explicitly,
because conflating them is exactly how a blanket rule like `REJECTED =
INFORMATIONAL` happens in the first place:

- **`severity`** — the GATE-relevant field. Exactly two values:
  `BLOCKING` | `INFORMATIONAL`. This is the only field
  `PeriodClosingOrchestrationService` reads to decide whether to refuse
  `submitPeriodClose`.
- **`category`** — the ROOT-CAUSE classification. Six values (below).
  Explains *why* a finding exists, drives its default `severity` **and**
  its `requiredAction`, and is what gets reviewed/audited/reported — but
  never read directly by the close-gate itself.

`severity` is *derived* from `category` by the policy table below, plus one
scoping rule already implicit in Revision 1 and restated here explicitly:
**only reconciliation drift as-of the closing date, and only REJECTED events
whose `businessDate` falls inside the period being closed, are evaluated at
all.** An old rejected event from a period closed six months ago is not
re-litigated by closing a different period today (Revision 1's date-range
scoping already enforces this; restated here so §2's table is read
correctly).

### 2.2 The six categories

| Category | Applies to | Default `severity` | Rationale | Required Action |
|---|---|---|---|---|
| **`LIVE_DISCREPANCY`** | A reconciliation service (AR/AP/Cash-Bank/Inventory/Fixed-Asset) returned `drift_found` as of the closing date | **BLOCKING** | Subledger and GL disagree *right now* — the trial balance is definitionally incomplete or wrong until this is resolved. There is no "expected" or "historical" variant of a *current* mismatch. | Investigate the drift, post an approved correcting entry via the domain's own `*AdjustmentService` (never auto-corrected), then re-run the Closing Audit. |
| **`DORMANT_SOURCE`** | A reconciliation returned `no_subledger_source` / `no_valuation_source` | **INFORMATIONAL** | No comparison was possible at all (the operational contract for that subledger is not yet bound) — this is an architectural fact about the installation's current phase, not evidence of a mismatch. | None to close. Visible in the snapshot so a reviewer knows that domain's reconciliation was structurally inactive at closing time. |
| **`EXPECTED_BUSINESS_REJECTION`** | A `REJECTED` financial event whose rejection reason matches a **reviewed, named allowlist** of business-rule protections that fired correctly (e.g. `negative_on_hand` — the system correctly refused to post because the underlying operational transaction was itself invalid) | **INFORMATIONAL** | Nothing *should* exist in the GL for this event — the correct accounting outcome is exactly "not posted." | None to close. Retained in the snapshot for traceability — an auditor can see it was rejected and why. |
| **`CONFIGURATION_EXCEPTION`** | A `REJECTED` financial event whose rejection reason matches a **named pattern** identifying missing/unset Foundation configuration (e.g. "COGS account is unset," "treasury account is not GL-mapped") | **BLOCKING** | A *real* financial effect belonging to this period could not be posted, purely because of a fixable setup gap — closing now would understate the period's actual position. Unlike `LIVE_DISCREPANCY`, the fix here is a configuration change (this session's own COGS-account fix is the worked example), not a correcting journal. | Fix the configuration via its legitimate mechanism, then **explicitly redrive** the specific event (never a blanket redrive), then re-run the Closing Audit. |
| **`HISTORICAL_TEST_ARTIFACT`** | A `REJECTED` event **explicitly, individually annotated** by a permissioned reviewer as confirmed pre-production/test-only noise with no real financial meaning | **INFORMATIONAL** | Confirmed by a human, on the record, not inferred automatically. | None to close. The annotation (who, when, why) is retained permanently in the snapshot — this is itself evidence, not a way to make evidence disappear. |
| **`UNCLASSIFIED_REJECTION`** | A `REJECTED` event whose reason matches **none** of the above patterns | **BLOCKING** (fail-safe) | Unknown risk defaults to blocking, never to safe. This is the category that *replaces* the old blanket rule's silent "must be fine" assumption. | Investigate; either it turns out to fit an existing category (fix the pattern list, governed — see 2.4) or it is a genuine defect needing a real fix. |

### 2.3 Why `HISTORICAL_TEST_ARTIFACT` is deliberately the hardest category to reach

This is the one category that, if implemented carelessly, recreates exactly
the loophole the review warned about — a rejection quietly waved through.
Three hard constraints, proposed as non-negotiable for this category
specifically:

1. **Never auto-inferred.** No pattern-match, no date heuristic, no "this
   looks old" logic ever assigns this category automatically — only an
   explicit, individual, permissioned action on one specific event id.
2. **The annotation is itself permanent evidence.** Who annotated it, when,
   and their stated reason are stored and appear in every future snapshot
   that includes that event — an auditor sees the annotation, not a silent
   `INFORMATIONAL` with no history.
3. **Recommend restricting this category to non-Production environments by
   default**, with turning it on for a Production installation itself
   requiring an explicit decision (see §6) — a live customer's books should
   very rarely, if ever, need this category at all; its natural home is
   this project's own dev/test database, exactly as the team observed.

### 2.4 Governance of the pattern tables

The `EXPECTED_BUSINESS_REJECTION` and `CONFIGURATION_EXCEPTION` pattern
lists (which rejection-reason strings/prefixes map to which category) are
proposed as **versioned, code-reviewed data — not runtime-editable via the
Configuration Engine**, and **not** a category → severity mapping any single
admin can silently change. Rationale: these tables encode an accounting
judgment ("this kind of rejection can never represent missing money"), not
an operational parameter — the same governance level as adding a new
Financial Event handler, i.e. code review, not a settings screen. This is
listed as Decision 2 in §5 for explicit CTO confirmation, since "who owns
this table" was exactly what the review asked to have decided, not
defaulted.

---

## 3. Final Black Box Cryptographic Trust Model

### 3.1 Dedicated key vs. the existing Entitlement key — recommendation: **dedicated, installation-owned key**

Traced this revision, not assumed: the Entitlement Ed25519 public keys
(`manifest-verify.ts`) are supplied via `AppConfigService`, itself populated
from **environment-variable configuration** (`src/foundation/configuration/
app-config.service.ts`). In other words, the Entitlement key is a
**vendor-distributed** key baked into deployment configuration — it does not
belong to, and is not generated by, any individual installation. Three
independent reasons this makes it the wrong anchor for accounting evidence,
not just a "different domain" argument:

1. **Wrong ownership.** A Black Box proves "*this installation's* closing
   process approved *this* period's numbers." A key the vendor controls and
   can redeploy across every customer is not evidence of anything
   installation-specific — reusing it would mean any installation's
   snapshot verification depends on trusting the vendor's key management,
   not the installation's own accounting control.
2. **Disproportionate blast radius.** A licensing-key rotation or incident
   (vendor-side, entirely unrelated to any customer's books) would
   simultaneously touch the verifiability of every customer's historical
   accounting evidence, forever. These must be independent failure domains.
3. **Different lifecycle requirements.** A licensing key's rotation cadence
   can follow a product/release cycle. An accounting evidence key must
   remain verifiable for as long as the retention policy says (§J,
   recommended indefinite) — years beyond any given software release,
   independent of upgrade/entitlement cycles entirely.

**Recommendation:** generate one Ed25519 keypair **per installation**, at
first use of the Closing/Black-Box capability, held under the same
installation-secret custody mechanism this project already uses for its
other installation-level secrets (JWT signing secret, DB credentials) —
*which secret store that is, concretely, is a dependency to confirm at
implementation time, not assumed here* (this study does not have that
answer yet; flagged explicitly rather than guessed).

### 3.2 Key registry, not a single static key (rotation)

Reuse the **exact shape** already proven in `manifest-verify.ts` —
`{ kid, publicKey }` entries checked against a manifest's declared `kid`,
with `unknown_kid` as its own distinct, named failure — but as a **separate,
new, append-only registry** scoped to Closing snapshots only:

```
ClosingSnapshotSigningKey  (conceptual — not authored as a migration here)
  kid            (key id, e.g. a short random string or the key's own public fingerprint)
  publicKey
  validFrom
  validUntil     (null = currently active)
  createdByUserId
  reason         (e.g. "initial key," "scheduled rotation," "suspected compromise")
```

- Every snapshot manifest records the `kid` that signed it (§3.4).
- Rotating the key **only ever affects future snapshots** — it never
  invalidates or requires re-signing anything already written, because
  verification always looks up the `kid` the manifest itself declares, not
  "whichever key is active today." This is the property that makes
  indefinite retention (§J) survivable across key rotations that will
  inevitably happen over a multi-year installation lifetime.
- Rotation is itself a permissioned, audited action (`accounting.
  closing_snapshot.rotate_key`, new node — §5 Decision 8's sibling).

### 3.3 Verification — three independent, separately-reported checks

Mirrors `manifest-verify.ts`'s existing "tampered / unparseable / unsigned /
unknown-kid / expired" discipline — never one opaque "invalid":

1. **Content hash check** — recompute the canonical hash (§3.4) of the
   stored snapshot body, compare to the hash recorded in its manifest.
   Mismatch ⇒ *the snapshot content itself was altered.*
2. **Signature check** — verify the Ed25519 signature over the canonicalized
   manifest against the public key named by the manifest's `kid`, looked up
   in the registry (§3.2). Failure ⇒ *the manifest was altered, or signed
   with a key not in the registry.*
3. **Chain check** (only when `supersedesSnapshotId` is set) — confirm this
   manifest's `previousManifestHash` matches the predecessor snapshot's
   actual manifest hash. Mismatch ⇒ *the reopen/reclose sequence for this
   period has been spliced or reordered.*

All three are reported independently on a verify call — a caller (including
a future external auditor tool) sees exactly which property failed, never a
single boolean.

### 3.4 Manifest format (conceptual JSON shape — not authored as code)

```json
{
  "manifestVersion": "1.0",
  "fiscalPeriodId": "...",
  "periodCode": "2026-09",
  "closeSequence": 1,
  "supersedesSnapshotId": null,
  "previousManifestHash": null,
  "generatedAt": "2026-10-01T00:03:11Z",
  "generatedByUserId": "...",
  "approvalRequestId": "...",
  "appVersion": "...",
  "migrationHead": "...",
  "configVersion": "...",
  "contentHash": "sha256:...",
  "signingKeyId": "kid-...",
  "signature": "base64(Ed25519 signature over the canonicalized manifest, signature field excluded)"
}
```

`contentHash` and `signature` reuse the **same canonicalization technique**
identified in Revision 1 (§A.4/§A.5, `sortDeep`-style recursive key sorting)
— proposed to be consolidated into one shared utility as implementation step
1 (Revision 1 §M.1), used identically by the audit hash-chain, the
Entitlement manifest signer, and this manifest. One proven technique, three
consumers — not three implementations of the same idea.

### 3.5 Hash-chain vs. single snapshot hash vs. both — recommendation: **both, at two different scopes**

- **Every** snapshot always carries its own `contentHash` (§3.4) — proves
  "this snapshot's data, on its own, has not been altered." Always present,
  the primary and simplest guarantee.
- **Additionally**, snapshots belonging to the **same fiscal period** across
  a reopen/reclose sequence are chained via `previousManifestHash` — proves
  "the sequence Close #1 → Reopen #1 → Close #2 for *this period* is intact
  and nothing was inserted, removed, or reordered." This chain is
  deliberately **scoped to one period's own history**, not global.

**Explicitly not recommended:** inserting Black Box snapshots into the
*same* global sequential chain `audit-hash.ts` already maintains for
`audit_records`. That chain is correct and load-bearing for what it already
protects (the full system's chronological action log); forcing an unrelated
document type (a periodic, period-scoped accounting artifact) into the same
total ordering would entangle two evidence types with different retention
policies, different verifiers, and different consumers (an external auditor
handed a Black Box should not need the entire system's audit log to verify
it) for no additional integrity benefit the narrower per-period chain
doesn't already provide.

### 3.6 Failure / recovery

Period-lock (the `FISCAL_PERIOD_PROCESS` transition + its audit record) and
snapshot **generation** are two different kinds of operation — one is a DB
transaction, the other includes filesystem I/O — and should not be forced
into one atomic step. **Recommendation:** model snapshot generation the same
way this codebase already models "commit the fact, deliver the effect
separately" — the Transactional Outbox pattern (`EventBusService`) already
used everywhere else in this project. Concretely: the approval-applied
transaction commits the period-lock + its audit record (as it already does
today); a snapshot-generation record is written in the *same* transaction
with a `pending` status; the actual file assembly/hash/sign happens
immediately after, outside that transaction, and a periodic reconciliation
job (mirroring `EventBusService.dispatchPending()`) finds any `closed`
period whose snapshot is still `pending` and retries — so a crash mid-
assembly can never silently leave a locked period with no evidence and no
record that evidence is owed.

### 3.7 Storage and backup

Content-addressed immutable file (Revision 1 §F.4, unchanged) plus: the
Black Box archive directory should be included in the **existing**
`BackupManagerService` disaster-recovery scope (it already archives a
configured media path) — restated explicitly because Revision 1's §12 (from
the original team message) drew a correct conceptual line between "Backup"
and "Black Box," which this study fully preserves (a restore-from-backup
never *replaces* live accounting evidence), but the evidence files
themselves are still ordinary files that a real disaster could destroy, and
therefore still need to be *included in*, not confused with, disaster
recovery.

---

## 4. Final Black Box Contents & Lifecycle (consolidated)

Unchanged from Revision 1 §F.1's content table; restated here as the
single authoritative lifecycle, incorporating §1–§3 above:

```
Closing Audit (classified per §2)
   ↓  (zero BLOCKING exceptions)
Exception Resolution  [only reached if BLOCKING exceptions existed; each
                        resolved/waived exception is itself evidence — §5
                        Decision 1 on whether a waiver path exists at all]
   ↓
Final Reconciliation  [a fresh, post-resolution Closing Audit run — must
                        independently come back clean; not assumed from
                        the first pass]
   ↓
Approval (FA-01 — §1.3, same gate for first close and reclose)
   ↓
Period Lock  (FISCAL_PERIOD_PROCESS → closed)
   ↓
Generate Snapshot → Canonicalize → Hash → Sign (§3) → Immutable Archive (§3.7)
```

Reopen path (§1.4), unchanged in concept from the team's own message,
now concretely wired to the mechanisms above:

```
Period Lock (closed)
   ↓
Reopen → Adjustment → Closing Audit → Approval → Reclose (§1.3, same gate)
   ↓
New Snapshot, chained to the original via previousManifestHash (§3.5),
while the ORIGINAL snapshot file and its hash remain byte-for-byte
untouched, forever (§3.2's key-registry design ensures it stays verifiable
even after a future key rotation).
```

---

## 5. Architecture Decision Matrix — all 9 decisions

| # | Decision | Options | Current-system impact | Security impact | Accounting impact | Operational impact | Recommendation | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Override/waiver mechanism for a BLOCKING exception | (a) None — a BLOCKING exception can never be closed over; (b) a designed, permissioned, evidenced override path | None if (a); a new permissioned action + its own evidence record if (b) | (b) creates a new privileged action that must itself be tightly scoped and logged, or it becomes the loophole the whole engine exists to prevent | (a) is the stricter accounting control; (b), done carelessly, could let a real discrepancy be closed over | (a) may occasionally block a close on a discrepancy that is well-understood but slow to fix formally; (b) adds workflow complexity | **(a) for V1** — no override path. A BLOCKING exception is resolved by fixing the underlying data/config, never bypassed. Revisit only if real operations show a legitimate, recurring need. | **New Decision** |
| 2 | Exception classification pattern-table ownership | (a) Versioned, code-reviewed data (ADR-governed); (b) live-editable via Configuration Engine by any admin | (a) matches how financial-event handlers are already governed; (b) reuses the existing Configuration Engine plumbing | (b) lets a single compromised/careless admin account silently widen what counts as "safe to close over" | This table directly encodes accounting judgment about what a rejection means | (a) requires a code change + review for every new pattern; (b) is instant but ungoverned | **(a)** — code-reviewed, versioned, not runtime-editable. §2.4. | **New Decision** |
| 3 | `close_after_reopen` gating | (a) Leave as a routine, ungated transition (today's behavior); (b) require the same FA-01 + Closing Audit gate as first close, via its own request-type code | (b) removes an existing, currently-reachable routine action — a real behavior change to F13 | (b) closes a real control gap the review identified; (a) leaves it open | (b) guarantees every close, first or repeat, is equally evidenced — matches the review's explicit "no silent shortcut" requirement | (b) means a reclose can no longer happen instantly/unilaterally — by design | **(b)**, with reclose given its **own** request-type code (`accounting.fiscal_period.reclose`) so its approval matrix can later be made stricter without a redesign (§1.6). | **New Decision (real behavior change — needs explicit sign-off)** |
| 4 | Black Box signing key | (a) Reuse the existing Entitlement Ed25519 key; (b) generate a dedicated, installation-owned key | (b) is new infrastructure (key generation + registry); (a) reuses code already present | (a) entangles two unrelated trust domains and blast radii (§3.1); (b) isolates them | Accounting evidence needing to remain verifiable for years, independent of licensing-key rotation, favors (b) | (b) requires a key-custody decision (where the private key lives) not yet made elsewhere in this project | **(b)**, dedicated key, custody mechanism to be confirmed against this project's existing installation-secret storage at implementation time (§3.1, not assumed here). | **New Decision, grounded** |
| 5 | Snapshot storage location | (a) Local filesystem, content-addressed (mirrors `BackupManagerService`); (b) dedicated object store | (a) needs zero new infrastructure; (b) depends on a deployment-target decision (on-prem vs. cloud) not made elsewhere in this project | Both can be made equally tamper-evident (the hash/signature, not the storage medium, is what proves integrity) | No difference — integrity comes from §3, not from where the bytes sit | (b) adds an external dependency; (a) is simplest given Production is currently on-prem/HOLD | **(a)** for V1, revisit only if/when a cloud deployment target is separately decided. | **New Decision, low-risk default** |
| 6 | Retention/archival for reconciliation & closing-audit run history | (a) Indefinite, same as snapshots; (b) time-boxed/archived after N years | Neither needs new code beyond a future archival job if (b) | No security difference | These are the *evidence trail behind* each snapshot — deleting them weakens the snapshot's own provenance story even though the snapshot itself is self-contained | (a) grows the database unboundedly over years; (b) needs a defined "N" and an archive target | **(a) for now** — do not build a deletion/archival mechanism speculatively; revisit if/when data volume actually becomes an operational problem. | **New Decision, deferred by design** |
| 7 | Performance strategy for repeated 5-way reconciliation sweeps | (a) Always recompute fresh on every audit run (today's behavior); (b) incremental/memoized, invalidated on new posting | (b) is new caching infrastructure; (a) is already built and proven | No security impact | (a) guarantees the Final Reconciliation is always computed against the true current state — no staleness risk; (b) introduces a staleness/invalidation-correctness risk in a place where correctness matters most | (a) costs a few seconds per run today; at large scale (years of GL history, many branches) this needs re-measurement | **(a) for V1** — closing is inherently low-frequency and human-paced; do not add caching complexity to a correctness-critical path before real data proves it necessary. Re-benchmark at the point a real installation's reconciliation sweep is observed to be slow. | **New Decision, deferred by design** |
| 8 | Snapshot View/Verify permission scope | (a) Inside the existing `accounting.*` role surface only; (b) a dedicated, narrower (or external-auditor-facing) role | (b) is new permission-manifest surface | (b) done well *reduces* risk (narrower access than full `accounting.*`); done poorly adds another role to maintain | An external auditor being able to verify a snapshot without broader accounting access is a genuine, real-world-useful capability | (b) is more setup work now for a benefit that may not be needed until an actual external audit happens | **(a) for V1** (`accounting.closing_snapshot.view` / `.verify` as new leaf nodes under the existing `accounting.*` tree, §H) — defer a dedicated external-auditor role until there is a real auditor workflow to design it against. | **New Decision, deferred by design** |
| 9 | Consolidation / multi-entity closing | (a) Design for it now; (b) explicitly park it, keep new entities free of single-entity assumptions | (a) is significant scope not requested; (b) is a discipline applied while building §1–§4, not a feature | No security impact | Multi-entity consolidation is a real, larger future capability, not designed here | (b) costs nothing now; (a) would delay this entire deliverable | **(b)** — parked, per the directive's own §14 instruction. Every entity/service name proposed in this study is written so it does not hardcode "one entity" (e.g. `orgUnitId`-scoped throughout, matching how `FiscalYear`/`FiscalPeriod` already work), but no consolidation workflow is designed. | **Parked by instruction, not a gap** |

**Legend applied above:** every row is either an **Already Existing /
Reusable** primitive being pointed at (none of the 9 decisions themselves
are — they are all genuinely open questions; the *reusable* pieces are
`audit-hash.ts`, `manifest-verify.ts`/`canonicalize.ts`, and
`BackupManagerService`, all cited by name in §1–§4 above and in Revision 1),
a **Gap** in the current system (Decisions 3 is the one true behavior-change
gap), or a **New Decision** this study is recommending a position on while
still surfacing it for explicit approval rather than deciding it silently.

---

## 6. Explicit list of everything requiring CTO approval before implementation

1. **Removing `close_after_reopen` from the routine `transitionPeriod`
   endpoint** and requiring it to go through the same gated path as `close`
   (Decision 3) — a real behavior change to existing, already-shipped F13
   functionality, not purely additive like everything else this project has
   built so far this cycle.
2. **Giving reclose its own request-type code** (`accounting.fiscal_period.
   reclose`) versus reusing `accounting.fiscal_period.close` verbatim (§1.6)
   — affects the FA-01 approval-matrix surface.
3. **No override/waiver mechanism in V1** (Decision 1) — confirm this is
   acceptable; a BLOCKING exception will have no bypass, by design, until a
   real operational need justifies designing one.
4. **Exception classification pattern tables are code-governed, not
   Configuration-Engine-editable** (Decision 2) — confirm this governance
   model, since it constrains who can adjust classification later.
5. **`HISTORICAL_TEST_ARTIFACT` category's Production posture** (§2.3) —
   confirm whether this category should even exist as an option in a
   Production build, or be compiled out / hard-disabled outside dev/test
   environments.
6. **Dedicated Black Box signing key** (Decision 4) — confirm the
   direction, and separately confirm *where* the private key will actually
   be held once this project's existing installation-secret-custody
   mechanism is identified (this study flags the dependency; it does not
   yet know the answer).
7. **Filesystem-based, content-addressed storage for V1** (Decision 5) —
   confirm, given no cloud deployment target has been separately decided
   for this project yet.
8. **Deferred decisions 6–8** (retention/archival, reconciliation
   performance strategy, snapshot-permission scope) — confirm "decide later,
   when real data/usage justifies it" is an acceptable posture for V1
   rather than requiring an answer now.
9. **Consolidation/multi-entity closing stays parked** (Decision 9) —
   confirm no work should anticipate it beyond the existing `orgUnitId`
   scoping already present.

---

# Revision 1 — Current-State Audit & Gap Analysis (unchanged, kept as the baseline)

*(Preserved in full below exactly as accepted. Nothing in Revision 2 above
contradicts it; §1–§5 above are the resolution of this revision's own §L
Open Decisions 2, 3, and 4.)*

## A. Current State

Audited directly against the live source tree before writing anything below —
not from memory of prior sessions.

### A.1 Fiscal Year / Fiscal Period (F01 + F13/ADR-046)

`FiscalYear` and `FiscalPeriod` carry **no status column** — every read
resolves live state via `ProcessEngineService` (`src/foundation/process-engine`),
the same convention `SalesOrder` and every other lifecycle entity in this
codebase uses. Defined state machines
(`src/domains/accounting/domain/process-definitions.ts`):

```
FiscalYear:    planned --activate--> active --close--> closed

FiscalPeriod:  open --soft_close--> soft_close --close--> closed
               soft_close --reopen_from_soft_close--> open
               closed --reopen--> reopened
               reopened --close_after_reopen--> closed
```

`FiscalPeriodService` (`src/domains/accounting/application/fiscal-period.service.ts`):

- `soft_close`, `reopen_from_soft_close`, `close_after_reopen` are **routine**
  transitions (`transitionPeriod`, plain `accounting.fiscal_period.edit`
  permission, no approval).
- `close` and `reopen` are **FA-01-gated** (Generic Approval Engine, ADR-033):
  `submitPeriodClose`/`submitPeriodReopen` create a maker request; a
  **different** user with `accounting.fiscal_period.approve` decides it
  (segregation of duties enforced by `ApprovalEngineService` itself — a maker
  cannot approve their own request, verified live earlier this session with a
  second real test user). The approved side effect is applied by a
  self-registered subscriber on `approval.request.approved`, defensively
  idempotent (checks current state first; treats "already applied" as a
  benign no-op, never an error, on a duplicate delivery).
- `FiscalYear.close` additionally re-validates, **at decision time, under a
  row lock**, that every child period is still `closed` (a period can be
  reopened during the unbounded approval window) — rejects the side effect
  only, leaves the approval record itself immutable.
- `assertOpenForPosting` is the precondition every poster must call: resolves
  the covering `FiscalYear` (must be `active`) and `FiscalPeriod` (must be
  `open` or `reopened`) for a given `businessDate`.
- Full audit trail already exists for every transition (`AuditService.record`,
  see A.4) and both `*.status_changed` events are published on the
  Transactional Outbox.

**Important, concrete finding:** `close_after_reopen` is currently a
**routine, non-gated** transition — it does not go through FA-01 approval and
does not run any reconciliation/audit check. This is the "reclose after
adjustment" step the target flow (§8/§11 of the directive) explicitly needs to
be evidenced and gated. **Resolved in Revision 2 §1.**

### A.2 Closing Audit Engine (ADR-050 — implemented earlier this session)

`ClosingAuditService` (`src/domains/accounting/application/closing-audit.service.ts`)
already **orchestrates** (does not reimplement) the five reconciliation
services below for one `FiscalPeriod`, and already hard-gates
`submitPeriodClose` on the result — implemented, migrated, and E2E-verified
against both a historical period (correctly blocked on a documented ADR-041
D23 inventory-valuation limitation, cross-checked byte-for-byte against the
standalone reconciliation endpoint) and the live current period (correctly
surfaced real AR/Cash-Bank/Inventory drift as `blocking`, and all 26
currently-`REJECTED` financial events as `informational`, zero misclassified).

Current shape (relevant to the Gap Analysis below):

- One `ClosingAuditRun` row per invocation, `exceptions` stored as a single
  **JSONB array**, not individual rows.
- Exception shape today: `{ severity, domain, code, message, refId }` —
  narrower than the target `Period → Module → Document → Transaction →
  Account/Subledger → Amount → Source → Problem → Severity → Required Action`
  shape requested in §5.
- Classification today is a **fixed, per-domain rule baked into the
  orchestration code**: any reconciliation `drift_found` is `blocking`;
  every `REJECTED` financial event in the period is `informational`,
  unconditionally. This is exactly the blanket rule §5 of the directive says
  not to rely on. **Resolved in Revision 2 §2.**
- No persisted per-exception **resolution lifecycle** — every call recomputes
  fresh; there is no "acknowledged / resolved / waived" state to record who
  handled an exception and how.
- No distinct **Final Reconciliation** step — the same audit run doubles as
  the pre-check and the last-mile check, always recomputed fresh at
  submission time.

### A.3 The five existing reconciliation services (read-only, never auto-correct)

All five share one interface shape (`reconcile(input, actorUserId)` →
`matched | drift_found | no_subledger_source|no_valuation_source`), all
SQL-`NUMERIC` arithmetic, all persisted as their own `*_reconciliation_runs`
row:

| Domain | Service | Status states | Notes |
|---|---|---|---|
| AR | `ArReconciliationService` | matched / drift_found | Always active (`FINANCE_CUSTOMER_LEDGER_CONTRACT` non-optional) |
| AP | `ApReconciliationService` | matched / drift_found / no_subledger_source | Optional contract, now bound (Procurement, ADR-048) |
| Cash/Bank | `CashBankReconciliationService` | matched / drift_found | Per-treasury-account, always active |
| Inventory | `InventoryReconciliationService` | matched / drift_found / no_valuation_source | Optional contract, now bound (Inventory Valuation) |
| Fixed Asset | `FixedAssetReconciliationService` | pairs[], each with 3 independent matched booleans | No persisted run entity — computed on demand only |

None of the five ever posts a correcting entry — drift is a diagnostic, a
human posts an approved adjustment (`ArAdjustmentService`,
`ApAdjustmentService`, etc.). This "read-only reconciliation, human-approved
correction" discipline is a hard invariant already established across F04–F08
and should not be revisited by this study.

### A.4 Audit Trail — already tamper-evident (`foundation/audit`)

**Directly load-bearing discovery for the Black Box design.** `AuditService`
already writes a **SHA-256 hash chain** (`foundation/audit/audit-hash.ts`):
every audit record's hash commits to its own content **and** the previous
record's hash (`GENESIS_HASH` at position 0), so both single-record tampering
and chain-splicing are detectable. It uses a **deterministic, recursively
key-sorted JSON serialization** (`sortDeep`) specifically because PostgreSQL's
`jsonb` storage does not preserve key order — a real bug (Commercial Release
Gate finding SEC-10) was found and fixed here: hashing with plain
`JSON.stringify` against a read-back `jsonb` row failed 100% of the time on
completely untampered data. This canonicalization discipline is exactly what
any new snapshot-hashing code must reuse, not reinvent.

### A.5 Signed-manifest infrastructure — already exists (`foundation/entitlement`)

A second, independently mature piece of prior art: Entitlement Manifests are
signed with **Ed25519** (`foundation/entitlement/manifest-verify.ts`, native
Node `crypto`, no external dependency), over a **canonical JSON** serialization
(`foundation/entitlement/canonicalize.ts`, RFC 8785/JCS-style, arrays keep
order, keys sorted — the same problem A.4 solved, solved independently in a
different subsystem). `manifest-verify.ts` already handles a tampered /
unparseable / unsigned / unknown-key-id / expired manifest, all as named,
distinguishable failure modes, not one opaque "invalid." **Revision 2
finding:** the public keys it verifies against are sourced from
`AppConfigService`, itself populated from environment-variable configuration
— i.e. vendor-supplied, not installation-generated (§3.1).

### A.6 Backup / immutable-artifact pattern — already exists (`foundation/release`)

`BackupManagerService` is the existing pattern for "produce an artifact,
checksum it, record it, retain it": independent DB-dump and media-archive
artifacts, each checksummed (`computeFileChecksum`) and verified, each
recorded as `BackupRun`/`BackupArtifact` rows, with a documented retention
floor (`MIN_KEEP_RUNS = 3` — "do not assume a single backup file is
sufficient," a direct CTO directive already on record). This is the closest
existing analog to "produce the Black Box artifact and keep N of them," and
is proposed below as the storage-pattern template — **not** reused directly
(a backup is disaster-recovery-oriented and mutable-by-restore; the Black Box
is accounting-evidence-oriented and must never be restorable-over).

### A.7 Financial Event Engine (F03/ADR-035) and GL

Already fully audited and E2E-verified earlier this session (separate
verification, not repeated here): outbox-based delivery, `UNIQUE
(idempotencyKey)` as the sole concurrency control, fail-closed REJECTED
handling with a visible reason and an explicit, non-automatic `POST
.../redrive` endpoint, one event → one journal (proven 20 POSTED events ↔ 20
distinct journals, zero duplicates), every journal balanced by construction.
Nothing here needs to change for this study.

### A.8 Permission Engine

Dotted-node ancestor-walk (`accounting.fiscal_period.*`), existing nodes:
`accounting.fiscal_period.view`, `.edit`, `.reopen`, `.approve` (the last
being F13's FA-01 checker node, ADR-046 D5). **No** `closing_exception.*` or
`closing_snapshot.*` nodes exist today — confirmed by direct read of
`accounting.manifest.ts`.

### A.9 Related ADRs already on record

ADR-035 (Financial Event Engine), ADR-036/037/038/040 (AR/AP/Cash-Bank/
Inventory reconciliation), ADR-041 (Inventory Valuation, including the D23
"no historical reconstruction in F08 V1" invariant this study must respect,
not route around), ADR-045 (Fixed Assets), ADR-046 (F13 Financial Closing),
**ADR-049** (this capability's own prior deferral record), **ADR-050**
(Closing Audit Engine, implemented). This study supersedes none of them; it
proposes to extend ADR-050 and, where noted, to correct a narrow gap in
ADR-046's scope (A.1's `close_after_reopen` finding).

---

## B. Gap Analysis

Numbered so each can be referenced from the Open Decisions list (§L).

**B.1 — `close_after_reopen` is ungated.** Today it is a routine transition:
no FA-01 approval, no Closing Audit, no snapshot. **Resolved: Revision 2 §1.**

**B.2 — Exception classification is a hardcoded rule, not a policy.**
**Resolved: Revision 2 §2.**

**B.3 — Exceptions are not first-class, resolvable records.** They are
recomputed into a JSONB array on every run; there is no persisted identity,
no resolution workflow (acknowledged/resolved/waived), no
`Period/Module/Document/Transaction/Account/Amount/Source/Problem/Severity/
RequiredAction` shape, and no reviewer/timestamp trail per exception.
*(Structural gap — see C.1; carried forward, not yet built.)*

**B.4 — No override/waiver mechanism exists.** **Resolved as a position:
Revision 2 §5 Decision 1 — none in V1.**

**B.5 — No distinct "Final Reconciliation" step.** *(Carried forward — see
C.1/C.3 and Revision 2 §4's consolidated lifecycle.)*

**B.6 — No Black Box / snapshot capability exists at all.** *(Carried
forward — see C.4/F and Revision 2 §3/§4.)*

**B.7 — No retention policy for reconciliation/closing-audit history.**
**Resolved as a position: Revision 2 §5 Decision 6 — indefinite, deferred
archival design.**

**B.8 — No consolidation/multi-entity closing model has been examined.**
**Resolved as a position: Revision 2 §5 Decision 9 — parked.**

---

## C. Target Architecture (carried forward from Revision 1, still current)

**C.1 — `ClosingException` becomes a first-class entity**, replacing the
JSONB array (still produced by the same orchestration, just persisted
per-row instead of per-array-element). Proposed shape (conceptual — no
schema authored here), now aligned to Revision 2 §2's category/severity
split:

```
ClosingException
  id
  closingAuditRunId        (FK — which run raised/last-confirmed it)
  fiscalPeriodId
  module                   (ap | ar | cash_bank | inventory | fixed_asset | financial_events)
  documentType / documentId       (the business document, when one exists)
  transactionRef                  (journal entry / financial event id, when one exists)
  accountOrSubledgerRef            (GL account id / subledger party id)
  amount
  source                    (which check raised it — reconciliation code / rejection reason)
  category                  (LIVE_DISCREPANCY | DORMANT_SOURCE | EXPECTED_BUSINESS_REJECTION |
                              CONFIGURATION_EXCEPTION | HISTORICAL_TEST_ARTIFACT | UNCLASSIFIED_REJECTION)
  severity                  (blocking | informational — DERIVED from category, §2.1)
  problem                   (human-readable statement)
  requiredAction            (human-readable next step, from the category table, §2.2)
  status                    (open | acknowledged | resolved | waived)
  resolvedByUserId / resolvedAt / resolutionNote  (when applicable)
  annotation                (only for HISTORICAL_TEST_ARTIFACT — who/when/why, §2.3)
```

**C.2 — The classification policy (Revision 2 §2) is implemented as a small,
versioned rule module**, not inline conditionals — code-reviewed, not
Configuration-Engine-editable (Decision 2).

**C.3 — `PeriodClosingOrchestrationService`** (evolves `ClosingAuditService`,
does not replace the five reconciliation services it already calls):
sequences the five target-flow steps explicitly (Closing Audit → Exception
Resolution gate → Final Reconciliation → Approval submission → Period Close
→ Period Lock), each step leaving its own audit trail entry, so — unlike
today's single recomputed call — the evidence for "was this Blocking-clean at
the moment of approval" is a persisted fact, not an assumption. Also owns the
unified `submitPeriodClose` entry point described in Revision 2 §1.3.

**C.4 — `ClosingSnapshotService`** — new, builds the Black Box per Revision 2
§3/§4. Subscribes to the SAME `approval.request.approved` event
`FiscalPeriodService` already subscribes to (no new event type needed),
filtered to the closing-relevant request types (including the new
`accounting.fiscal_period.reclose` type, Revision 2 §1.6), firing only after
the transition has actually applied.

**C.5 — Two new entities for the Black Box** (conceptual, mirroring
`BackupRun`/`BackupArtifact`): `ClosingSnapshotRun` (metadata + hash +
signature + `supersedesSnapshotId` + link to the artifact) and the artifact
itself stored as an immutable file, not a mutable JSONB column. Plus, per
Revision 2 §3.2, a `ClosingSnapshotSigningKey` registry entity.

---

## D–M (Revision 1, unchanged)

Sections D (state machine sketch), E (exception model sketch), F (Black Box
architecture sketch), G (reopening model sketch), H (permissions), I
(auditability), J (retention), K (performance/scale), L (open decisions), and
M (implementation sequence) from Revision 1 are **superseded in their
specifics by Revision 2 §1–§6 above** wherever the two disagree — Revision
2's versions are the final proposals — but are not reproduced a second time
here to avoid duplication. The original Revision 1 text remains available in
this document's history for anyone who wants to see how §1–§6 were derived
from first principles before being finalized.

---

**Final rule, restated:** this document is study and design only. No file
under `src/` was created or modified to produce it or its Revision 2. Build
begins only after the Decision Matrix (§5) and the explicit CTO-approval
list (§6) above have been reviewed and answered.
