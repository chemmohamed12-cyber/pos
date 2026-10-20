# I18N raw-codes — post-merge verification (2026-10-20)

Companion to `I18N-RAW-CODES-VERIFICATION-REPORT-2026-10-20.md`. Records the merge into `integration/local-2026-10-16` and the checks run on the integration tip and on the live development frontend (:5173). Verification only: no source file of the integration worktree was changed by this session.

## 1. Merge
| Item | Value |
|---|---|
| Merge commit | `2e383da` (parents `1baacc3` = the integration session's work commit, `0802a20` = this branch) — made by the integration session after its own user approved |
| Resolution | `FinancialTrace.tsx` single conflict resolved by keeping the integration session's `friendlyReason`; this branch's `translateRejectionReason` call and import dropped in that file (as rehearsed). Follow-up `346c016` (integration session) extended `friendlyReason` for the new GRNI / inventory / fiscal-year texts |
| Integration tip verified | `346c016` |
| Merge brought in | 116 files, all under `frontend/src` plus this branch's report / evidence; **0 backend, schema or package files** |
| Version | `backend/package.json` and `frontend/package.json` still **1.1.10** |
| Uncommitted work in the integration worktree after the merge | 30 entries, all untracked evidence folders (no source files) |
| Merge in progress | no |

## 2. Gates on the integration tip `346c016` (scratch worktree)
- `tsc --noEmit`: **0 errors**
- `npm run build`: **OK**
- `npm run lint`: **0 errors, 55 warnings** (the same count as the tip before the merge)

## 3. Browser — live :5173 (Vite serves the integration worktree; company Alpha; read-only)
### PASS
- **Financial Events, Arabic:** title «الأحداث المالية»; headers «نوع المصدر / تاريخ العملية / حالة القيد / سبب الرفض / الإجراءات»; the goods-receipt event reads «المشتريات / ترحيل استلام بضاعة»; "last updated" shows `4:16:25 ص`; chip «القيود محدّثة»; `04-live-5173-financial-events-ar-after-merge.jpg`.
- **Financial Events, English:** «Procurement / Goods receipt posted», English headers, `dir=ltr`, `Updated 04:17:38`.
- **Customers:** Arabic «قيد الانتظار» with the date `5‏/10‏/2026`; English «Pending» with `05/10/2026`.
- **FinancialStatusCell regression (purchase order → goods receipt):** a posted receipt shows the posted badge as a link to its journal (`/accounting/journals/<id>`) in both languages — existing behaviour preserved.
- **Fresh reload:** `navigation type = reload`; Arabic 20 API calls and English 44, **0 failed**; **no console errors**; no raw dotted keys with three parts on the page.
- No business document was created, posted or saved.

### FAIL
None.

### BLOCKED
None.

### NOT TESTED
- **GRNI rejection text and the account-code direction (`4000-A/1`) on the live screen.** The live goods-receipt event is now **posted** (this session did not change why; the integration session's GRNI work is in `1baacc3`), so no rejected event exists to display. Both were verified earlier on a disposable environment (report §3) and the helper checks are 20 / 20 — not on :5173.
- **The rejected-state branches of `FinancialTrace.tsx`** (the new «لم يُرحَّل محاسبيًا» label and `friendlyReason` texts) — no rejected document in the live data.
- Supplier-payment method and the Bank Transfer option; linkage / audit screens, shipment tracking, work-order history; payroll and commission fields that need populated records.

## 4. New finding (not caused by this merge, not fixed here)
The page header on :5173 lists the signed-in user's roles, and **four are shown as raw codes**: `role.company_manager`, `role.platform_audit_readonly`, `role.platform_super_admin`, `role.support_operations` (the other roles are translated). Their names are missing from the terminology data. A fix is either a terminology seed for these `role.*` names or a readable fallback; it is outside the reviewed localisation scope and needs a decision. (My earlier raw-key scan only looked for three-part keys and missed these two-part ones.)

## 5. Incident during verification (resolved, no impact on the user's services)
Removing a scratch rehearsal worktree with `git worktree remove --force` **without first removing its `node_modules` junction** emptied the shared `local-preview/frontend/node_modules` that several of this session's scratch worktrees link to. Restored by copying the integration worktree's intact copy (read-only on the source); `tsc`, build and lint then passed. The integration worktree, the main checkout and :5173 / :3500 use their own `node_modules` and were not affected. Later cleanup removed the junction first and left the target intact.

## 6. Boundaries confirmed
No deployment, no database migration, no version change, no feature-flag change, no backend change, no restart of :5173 / :3500. The pane's :5173 session used the company selector only (a session setting).
