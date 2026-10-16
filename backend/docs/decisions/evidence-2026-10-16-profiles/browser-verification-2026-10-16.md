# Browser verification of the profile screens (2026-10-16)

Environment: preview `localhost:5173` (Vite) -> `:3500` (`dist` of worktree `.claude/worktrees/integration`, branch `integration/local-2026-10-16` at 682701d) on `daii_dev`, company Alpha Trading Co, signed in as the local demo admin. daii_dev upgraded with the five profile migrations (platform and Alpha/Beta/Gamma/Delta: 5/5 each, 0 pending afterwards).

Customer profile (Customer Account -> "ملف العميل" tab)
- API on the real backend: `GET /customers/:id/profile` 200; `POST /customers/:id/update` 201; bad e-mail 400; bad party type 400; a financial field (`creditLimit`) in the profile update 400 (not accepted there); add contact and add address 201; exactly one primary contact and one default address; removal 201; all test data removed, the customer is back to null profile values.
- UI: the tab renders fully in Arabic (no raw label keys, no failed API call); an edit through the form saved and persisted (type, legal name, e-mail, language shown translated and stored identically); restored afterwards.

Supplier profile (`/suppliers/:id`, opened from the new "فتح ملف المورد" button on the list)
- Experimental data created for the check: supplier SUP-000001 "مورد تجريبي لفحص الملف", two contacts, one address, one draft purchase order PO-2026-000001 (also confirms the F11 eligibility check accepts an active item).
- UI: profile tab (fields, contacts, addresses, read-only bank accounts) and purchases tab (purchase order listed with total 17.50 and status "مسودة"; supplier invoices and payments show the empty state). An edit through the form saved e-mail, website, language and notes; "make primary" moved the primary contact. No raw label keys, no failed API call.

Not verified here: a user without `sales.customer.edit` / `procurement.supplier.edit` (read-only view) — covered by the existing PermissionGuard convention, not by a browser run.
