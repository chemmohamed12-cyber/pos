# Treasury program — T1 gate report (financial integrity & atomic posting) — 2026-10-20

Branch `feature/treasury-integrity` (base `integration/local-2026-10-16` @ `00cd8ee`; T0 = `90a5b30`). No shared database, `main`, version, or other worktree was touched. All destructive tests ran on disposable databases on the dedicated test cluster 127.0.0.1:5546 (namespaces `biz_t60_`…`biz_t64_`, DB guard active).

## 1. Scope delivered

| T1 item | Delivered | Where |
|---|---|---|
| T1.1 pre-mutation validation | **Publish guard** (`EventBusService.registerPublishGuard`): runs inside the publisher's own transaction before the outbox row is written. Accounting registers it for `treasury.cash.recorded`, `treasury.transfer.completed`, `finance.payment.recorded`, `finance.supplier_payment.recorded`, `deposit.verified`, `collection.remitted`. It (1) asserts the accounting date is in an open fiscal period (same `assertOpenForPosting` as posting, via new `JournalEntryService.assertPostingDateOpen`) and (2) dry-runs the real handler on the real payload (bank leg mapped to an active chart account, clearing/AR/AP accounts resolvable); a rejection becomes a 409 "cannot be posted … Nothing was recorded" and the caller's whole transaction rolls back | `foundation/events/event-bus.service.ts`, `financial-event.service.ts` (`validateForPublish`) |
| T1.1/T1.4 mapping | Treasury-owned movements (`*Direct`: cash-in, cash-out, both sides of a transfer) refuse an unmapped account **first**, before locks/balance/insert; the silent "skip the event if unmapped" branches are gone. A reversal of a legacy unmapped leg mirrors "no GL" (`EMIT_MIRROR`) instead of failing or inventing a journal | `treasury.service.ts` |
| T1.2 atomic posting | Proven: leg + event + outbox row commit or roll back together; failure injected after the leg insert leaves no residue; dispatch remains post-commit (inline-dispatch mode confirmed to exist but was **not adopted** — the publish-time dry-run closes the same window with less coupling; see §5) | integrity spec V4 |
| T1.3 recovery | Read-only **posting-exceptions** view (`GET …/cash-bank/posting-exceptions`, permission `accounting.cash.view`): movements with missing/rejected/not-posted events, cause, amount, age, deferred-by-policy counts. Re-drive of a REJECTED event proven idempotent and date-preserving | `treasury-posting-exceptions.service.ts`, `cash-bank.controller.ts`, recovery spec |
| Deposits / COD | Deposit approval: mapping checked first; `deposit.verified` now published **in the same transaction** as Treasury leg + ledger credit + approval (before: separate transactions — leg could commit with no event). COD remit already published in its own atomic unit (ADR-042 D3c); now also guarded | `deposits.service.ts` |
| Latent bug fixed | Publishers sending a full ISO timestamp as `businessDate` were compared as text against period end dates (false "closed" on a period's last day); guard normalises to a calendar date | `validateForPublish` |

## 2. Tests (actual runs, this worktree, 5546)

Command: `REGRESSION_NS=biz_t64_ node tools/testing/biz-run.js --regression <23 specs>` → **`REGRESSION DONE: 23/23 passed`, 178 tests passed, 0 failed, 0 skipped** (log: `evidence-treasury-integrity-2026-10-20/10-T1-final-regression.log`). The 23 = the 21 Treasury/payments/deposits/COD/ledger/returns/payroll/supplier-payment/GL specs from `regression-specs-all.txt` + the two new specs. Also: `event-bus.service.spec.ts` unit **10/10** (3 new for guards); `tsc --noEmit` clean; `eslint` on all changed files clean; `nest build` OK.

New specs (`regression-specs-treasury.txt`):
- `treasury-posting-integrity.company-isolation.spec.ts` — **12 tests**: clearing unset (V2); closed period for cash-in/out/transfer, then reopen succeeds (V1); unmapped cash-in, cash-out and **both** transfer sides (V3); mapped-but-absent chart code (V3b); transfer posts one balanced journal and no P&L line; failure injection after the leg insert (V4); **8 concurrent requests, one key → exactly 1 leg/1 event/1 journal** (V6); reversal posts the offset, second reversal refused (V9); legacy unmapped leg reversal mirrors no-GL (V8); `deposit.verified`/`collection.remitted` guarded incl. ISO-timestamp period case; Treasury == GL, Dr == Cr, no non-POSTED event, Company B untouched (V16). Every refusal asserts a zero-side-effects fingerprint (treasury rows, events, journals, outbox, audit).
- `treasury-posting-recovery.company-isolation.spec.ts` — **4 tests**: movement whose event is REJECTED at dispatch appears in the exceptions view with cause/amount/age and the Treasury≠GL divergence is visible; re-drive posts one balanced journal at the original date, second re-drive and duplicate dispatch change nothing, view empties, Treasury == GL; legacy unmapped leg reported `UNMAPPED_ACCOUNT`; Company B clean.
- Updated for the new rule (behaviour change, not weakened): `treasury.company-isolation` (fixture accounts now GL-mapped), `treasury-bank-leg` (a mapped-but-absent code is now **refused before commit** instead of "committed then REJECTED" — stronger), `deposits` (+1 test: unmapped approval refused, deposit stays pending, zero rows).

## 3. Defects found while executing, and closure

| Defect | Closure |
|---|---|
| Direct cash-out on an unmapped, empty account reported "insufficient balance" instead of the real cause | mapping checked first (`assertGlOwnerMapped`); V3 passes |
| Test chart had no `ar` account for deposit guard case | fixture fixed |
| Worktree without `dist/` made the harness "migrate" nothing (`user_roles` missing) | `nest build` in the worktree (environment, not product) |
| SQL pack Q1 had an invalid `HAVING` | fixed in T0 |

## 4. Isolation / concurrency / migrations

- Company isolation: new specs run A/B; B's fingerprint unchanged; `assertDataSourceNeverRequestedFor(B)` on the happy path; guard uses the publisher's own manager only.
- Concurrency: advisory-lock behaviour unchanged; V6 proves single effect; deadlock retry in `runHandlerThroughPosting` untouched (three historical `deadlock detected` rejections seen in the T0 snapshot are pre-existing, manufacturing paths, recoverable by re-drive).
- **No migration, no schema change, no data change** in T1.

## 5. Residuals / classification (not hidden)

1. **Time-of-check gap** — a period closed or chart edited between the publish-time dry-run and the later post-commit dispatch still yields a REJECTED event; it is now visible in the exceptions view and recoverable by re-drive (proven). Closing it completely (inline posting) is deferred: the bus supports it, but a rejection there is returned not thrown, nested-transaction behaviour needs its own spike. **Classification: accepted, documented, non-blocking.**
2. Contract-path (non-emitting) callers — customer/supplier payments are covered by the guard; **payroll disbursement** cash leg still has no bank GL by design (owner policy open) and **COD custody** legs are GL-posted at remittance; both are reported as `deferredByPolicy`, not as exceptions.
3. The generic cash-in/out endpoints, permissions (one node `finance:editable`), idempotency-header enforcement and reversal ownership are **T2**, not T1.
4. The 21-spec subset ran partly while the exceptions service was being added; the final 23/23 run above was executed on the final code with no edits in between.
5. Historical anomalies from T0 (3 legs / 222.00 with REJECTED events; MAIN-CASH fallback postings; 278 fixture accounts with no GL) remain in the rollback snapshot only; **not repaired**; owner of remediation: data owner of that snapshot (none required for current `daii_dev`, which holds no treasury movements).

## 6. Decision

**Gate T1: PASSED** on the evidence above. Proceeding to T2 (reversal ownership first). Dependency noted: supplier-payment reversal needs Procurement's allocation model and its supplier-invoice workflow (`supplier-invoice-process.ts`) — coordination before touching.
