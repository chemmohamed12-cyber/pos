# Treasury program — T4 gate report (workspace UI verification) — 2026-10-21

Follows `TREASURY-T3-T4-GATE-REPORT-2026-10-20.md` (T4 code-complete, verification pending). Nothing outside the worktree, the dedicated test cluster 5546 (disposable `daii_test_*` databases) and a local throw-away Vite process (port 5185, stopped afterwards) was touched. `daii_dev`, Alpha/Beta/Gamma/Delta, :5173 and :3500 were not touched.

## 1. What was verified, and how (two independent layers — neither is a full-stack E2E)

### Layer A — HTTP, real guards, real PostgreSQL (server side of every UI action)
New spec `treasury-documents.http.company-isolation.spec.ts` (**8/8 PASS**, `biz_t70_` and re-run `biz_t71_`). Real controllers (`TreasuryDocumentsController`, `TreasuryController`, `PaymentsController`), **real `PermissionGuard` with real role grants**, the production `ValidationPipe` (whitelist + forbidNonWhitelisted), `AllExceptionsFilter`, response envelope; only authentication and Company context are doubles (same boundary as the T-09 HTTP spec).
H1 a user with no grant gets 404 on every documents route and nothing is written · H2 valid draft 201 in the envelope; unknown field (`glAccountCode`), bad amount, blank purpose → 400; reason-codes endpoint returns codes only · H3 submit/decide/execute by three different people, each refused (404) for a user lacking *that* node; execute is idempotent; effect preview correct · H4 self-approval 403 through the API; stale version 409; **an unknown field on cancel is 400** · H5 cancel and reverse need their own nodes and a reason · H6 generic cash-in: customer label 422, missing reason 400, same `Idempotency-Key` replays one leg · H7 payment reversal needs `finance.payment.reverse` (404 without), second reversal 409, blank reason 400 · H8 Company B cannot see Company A's documents.

### Layer B — the real pages in a real browser, against an in-memory mock API
A dev-only harness (`frontend/dev-harness/`, not part of the app build or any import graph) renders the **real** Treasury pages with the real components and CSS; only `lib/api`, `AuthContext` and `LanguageContext` are replaced (the mock models status changes only and uses the response shapes taken from Layer A). Driven in the Browser pane:
| Check | Result |
|---|---|
| Workspace, Arabic RTL, admin: tiles (book balance, awaiting approval, ready to execute, drafts, unposted movements, unmapped accounts), quick actions, balances table, posting-exceptions panel | **PASS** (screenshot reviewed; no console errors) |
| Document detail, English LTR, preparer on a submitted document | **PASS** — shows "Waiting for someone else to approve — you cannot approve your own document", no approve button |
| Approver on the same document | **PASS** — Approve / Reject only (no execute, cancel); clicking Approve → status "Approved — not executed" |
| Executor on an approved document | **PASS** — "Execute now (moves the money)" only; click → Executed; no cancel/reverse for the executor |
| Admin on an executed document | **PASS** — only "Reverse document" (disabled until a reason is typed); click → Reversed with the reason shown; cancel correctly absent for an executed document |
| Purpose-first form (Arabic): six purposes → collection form → customer → open-invoices grid (2 rows) → "Max" and manual allocation + unapplied part → total 775.00 → save → draft created, detail opens in Arabic | **PASS** |
| Viewer role | **PASS** — no "New document" button |
| API failure mode | **PASS** — error panel with Retry; network failure mode likewise |
| Empty mode | **PASS** — "No documents in this state." |
| Slow mode (2.5 s) | **PASS** — loading label shown, then content |
| Narrow widths (375 and 768 px frames) | **PASS for the product content** — cards fit, tables scroll inside their own container; the only elements wider than the frame belong to the harness toolbar. (The browser pane's "mobile" emulation reported a 480 px layout width, so frames were used instead.) |
| Arabic ↔ English switch with correct `dir` | **PASS** |

## 2. Defects found by this verification and closed
| Defect | Closure |
|---|---|
| **UI sent `expectedVersion` on cancel/reverse/decide; the API rejects unknown fields (400)** — found by reasoning about the production ValidationPipe, confirmed by H4 | the page now sends the version only on submit/execute (`TreasuryDocumentDetail.tsx`); H4/H5 assert the API behaviour and the UI payload shape |
| Allocation table showed a raw invoice id | service returns `invoiceNumber` per allocation (raw read of `sales_invoices`), page shows it; asserted in the documents spec (10/10 re-run) |

## 3. What is NOT proven (stated plainly)
- **No full-stack browser E2E**: no real backend served the pages the browser drove. A real stack needs an isolated control plane with installation, entitlement and credentials bootstrap; cloning `daii_dev` on 5433 was refused by the permission layer and was not worked around, and the dedicated test cluster's harness databases carry no installation/plan/login bootstrap. Server behaviour is proven by Layer A, rendering and permission-gating logic by Layer B; the **wiring between them (real JSON shapes in the real pages, real login, real navigation/nav-registry labels, real terminology)** is the residual, to be closed on a provisioned isolated environment or after an authorized migration of the preview.
- Terminology labels for the two new navigation items depend on migration `1790030200000` being applied (without it the sidebar shows the raw codes).
- Mobile verification used frames, not a physical/emulated device; no real keyboard/touch behaviour tested.
- Accessibility (keyboard order, screen reader) not tested.

## 4. Decision
**Gate T4: PASSED WITH A RECORDED LIMITATION** — the workspace, documents list, creation form and document detail are implemented, their server contract is proven over HTTP on real PostgreSQL with real permission guards, and their rendering, role-gating, language/direction, loading/empty/error states and narrow layouts were verified in a browser on the real components; the **full-stack E2E on a provisioned environment remains PENDING** and is carried into T7 (release-candidate verification), not waived.
