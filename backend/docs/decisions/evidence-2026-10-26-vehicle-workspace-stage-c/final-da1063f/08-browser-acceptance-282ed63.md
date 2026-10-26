# G8 - packaged-browser acceptance (2026-10-26)
Build under test: integrated package Daii-Release-v1.1.14-2026-10-26.zip (scratch label), sha256 5ac36fde...e56361, source 282ed63 (branch head a600732), deployed by the unmodified 1.1.13 release engine to D:\DAII-LOCAL-DEPLOY-R1111G\deploy\app, served on http://127.0.0.1:3690, DB ns t95 (test cluster 5546). Browser: built-in browser pane; driver in 375x812 mobile emulation, approver on desktop.
Accounts (rehearsal test users, created by vw-seed.js): driver1 (role driver, vehicle VH-101), checker (finance approver/poster in the rehearsal company), admin. Passwords not recorded.
Fixtures: vw-browser-fixtures.js (3 extra shipments WB-2026-000201..203; 203 is on VH-202/driver2).

| # | Scenario | Result | Observed |
|---|---|---|---|
| 1 | Driver login, workspace loads | PASS | login ok; /vehicle-workspace lists only VH-101 |
| 2 | Assigned vehicle + branch/company visibility | PASS | VH-101 card (branch Cairo); VH-202 absent; direct GET of VH-202 overview/workspace -> 404 |
| 3 | Record customer collection | PASS | RSH-2026-000201, 600.00 cash recorded from the phone: "recorded by driver - awaiting remittance"; remaining 0.00 |
| 4 | Item delivery + operational status | PASS | delivered qty 2/2, confirm dialog, status "delivered", log entry "Status: delivered"; list shows delivered + collection awaiting remittance |
| 5 | Expense claim | PASS | CEX-2026-000003, 120.00 custody_fuel, status "pending approval"; no approve button for the claimant |
| 6 | Claimant self-approval | PASS (denied) | POST decide/post/reverse as driver -> 404/404/404; status stays pending_approval |
| 7 | Separate approver | PASS | checker (different user) approves in the UI -> "approved - not posted" |
| 8 | Execution/posting (test company, rehearsal-prepared mappings) | PASS | post from the float: float balance 1000.00 -> 880.00, posted 120.00, difference 0.00; collection custody untouched (checks 06 log). NOT a real company mapping (see G9) |
| 9 | Unauthorized / cross-branch | PASS | driver1 on VH-202 shipment: expenses list 403, claim 403, collection 403, overview/workspace 404; no token 401, bad token 401. Cross-COMPANY isolation: covered by real-PG A/B specs (company A/B harness), not by a second browser session |
| 10 | Previous-slot rollback | PASS | 07-rollback.txt: previous 1.1.13 slot runs on the upgraded 333-migration schema, health 200, Stage C route 404 |

Observations (not blockers): the category dropdown shows raw keys (custody_fuel / custody_toll) instead of labels; the float-account picker lists custody accounts as options (the service refuses them: DB CHECK + assertNotAnExpenseFloat); the reason text stays in the form after a successful submit.
