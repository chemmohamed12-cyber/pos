# Central integration register — 2026-10-26

Integration branch: `integration/central-2026-10-26` (worktree `.claude/worktrees/central`). Built on the other session's `integration/final-mfg-hr-org-vw-2026-10-26` (2c58ada) + the verified Vehicle Workspace merge `release/1.1.12` (1a0d187, evidence d05520f). Nothing was reset, cleaned or overwritten: the uncommitted work found in other checkouts was preserved first (section 3).

## 1. Sessions and workstreams

| Workstream / session | Branch (tip) | Status in the central branch | How |
|---|---|---|---|
| Release line 1.1.13 (Company migration gate, catch-up, lock) | `release/1.1.12` | **Included** (base) | ancestor |
| Vehicle Driver Workspace (expense float), direct-sale slice cd6e89e, org-engine integration | `release/1.1.12` 1a0d187 | **Included** | merge (verified, see VW report) |
| Org-Structure engine WP-A supplier payment attribution, WP-C manufacturing attribution | `integration/org-final-on-1.1.13` | **Included** | via final-int |
| Manufacturing engine S1-S6 + UX stages 1-6 + follow-up | `feature/manufacturing-engine-design` | **Included** (rewritten commits in final-int) | via final-int |
| HR / Payroll gap closure + HR B-1 (employee-user link needs an active membership) | `feature/hr-payroll-gap-closure`, `feature/hr-b1-user-link-membership` | **Included** (rewritten commits in final-int) | via final-int |
| Terminology ownership seeds, payroll seed tag, org attribution on manufacturing events | final-int 2c58ada | **Included** | via final-int |
| Org-Structure engine documentation (4 commits) | `feature/org-structure-gate0` | **Included** | merge 7ff7005 |
| Customer account statement: D2 repair, statement engine (+PDF/export), official statement screen, indicators, tests, docs | `feature/customer-account-statement` | **Included** (T2 payment reversal was already on the line as 548255a) | cherry-picks, 3 trivial conflicts resolved by keeping both sides |
| Order stage visibility (Sales/Shipping covers, list tiles) | `feature/direct-sale-shipping` b661124 | **Included** | cherry-pick, import-line conflicts kept both |
| PO item picker fix | b5a5463 | **Already present** (later implementation `excludedIds`); skipped | — |
| Vehicle workspace: expense-float route branch scope, float candidates endpoint, readable category names, lint clean-up | this integration | **Included** (new) | commits b860dd8, 22403ea, 42c74b1 |
| Treasury "Settings / Balances / Ledger" menu split + Financial Movement Ledger (hotfix) | `hotfix/treasury-ledger-nav-on-integration` 428f8c7, 6fa4dbd, 2c8ed33 | **Included** (CTO directive 2026-10-27) | 5 conflicts resolved: navigation keeps the Treasury Workspace / Documents / Bank statements / Cash sessions items and replaces only the old "accounts" entry by Settings + Balances (old route redirects); TreasuryLedger.tsx = hotfix page with the T2 idempotency-key and required-field changes re-applied; controller imports unioned; controller-constructor specs updated |
| Direct sale — shipping fee on sales orders (uncommitted work found in the `release-new` checkout) | snapshot branch `snapshot/direct-sale-shipping-wip-2026-10-26` (d6751ba), ref `refs/snapshots/release-new-working-tree-2026-10-26` | **EXCLUDED — unreviewed, untested** | owner must review, commit and test (migration 1790031000000, sales-order service/entity/controller, shipment service, DepositPanel, CollectionSettlements, SalesReturns, Shipments, SalesOrdersCreate/Detail) |
| `main` (505584d "Upload POS project", 658 files) | `main` | **NOT INTEGRATED** | a separate GitHub baseline history (merge-base 5e41647 with the release line); main-team session owns it |
| Engineering handover / main-team review docs / trial merge branches | `docs/engineering-handover-2026-10-26`, `review/main-team-docs-2026-10-26`, `review/trial-mfg-hr-2026-10-26` | **NOT INTEGRATED** | documentation / trial branches of another review session (based on the main-team history) |
| Other feature branches (inventory-lifecycle, entity-code-sequence, procurement-allocations, item-details, ...) | various | **No unique commits** (ahead 0 of the release line); their *uncommitted* work is listed in section 3 | — |

## 2. Integration order used
1. Verified baseline (release line + VW merge) → 2. final-int content (org WPs, manufacturing, HR/payroll, seeds) → 3. org documentation → 4. customer statement series → 5. order stage visibility → 6. vehicle-workspace gap fix and UI fixes → 7. lint clean-up and regression list. Shared files (`Shipments.tsx`, `SalesOrdersList.tsx`, `payments.service.ts`, `customer-finance.module.ts`, `unit-specs.txt`) conflicted only on adjacent import / provider / method blocks and were resolved by keeping both sides; no behaviour of either side was dropped. `unit-specs.txt` lost the one line of the excluded Treasury hotfix.

## 3. Preserved uncommitted work of other sessions (not touched, not integrated)
Recoverable copies: `git update-ref refs/snapshots/<branch>-2026-10-26` (tracked changes; `git stash create`, working trees untouched) and the patch/migration copy in `D:\DAII-INTEGRATION-SNAPSHOT-2026-10-26`. Untracked files stay on disk in their worktrees.

| Worktree / branch | Tracked changes | Untracked | Snapshot ref |
|---|---|---|---|
| release-new / feature/direct-sale-shipping | 12 files | 7 (3 old release zips, shipping-fee migration, …) | release-new-working-tree, feature-direct-sale-shipping |
| inventory-lifecycle | 1 | 59 | feature-inventory-lifecycle |
| f11-verify | 0 | 29 | — |
| master-data-item | 13 | 15 | feature-master-data-item |
| procurement-allocations | 2 | 2 | feature-procurement-invoicing-allocations |
| integration (local-2026-10-16) | 1 | 0 | integration-local-2026-10-16 |
| org-gate0 | 1 | 0 | feature-org-structure-gate0 |
| review-docs | 1 | 2 | review-main-team-docs-2026-10-26 |
| final-int | 1 (CRLF noise in an evidence JSON) | 0 | — |
| vehicle-workspace | 0 | 2 (my browser-acceptance notes, also copied into the final evidence folder) | — |

## 4. Open tasks (central list)
| # | Task | Owner | Dependency | Acceptance | Status |
|---|---|---|---|---|---|
| T1 | Treasury ledger / menu hotfix | Treasury owner | design decision | one navigation, ledger service on the line, specs green | DONE (commit b4d204c..., verification in the final report) |
| T2 | Direct-sale shipping fee: review, commit, test the preserved work | direct-sale session | none | tests + owner review, then integrate on top of the central branch | OPEN (excluded) |
| T3 | Untracked work in inventory-lifecycle / f11-verify / master-data-item | their sessions | none | commit or discard by owner | OPEN |
| T4 | Company-specific financial activation (float accounts, category→account mapping, roles) | Finance + each company | real chart of accounts | verified per company | BLOCKED (config) |
| T5 | Browser acceptance of the new UI fixes and customer statement on the packaged build | integration | package | see final report | see report |
| T6 | `main` (POS upload) relationship to the release line | main-team session / CTO | — | explicit decision | OPEN |

Status of verification and the final package is recorded in `CENTRAL-INTEGRATION-FINAL-REPORT-2026-10-26.md` once the gates have run.
