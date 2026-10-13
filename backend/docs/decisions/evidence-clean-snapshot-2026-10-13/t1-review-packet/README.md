# T1 dependency change — review packet for the independent reviewer (2026-10-14)

**Status: REVIEW PENDING — no eligible reviewer is appointed; nothing here is a review.** T1 stays *implemented and author-verified, pending final acceptance* until (1) an independent reviewer records a result on this packet and (2) the host-level proxy compatibility check (`../../DAII-T1-HOST-PROXY-CHECK-PROTOCOL-2026-10-14.md`) is completed by someone with host access.

**What is to be reviewed (exact identity).** Commit `8ec6de4a615c4e9962317ce6a6e9c5b6c91d37ec`, parent `d3ad24b558b72dec60d55b4ec5b61fb2619eff85`, the single file `backend/package-lock.json` (1 file, 176 insertions, 67 deletions). `package.json` is byte-identical before and after. Rehearsal it must equal: `../dependency-t1-rehearsal/rehearsal-result.json` (taken at the HEAD of 2026-10-13, scratch copy, repository untouched).

**Mechanical checks already computed from the two committed lockfiles (`mechanical-checks.json`; the reviewer should recompute them, the script logic is `git show <rev>:backend/package-lock.json` + a comparison of the `packages` maps):**
| Check | Result |
|---|---|
| lockfile sha256 before / after | `4c710e00…` / `81d2bc1e…` |
| entries whose version changed | 22 — **identical** to the 22 of the rehearsal (path, from, to) |
| entries added | 8 — **identical** to the rehearsal (path, version); all MIT, runtime scope (the `file-type` chain) |
| entries removed | 0 |
| entries with the same version but any other field changed (dependency edges, `resolved`, `integrity`, `license`, `engines`, flags) | **none** |
| every changed/added entry resolves from `registry.npmjs.org` | yes (none from another host) |
`touched-entries.tsv` lists each of the 30 entries with from/to, licence, scope, resolved host and the integrity-hash prefix, for comparison with the registry.

**What the reviewer is asked to decide.** (a) Is the diff exactly the intended T1 scope and nothing more? (b) Do the integrity hashes of the 30 entries match the registry for those versions (`npm view <pkg>@<version> dist.integrity`)? (c) Are the 8 added packages acceptable as new runtime dependencies (licence MIT; origin: the `@nestjs/common` patch bump)? (d) Is rollback (`git revert 8ec6de4`, then `npm ci`) adequate? Independence: the reviewer must not be the person who applied the change (the closeout session) nor anyone in the independence register.

**What was verified by the author (not a review).** `evidence-clean-snapshot-2026-10-13/8ec6de4-final-verification/`: CI PASS with a fresh `npm ci` of this lockfile, ambient suites, 92-spec isolation regression 0 FAIL, business suite all steps passed — author track, one clean snapshot, `dirtyPaths: []`.

**Coordination note (shared environment).** The shared development `node_modules` of the repository follow the *old* lockfile. No `npm ci` was run there. Before anyone does, announce it to the sessions that use that tree: `npm ci` deletes and rebuilds `node_modules`, and any running dev server or test run in that tree would break or change dependency versions mid-run. The proof runs used a private snapshot with its own install.
