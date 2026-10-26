# Alpha — warehouse branch assignment: handover to the data owner (2026-10-26)

**For:** the Alpha data owner / administrator. **Status:** waiting for the owner's assignments — nothing has been assigned, inferred or backfilled.

## What to do
1. Open the worksheet `12-alpha-warehouse-branch-worksheet.csv` (or `.md`, same content, read-only facts about the 13 warehouses: kind, parent, responsible user, how many stock movements / sales orders / purchase orders / vehicle custody records reference each, and whether its name mentions a branch — that last column is a **fact, not a suggestion**).
2. Fill the **last column** with the owning branch of each warehouse: one of the active Alpha branches (`كتامه`, `طنطا`, `rana`) — or leave it empty and write why (the warehouse stays unassigned).
3. A warehouse that is a custody sub-location follows its parent; assign the parent.
4. Return the file signed with name and date. (The approver of the assignments and the approver of the later backfill may be different people; both are recorded.)

## What happens next (only after the signed worksheet is received)
1. The assignments are applied **through the validated warehouse screen/API** (branch must exist, be active and a branch — a warehouse can never be linked to a department or an archived unit); each change is audited.
2. A new **dry-run** is produced for the four dev companies and compared with `4-…` / `13-…` (this run found 10 Alpha documents, 0 derivable): which documents would receive which branch, which stay unassigned and why, conflicts, and the financial checksums (must be identical before/after).
3. The dry-run diff is submitted for approval. **Only after written approval** is `POST organization/legacy/backfill` run with `confirm`; the changed rows are listed from `org_migration_log` and a post-application verification is recorded.
Nothing in this procedure touches financial amounts; stamped documents are never rewritten later; production data is out of scope.
