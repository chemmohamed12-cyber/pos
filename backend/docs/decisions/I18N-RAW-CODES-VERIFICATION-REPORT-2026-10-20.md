# I18N raw-codes fix — verification report (2026-10-20)

**Branch:** `feature/i18n-raw-codes`, worktree `.claude/worktrees/i18n-raw-codes`, base = integration tip `90f3f14`. **Not merged. :5173 / :3500 and the integration worktree were not touched.** Scope: front-end localisation only — no schema, no business record, no feature flag, no backend change.

## 1. What changed
- **Reported screen — Financial Events** (`accounting/financial-events`): the source column now shows «المشتريات / ترحيل استلام بضاعة» instead of `unknown / procurement.goods_receipt.posted`; the rejection reason is translated (the GRNI reason of the screenshot included); the "last updated" time uses the chosen language (`3:22:02 ص`, not `AM 2:39:58`).
- **Shared helpers** (`frontend/src/lib/`): `displayNames.ts` (names for source domains, financial event types, statuses, payment methods, directions, event/action names, org unit types; an unknown code is shown as readable words, never as a dotted key), `financialReason.ts` (common rejection reasons; any other reason keeps its original text after a translated event name), `formatDateTime.ts` (dates and times in the chosen language, Latin digits).
- **About 20 other places** that printed raw values (payment methods, party / statement / policy statuses, integration and shipment events, work-order actions, org unit types, company status in the switcher, the financial trace).
- **61 date calls + the refresh stamp** that used the browser's default (English) format; **142 "Loading…"** literals (102 screens); **8 English labels** and the **Bank Transfer** option.
- **Found during the browser check and fixed:** inside an Arabic sentence an account code such as `4000-A/1` was displayed reordered (`A/1-4000`) by the right-to-left layout. Codes are now wrapped as left-to-right isolates (characters unchanged).

## 2. Commits
`5a2a4cd` (helpers, reported screen, raw values, dates) · `06ddfae` (Loading…, labels) · the isolate fix and this report (see branch HEAD).

## 3. Results
### PASS
| Check | Evidence |
|---|---|
| Type-check, build, lint | `tsc` 0 errors; build OK; lint **0 errors, 55 warnings = the baseline** (the unmodified integration tip also has 55) |
| Diff review | 111 files (+3 new helper files), **all under `frontend/src`**; 0 files outside; no backend / migration / schema; **no existing source comment was modified** (the added comment lines are the new files' documentation); 7 comments that the first scripted pass had rewritten were restored before the commit |
| 61 date replacements are dates | every argument is a date field (createdAt, dueDate, occurredAt, movementDate …); 62 default-locale calls removed, 0 remain |
| Translation safety (20 checks, `helper-safety-checks-20-of-20.txt`) | GRNI reason; already-translated text is not re-translated (no duplicated prefix); an Arabic backend message is returned unchanged; an unknown reason stays visible with identifiers intact; reason with no prefix unchanged; several colons kept; upper-case prefix untouched; account code characters exact (and isolated in Arabic, none in English); null / empty → dash; invalid date → dash, never "Invalid Date" |
| Browser — Financial Events, Arabic (disposable environment, 8 seeded events) | goods-receipt row «المشتريات / ترحيل استلام بضاعة», status «مرفوض», GRNI reason translated; AR / invoice / payment / cash reasons translated; unknown reason visible; timestamps `ص`; `01-…ar-desktop….jpg` |
| Browser — Financial Events, English | `Procurement / Goods receipt posted`, English reasons, `Updated 03:24:31`, `dir=ltr`; `02-…en-desktop.jpg` |
| Browser — customers (party statuses), both languages | Arabic: نشط / قيد الانتظار / موقوف; English: Active / Pending / Suspended; dates in the chosen language |
| Browser — labels | «نتيجة العمولة» (commission results), «فترة الرواتب» (payroll runs), «Customer Group ID» / «معرّف مجموعة العملاء» (after choosing the customer-group scope — a form selection, nothing saved) |
| Loading label | `جارٍ التحميل…` / `Loading…` (helper evaluated in the running page) |
| Layout / overflow | desktop and tablet 768 (Arabic): no horizontal overflow; reason cells do not overflow; `03-…tablet-768.jpg` |
| Console / network on a fresh load | 24 API calls, **0 failed**. (502 errors seen earlier were the minute the disposable backend was restarted.) |
| Business documents | none created or saved; the disposable databases (`daii_test_biz_t97_i18_*`) were seeded with display rows only and dropped |

### FAIL
None.

### BLOCKED
None.

### NOT TESTED (in the browser)
- Table headers and labels that appear only with data: «Effective From / To» (payroll compensation, no rows), «Scope Ref» (commission policies table, no rows), «Attendance Status» and «Reconciliation gap» (payroll run detail).
- The Bank Transfer option of the supplier-invoice payment form (the translated name is checked through the helper only).
- The payment-methods column on the Payments / Customer account screens (the helper is checked; the screen was not opened).
- Integration-log, shipment-tracking and work-order audit screens (no data in the environment; changed by the same helper).
- Phone width (375): the page overflows, **but an unrelated screen (`/warehouses`) overflows identically** — the 240 px fixed sidebar fills the screen; pre-existing, not caused by this change.

## 4. Limits
- An event type or domain that is **not in the tables** is shown as readable English words even in Arabic mode (e.g. `New / New thing happened`) — never a raw dotted key.
- Rejection reasons outside the covered patterns keep their original English text after a translated event name.
- **Backend error messages are not translated** (by directive); the app's standard error component still shows the server's message.

## 5. Backend `unknown` domain — separate issue, not changed here
The backend stores `sourceDomain = 'unknown'` for event types that are missing from `DOMAIN_OF_TOPIC` (for example `procurement.goods_receipt.posted`, the supplier invoice / payment / credit-note events). The domain is part of the event's **idempotency key** (`domain:entityType:entityId:eventType`), so mapping it now could give a replayed event a different key and post it twice. The front end derives the display domain from the event type. A dedicated investigation and regression plan (replay / idempotency tests, existing rows) is needed before any backend change.

## 6. Integration plan (for the integration owner)
Merge `feature/i18n-raw-codes` after review. The integration owner reports uncommitted edits in `FinancialTrace.tsx`, `ItemDetails.tsx` and `ChartOfAccounts.tsx`; this branch touches `FinancialTrace.tsx` (two small lines plus an import), so expect a small, mechanical overlap there. No migration, no restart of services is needed beyond rebuilding the front end.
