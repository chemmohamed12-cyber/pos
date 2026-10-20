# Local preview :5173 / :3500 - sync with integration (2026-10-20)

- Integration HEAD at the check: **7eb6d67** (worktree clean). `main` and `origin/main` unchanged (505584d); nothing pushed, no release package, version 1.1.10, no deployment.
- :5173 = Vite (pid 18156) started in `release-new/.claude/worktrees/integration/frontend` - it serves the worktree source live, so it already shows HEAD; no restart was needed (the served modules were checked for each hotfix marker).
- :3500 = integration backend (pid 28008) started by the launcher from `integration/backend` (main's `.env` values read in memory; storage directories of the main checkout). Its build was made after the last backend code change; commits after it touch only a spec and docs.
- No migration or business-data change was made by this task. Dependencies: the Alpha chart/fiscal-year setup (FY2026, account 2105) is what lets goods receipts post; Beta/Gamma/Delta have empty charts.

## On-screen verification (Arabic, Alpha) - all PASS
PO picker (warehouse items, added item hidden, same-name sibling still offered, code column) - Inventory filter (25 -> 4) - BOM component picker (4 matches) - Financial Events (translated, no raw codes, Arabic dates) - role names in the header (no raw role.* keys) - Chart of accounts: 2105 GRNI and "Complete control accounts" button - Item movements show GR-2026-000001 / GR-2026-000002 - Approvals page in plain Arabic - Procurement tile "goods received, not invoiced" (2) and its list with blue "Create invoice" - General ledger row drill-down with the blue button.
Rejected-status wording: verified earlier (346c016) with intercepted events; no rejected event exists now. Not re-checked today.

## Observation
The preview now holds GR-2026-000002 / PO-2026-000002 (created by the user during preview); both posted (JV-2026-000002).
