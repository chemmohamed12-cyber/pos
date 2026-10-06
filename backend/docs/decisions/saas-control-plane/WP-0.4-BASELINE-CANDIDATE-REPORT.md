# WP-0.4 — Stable Source / Ownership Gate — Baseline Candidate Report

**Date:** 2026-10-05 15:45–15:50 · Lane A, inventory + attribution + hashing only. No cleanup, revert, merge, code, migration, schema, refactor or implementation. No architecture change.
**Result at 2026-10-05:** **BLOCKED — CTO issue raised** (stop conditions 1, 3 and 4 — §4). **Baseline candidate: NOT READY.** Evidence: `evidence/wp04/`.

## 1. Source identification
| Item | Value |
|---|---|
| Repository / branch / HEAD | `…/release-new` · `master` · `4bb71f8391321b883b40145b2b5fb6c233048fa2` |
| Changed-tree entries (start, 15:45:59) | **580** = 279 modified + 301 untracked + 0 deleted (`git status --porcelain=v1 -uall`; ignored paths such as `node_modules`/`dist` excluded) |
| Start TREE MANIFEST sha256 | `505cc4947fca883e9c65918c1c60dfdf043e16a16b07bf5451c2a02620b23f92` |
| End TREE MANIFEST sha256 (15:49:12) | `ee57a90d1fa81b0be5c05c0d433634df42c98c4e50b0e4aeefbb2a357dc53c04` |
| **Source integrity** | **NOT ESTABLISHED** — the manifests differ: 3 files changed during the pass (`AREA21-RETROFIT-MATRIX.md`, `D7-NEW-ITEM-REQUEST-2026-10-05.md`, `D8-FIXED-ASSET-ACQUISITION-LINK-2026-10-05.md`, mtimes 15:47), i.e. other workstreams are still writing. No file was added or removed. |

## 2. Method (evidence only — no "I think this belongs to")
- **Strong evidence:** a Write/Edit tool call recorded in a session transcript, **deduplicated by tool-call id** (forked sessions share pre-fork history; the pre-fork events of this lane and "Multi-Company front" are one common ancestry, not two writers).
- **Documented evidence:** the Area 21 matrix's own "Files changed" lists, accepted only when the file's mtime is inside the retrofit window (≤ 2026-10-04).
- **Late modification:** mtime more than 10 minutes after the last evidenced write ⇒ modified by an unevidenced means.
- **Hint only (explicitly NOT ownership evidence):** a script/command in some session naming the file within 20 minutes of its mtime — recorded in `unattributed_hints.tsv` to help owners attest; it never changes a status.
- No evidence ⇒ **UNATTRIBUTED**.

## 3. Classification (A–E groups mapped to the five statuses)
| Status | Files | Notes |
|---|---|---|
| **OWNED / VERIFIED** (A — current Control Plane documentation) | **25** | this lane; read-back verified |
| **TEST-ONLY** (E) | **7** | this lane's untracked characterization specs/helpers |
| **HISTORICAL / ALREADY VERIFIED** (C) | **144** | Write/Edit evidence only from this lane's lineage (incl. pre-fork ancestry) with no later foreign write, or documented in the Area 21 matrix within its window. *GL files remain "technically verified — pending ratification".* |
| **FOREIGN / NEEDS RE-PROOF** (B) | **306** | foreign Write/Edit evidence; **51 are MIXED** (this lineage **and** foreign writes — closed-area files a foreign session touched); **104** also show a later unevidenced modification. Writers by evidence: Multi-Company front, DAII HR (fork), DAII HR, DAII manfacturing, and older HR/Payroll/Attendance/frontend-recovery sessions (ids in the manifest) |
| **UNATTRIBUTED** (D) | **98** | no Write/Edit evidence in any transcript and not documented; 89 carry a time-correlated *hint* (not evidence; groups overlap): Multi-Company front 40, DAII HR (fork) or its continuation 41, this lane 13 (several co-named with another session), none 9 |
| **Total** | **580** | |

Older HR/Payroll/Attendance workstream files are classed FOREIGN because this lane holds **no verification evidence** for them; their closure claims live in their own ADRs and are not re-verified here.

## 4. Stop conditions (CTO list)
| # | Condition | Finding |
|---|---|---|
| 1 | Hash mismatch in the baseline to be adopted | **YES** — start ≠ end manifest (3 files, concurrent writers); no frozen window exists |
| 2 | Conflicting ownership between workstreams | **Partly** — 51 MIXED files; plus the peer-reported overwrite of `rfq.service.ts`, `Rfqs.tsx`, `Approvals.tsx` (all three classified FOREIGN with later unevidenced modification). Handled under Step 4 (NEEDS RE-PROOF), not as an independent stop |
| 3 | Foreign change altering architectural behavior | **YES** — foreign changes to `RequireModuleGuard`/`RequireFeatureGuard`, the entitlement resolver token, Approval Engine service/module/controller, Event Engine, navigation, `app.module.ts`, `company-connection-manager.service.ts` (MIXED) |
| 4 | Unattributed change touching Area 21 or a shared engine | **YES — 48 files** (list: `unattributed_change_manifest.tsv`, `area21_shared=True`), e.g. approval-engine service/module/controller, `authorization.service.ts`, `company-entity-registry.ts`, `entitlement.controller.ts`, `entitlement-resolver.token.ts`, navigation controller/service, `plan.entity.ts`, Plans migration, `tax-engine.service.ts`, accounting adjustment services/controllers, several `*.company-isolation.spec.ts` |
| 5 | Data/isolation/security regression risk | **Unassessed** — cannot be excluded while 3 and 4 stand; no foreign change was re-proved |
| 6 | Cannot determine source of truth | The live tree is **not** a usable source of truth (still being written) |
| 7 | Foreign work used as verified implementation | **NO** — none was |

