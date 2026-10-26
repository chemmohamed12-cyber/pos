# Org-Structure Engine — Candidate and evidence register (Phase 1 of the blocker-closure instruction, 2026-10-26)

This register freezes **what was tested, on which commit, with which result**. It does not change code and does not authorize a merge. Decision stays **NOT READY FOR MERGE** (`ORG-STRUCTURE-ENGINE-FINAL-REPORT-2026-10-26.md` §8).

## 1. The candidate
| Item | Value |
|---|---|
| Branch | `feature/org-structure-gate0` (not pushed) |
| Base | `eabd3fd` (integration tip) |
| **Tested candidate** | **`a4e0daf4d2d5a80578da3f0b9b1e920b16e9c82a`** — also marked locally with the annotated tag `org-engine-candidate-a4e0daf` (a local pointer so the candidate cannot be lost or confused; history was not rewritten and the tag is not pushed) |
| Commits after the candidate | `263e273` (gate document rewrite + evidence 17–19), `2cf8873` (final report + evidence 19b/19d/20), and the commit adding this register + evidence 21–22 |
| Content of those commits | **documentation and evidence only** — verified from `git show --name-only` for each (every path is under `backend/docs/`) and `git diff --name-only a4e0daf..HEAD` (only `backend/docs/…`); `git diff a4e0daf..HEAD -- backend/src backend/tools frontend/src` is empty |
| Candidate code unchanged since testing | yes — no code was modified to close administrative items |

## 2. Results, exactly as executed (never combined)
| Run | Commit | Where | Result | Evidence |
|---|---|---|---|---|
| **Full regression** (135 specs, runner `biz-run.js --regression regression-specs-all.txt`) | `a4e0daf`, clean tree | cluster 5546 | **134 passed / 135 — `REGRESSION DONE: 134/135`**; the one non-pass is `release-migration-registry.real-pg.spec` (the runner cannot execute it: it refuses anything except 127.0.0.1:5544) | 18, 20, 21, 21b |
| **`release-migration-registry.real-pg.spec`** — a **separate** run, **not** part of the 135-spec run above | `2d4eb06` and again `a4e0daf` (same code) | isolated instance 127.0.0.1:5544, `DB_NAME=daii_test_h3reg_run` | **21/21 passed** (baseline `eabd3fd` also 21/21) | 9, 14 |
| The three previously flaky specs, 3 rounds, started only in verified quiet windows | `a4e0daf` | 5546 | **9/9 passed** (3/7/3 tests each, none skipped) | `p2-three-specs-final/` |
| Migration up → no-op → down(7) → up, schema fingerprints | tree of `263e273` (= candidate code) | disposable `daii_test_biz_t96_migdown` on 5546 | up 322 applied; re-up 0; down exactly 7; second up identical fingerprint; **schema reversible, data not** (stamps, archive state, `org_migration_log` lost) | 19, 19b, 19c, 19d |
Statements that must not be made from these runs: "135/135 in one run" (the registry spec was run separately), "down is a safe rollback for Company data" (it is not).

## 3. Evidence integrity
- Several evidence **log** files (`*.log`) are matched by the repository's `.gitignore` and were therefore **not present in any earlier commit** although the reports cite them (10c, 14, 19c and all per-run logs in `p2-three-specs-final/`). They are added in this documentation commit with `git add -f` (the ignore rules were not edited), so the cited evidence now exists in the repository.
- The raw runner and jest output of the final full run and of the first full run were added as text files (21, 21b, 3b).
- `22-evidence-manifest-sha256.txt` lists the SHA-256 of every evidence file and of the report/gate/register documents, so any later change is detectable.
- The temporary scripts used for the up/down check and the mutation check are archived as text (19b, and the mutation procedure in 10); temporary files (generated xlsx fixtures, `_xl.json`, `_tmp-*.ts`) were deleted and no regenerated test artefact is committed.

## 4. Open items (carried, unchanged)
Attribution decisions → `ORG-STRUCTURE-ENGINE-ATTRIBUTION-DECISION-REGISTER-2026-10-26.md`; Alpha warehouse assignment → evidence 12; release-line integration and its re-verification → not started (blocked on the two preceding items, per the instruction's order).
