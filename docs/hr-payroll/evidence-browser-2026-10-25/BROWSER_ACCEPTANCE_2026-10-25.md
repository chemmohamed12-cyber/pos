# Browser acceptance — payroll gap closure (2026-10-25)

Environment: disposable cluster 5546, databases `daii_test_biz_t43_pr_cp` (platform) / `daii_test_biz_t43_pr_co` (Company «Verify Co»); backend `dist/main.js` :3643; Vite :5643. Built from the worktree `hr-payroll-audit`, branch `feature/hr-payroll-gap-closure`. Production untouched. Users: `bv.admin` (prepare/calculate), `bv.rev`, `bv.sub`, `bv.appr`, `bv.pay` (separate people, SoD profile `standard`).

Method: real UI in the built-in browser unless marked **API**. Independent DB checks at the end.

| # | Journey | Result | Notes |
|---|---|---|---|
| 1 | Login, Arabic RTL default | PASS | |
| 2 | Create period 2026-10 (UI) | PASS | |
| 3 | Compensation: new effective-dated record (UI) | PASS | old record closed at the new date, shown «مُستبدَل»; status now localized |
| 4 | Calculate run (UI) | PASS | 3 exceptions listed (2 × no attendance, 1 × no compensation); employee without compensation not paid |
| 5 | Preparer tries to acknowledge own run | PASS (refused) | localized message (`error.sod_violation`) |
| 6 | Reviewer acknowledges with decision reference, reviews (UI) | PASS | per-row acknowledgement; actors table records each stage |
| 7 | Submit (UI; API for the resubmission) | PASS | submit button hidden while approval is pending (defect found + fixed) |
| 8 | Submitter tries to approve | PASS (refused) | mandatory floor |
| 9 | Approver rejects with reason (UI) | PASS | run back to «محتسبة», reason shown, acknowledgements carried over |
| 10 | Review + resubmit (**API**), approve (UI) | PASS | run «مرحّلة», financial event «مرحّل» |
| 11 | Payout to an unmapped account | PASS (refused) | no batch created; message is the English server text (residual) |
| 12 | Payout batch to GL-mapped bank, execute (UI) | PASS | 2 items paid, Omar (no compensation) excluded |
| 13 | Reconciliation panel | PASS | consistent, outstanding 0 |
| 14 | Supplementary run for the compensation change (UI) | PASS | revision 2, +1,000.00 (whole-period delta, see financial memo) |
| 15 | Close period with open supplementary | PASS (refused) | English server text (residual) |
| 16 | Supplementary: exceptions/review/submit/approve/payout | PASS (**API**) | |
| 17 | Close period (UI) | PASS | «مغلقة»; calculating on a closed period → 409 |
| 18 | English / LTR on run detail, compensation, periods, runs, commission policies | PASS | no Arabic leakage, no raw codes |
| 19 | Commission policy form | PASS | `net_sales` / `customer_group` not offered, notice shown |
| 21 | SoD profile settings screen: strict → persisted → standard | PASS | new screen, `payroll.settings.manage` |
| 22 | HR link-user picker (G-09) | PASS | now lists only the Company's active members (`/hr/link-candidates`); before it called the platform-only `/admin/users` |
| 20 | Narrow viewport | PARTIAL | payroll content does not overflow; the app shell keeps a fixed 240px sidebar so `<main>` is ~135px wide at phone width (global, pre-existing) |

Independent DB reconciliation after the journeys:
- GL: 5201 Dr 21,000.00; 2150 Cr 21,000.00 / Dr 21,000.00; 1102 Cr 21,000.00.
- Treasury: cash_out 21,000.00 (3 transactions), funding cash_in 500,000.00.
- Per run: PR-2026-000001 net 20,000.00 = expense 20,000.00 = paid 20,000.00; PR-2026-000002 net 1,000.00 = expense = paid. Both `consistent: true`, outstanding 0.

Defects found by this pass and fixed in the same change: raw exception code as checkbox accessible name; approval-request submit button stayed visible after submitting; SoD refusal reached the browser as a bare `FORBIDDEN` (now `SOD_VIOLATION` through the error envelope + localized); compensation status shown raw.

Environment finding: the Terminology service reads the **platform** database. Payroll terminology (including the pre-existing Phase 1 codes) is only present when the `payroll` tag migrations have run on the platform database; without that the screens show raw codes. The BV bootstrap did not run them; `bv-migrate-all` against the platform DB fixed it. A real deployment must apply the Terminology seeds to the platform database.

Not verified in the browser: Commission adjustment screen, failed-payout re-issue, mobile layout of the shell.