**Area 21 / shared-engine affected: YES.** Files touching those boundaries: FOREIGN 110, UNATTRIBUTED 48, HISTORICAL 82 (these last must be re-checked wherever a foreign write also exists), TEST-ONLY 5. All foreign/unattributed ones are routed to **AREA 21 / SHARED-ENGINE RE-PROOF** and none enters an implementation baseline automatically.

## 5. What is needed to close WP-0.4 (for the CTO to decide — nothing was changed to get here)
1. **Execution baseline = a hash-bound pinned snapshot**, not the live tree (the live tree fails stop conditions 1 and 6). The WP-0.5 technique (pin `src` + compiled `dist/database/migrations`, anchor hash, run from the copy) is the available mechanism.
2. **Owner attestation for the 98 UNATTRIBUTED files** by the workstreams named in the hints (Multi-Company front; DAII HR (fork) and its continuation) — an attestation is evidence; a hint is not.
3. A ruling that the 51 MIXED and 104 late-modified files stay FOREIGN / NEEDS RE-PROOF (as Step 4 prescribes) and that the 48 shared-engine UNATTRIBUTED files are routed to re-proof once owners attest.

## 6. Verification
- **Source integrity:** NOT ESTABLISHED (§1). **Ownership integrity:** every file has exactly one status; no unclassified group is treated as baseline. **Foreign-work integrity:** all foreign work is listed and tagged (`foreign_change_manifest.tsv`, 306). **Closed-area integrity:** no old verification was carried onto a changed file — files touched by a foreign write are FOREIGN. **Isolation readiness:** NOT READY (stop conditions 3–4).
- **Architecture changes introduced:** NONE. **Implementation changes introduced:** NONE (only the evidence folder and this report were added).

---

## 7. FINALIZATION ADDENDUM (2026-10-06) — execution baseline pinned

| Item | Value |
|---|---|
| Execution Baseline | `EB-WP04-20261005-155534` (read-only, outside the repo: `_execution-baselines/`) |
| HEAD | `4bb71f8391321b883b40145b2b5fb6c233048fa2` |
| Baseline Tree Hash (PIN HASH) | `ab186f9f0aa7507c9bead7e56508617f7abeb8e254d5263109d3b754247e001b` |
| Verification hash | identical — 3752 files, 0 per-file mismatches |
| Scope | `backend/src/**`, build/test config, `dist` built inside the snapshot (0 TS errors), the 25 Control Plane documents as inventoried |
| Reproducibility | Rebuild of `dist` from the pinned `src`: 2676 of 2677 files byte-identical; the only difference is `tsconfig.build.tsbuildinfo` (incremental-build metadata, not executed code) |

**Membership (`evidence/wp04/baseline_membership.tsv`, sha256 `802091c2b0d4bf55…`):** INCLUDED = 25 OWNED / VERIFIED. EXCLUDED = FOREIGN 191, HISTORICAL 139, TEST-ONLY 7, UNATTRIBUTED 90 (all in scope). A further 128 changed files (FOREIGN 115, HISTORICAL 5, UNATTRIBUTED 8) lie outside this baseline's scope. Excluded means "not part of the verified set"; the files remain physically present in the snapshot because `src` is compiled as a whole. Unattributed included: 0. Included files touching Area 21 / a shared engine: none. The 48 UNATTRIBUTED Area 21 / shared-engine files are on the AREA 21 / SHARED-ENGINE RE-PROOF QUEUE (`evidence/wp04/area21_shared_reproof_queue.tsv`).

**Note on `BASELINE.json`:** it was written with an earlier, broader membership model (171 included, counting HISTORICAL and TEST-ONLY). The membership above supersedes it. The snapshot contents and the pin hash are unaffected.

**Ownership attestations (final):** `evidence/wp04/attestations-received.md` — **COMPLETE**, 98 of 98: Multi-Company front 41, DAII HR (fork) 49, this lane 8. F11 Cost Centers & Dimensions and DAII manfacturing disclaimed the 9 round-3 files. Attestation = ownership only. Attribution is frozen and nothing was reclassified; all 98 remain excluded from the baseline. Files with sender-stated shared content stay FOREIGN / NEEDS RE-PROOF. Hints are not evidence.

**Live tree since the pin (report only):** 605 changed entries now vs 580 at inventory, from other workstreams still writing. None enter the baseline. Stop conditions: none triggered.

**Final verification (2026-10-06):** PIN HASH = FRESH HASH (3752 files, 0 mismatches). Included 25 / unattributed included 0 / Area 21 and shared-engine included 0 / live-vs-pin drift among included files 0. HEAD unchanged. Live tree: 607 changed entries vs 580 at inventory. New since inventory, all outside the baseline: 24 documents and scripts of this lane (`evidence/wp04`, this report), plus other sessions' `fixed-asset-disposal.handler.ts`, `fixed-asset-disposal-gain-loss.company-isolation.spec.ts`, `CUS-01-…2026-10-06.md` and `FA-02-…2026-10-06.md`. The pinned snapshot holds the pre-change version of the handler. No stop condition was triggered.

**CTO ruling 2026-10-06: WP-0.4 = CLOSED / VERIFIED.** Execution Baseline `EB-WP04-20261005-155534` is PINNED; the live tree is not an execution baseline. The sections above record the evidence path; §7 is the closing state.
