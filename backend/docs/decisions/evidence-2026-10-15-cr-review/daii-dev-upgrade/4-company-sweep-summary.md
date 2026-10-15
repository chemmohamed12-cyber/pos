# daii_dev company sweep after the upgrade (2026-10-15)

App: backend :3500 = F11 worktree build (5e41647 + F11 only) with backend/.env; frontend :5173 = same worktree. Signed in by the user (admin@daii.example) in the browser pane; members of Alpha and Beta only (Gamma/Delta not reachable with this account).

109 parameter-free GET endpoints called through a Company-scoped token per company:
- Alpha (13 modules): 105 x 200; 409 /accounting/ap/statement (configuration: no AP control account - controlled message); 404 /delivery/collections and /delivery/outcomes without a shipment id (controlled); 500 /accounting/reports/cash-flow WITHOUT from/to.
- Beta (4 modules: accounting, finance, inventory, sales): 63 x 200; 44 generic 404 = modules not in Beta's package (entitlement hides them - expected); same 409 and same 500.
- cash-flow WITH from/to (what the screen always sends): 200 in both companies. The 500 is a pre-existing API input-validation gap (FinancialReportingService.getDepreciationAddBack reads from.slice on undefined), not caused by the upgrade or F11; not fixed (out of scope).
- Trial balance in both companies: payload has both total sets; footer = row sums.
- Movements report dateFrom=dateTo=today: 200 in both.
- UI (Alpha): trial balance, inventory, purchase orders, purchase requests render; no failed API call on those page loads.
