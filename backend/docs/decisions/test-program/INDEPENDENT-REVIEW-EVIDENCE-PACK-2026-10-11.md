# Independent review — unified evidence pack (prepared by the verification session; NOT a review) — 2026-10-11

**Reviewer requirement:** did not write the fixes, the tests, `runInTransaction` or the helper, and made none of the commits under review. The author of this pack, of `runInTransaction`, of T-20/T-25/T-26 and of the WP-INV-10 fix is **not eligible**; the peer that authored the N-02/F-AUD-003 patches is not eligible either. Team 3 coordinates only.

| Finding | Product commits | Specs | Clean-snapshot evidence | Prior (non-independent) review |
|---|---|---|---|---|
| H3 `fulfillReservation`, `fulfillReservationsForOrder` | a798d9d, 5c5b791 | T-21 (A–J, E2) | `71e5f5e-final/`, `71e5f5e-reviewer-rerun/` | `N-02-FULFIL-RESERVATION-INDEPENDENT-REVIEW-2026-10-11.md` |
| H1 limit consume/release, H2 `releaseReservedQuantity`, H4 process start | 5c5b791 | T-24 | same | `N-02-F-AUD-003-AND-REMAINING-INDEPENDENT-REVIEW-2026-10-11.md` (§7) |
| F-AUD-003 | c764fc5 (+71e5f5e) | T-22, T-23 | same | same |
| H5 measurement | none | T-25 | `06ef615-h5/` (pre-fix: 8 PASS, 1 FAIL-DEFECT) | WP-INV-07 report |
| H5-D1 fix (WP-INV-10) | `03900ac` | T-25 (11 cases) + 6 shipment/delivery/returns isolation specs | `0390ac-wp-inv-10/` | none — **add to the review scope** |
| WP-AUD-08 guard (DEC-01b A) | `e344ca1` | T-26 (now 3/3), T-27 (6/6) | `e344ca1-wp-aud-08/` (isolation regression 64/91 so far, 0 failures — incomplete) | none — **add to the review scope** |
| Sequence lag baseline | none | T-26 | `9b52e46-t26/` | WP-AUD-08 design |
Also: `N-02-AND-F-AUD-003-CONSOLIDATED-STATUS-2026-10-11.md`, `COMMIT-AND-EVIDENCE-RECONCILIATION`, the 91-spec reconciliation (89 executed-pass / 1 skipped / 1 failed-blocked). Known limits: concurrency above 8, multi-instance, hosting, real outbox in H5.
Review questions: is each patch minimal and correct against its test; do the specs prove what their ids claim; are doubles declared; are statuses reported without upgrade. Output: a signed written conclusion, kept separate from the author's.
