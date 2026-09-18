# Daii — Server Cleanup Report

Analysis of `Daii-Server-Full-Snapshot-2026-08-31` for stale / duplicated /
legacy content. **Nothing here has been deleted.** Every LEGACY item is an
*archival candidate* to be **moved** to `archive/` (see
`CANONICAL_SERVER_STRUCTURE.md`) only after the reference check in §3 passes.
Per the CTO directive: `UNKNOWN` is never deleted; there are no `UNKNOWN`
items.

## 1. Space / clutter summary

| Item | Files | Disposition | Why |
|---|---:|---|---|
| `backend/` (server root) | 35,410 | **ARCHIVE** | Pre-`release-new` backend incl. `node_modules`. Passenger runs `release-new/backend`, not this. |
| `release-v1.0.2-staging/` | 33,782 | **ARCHIVE** | Superseded staging tree incl. `node_modules`. |
| `frontend/` (server root) | 103 | **ARCHIVE** | Pre-`release-new` frontend source. |
| `frontend-v1.0.2-staging/` | 107 | **ARCHIVE** | Superseded. |
| `backend.zip` | — | **ARCHIVE → `archive/incoming-artifacts/`** | Old upload artifact. |
| `Daii-Frontend-v1.0.2.zip` | — | **ARCHIVE → `archive/incoming-artifacts/`** | Old upload artifact. |
| `Daii_Final_Release_2026-08-25.zip` | — | **ARCHIVE → `archive/incoming-artifacts/`** | Old upload artifact. |
| `Daii_Final_Release_20260828.zip` | — | **ARCHIVE → `archive/incoming-artifacts/`** | Old upload artifact. |
| `release-new/backend/public.pre-v1.0.3/` | 5 | **KEEP** | Pre-v1.0.3 frontend bundle — rollback evidence. Move to `_deploy/previous/` when that area is created. |
| `release-new/backend/public.backup.20260829-205543/` | 2 | **KEEP** | Older public snapshot — rollback evidence. |
| `release-new/backend/stderr.log` | — | **KEEP (rotate)** | Runtime log; useful history. Truncate/rotate, don't delete outright. |
| Duplicated doc trees (`architecture/`, `planning/`, `_source-audits/`, `MASTER_*.md` at **both** server root and `release-new/`) | ~70 each | **DE-DUPLICATE** | Keep one canonical copy under `docs/`. |
| `.claude/launch.json` | 1 | **KEEP** | Dev-tool config, inert on the server. |
| `import-template.xlsx` (×2) | 1 each | **KEEP one** | Reference import template. |
| `cgi-bin/` (empty), `.well-known/` | — | **KEEP — DO NOT TOUCH** | cPanel/SSL infrastructure. |

Archiving the two big trees (`backend/`, `release-v1.0.2-staging/`) reclaims
the bulk of the ~130 MB and removes the "which backend is real?" ambiguity
PART 1 §2 calls out.

## 2. Duplicate / near-duplicate source detection

- `release-new/backend/src` (374 files, v1.0.3) vs server-root `backend/src`
  — **different versions**, not copies. Server-root is older. Archive it,
  don't merge.
- `release-new/backend/public` vs `release-new/frontend/dist` — **identical**
  (`index-DtuYiAhd.js`, `index-j2WWxJ8K.css`, same `index.html`). This is
  the *correct* synced state; the deploy pipeline keeps it that way.
- `release-new/backend/tools/data-repair/*` — same files as the workspace
  (both deferred migrations present). No divergence.

## 3. Reference check to run BEFORE moving anything (on the host)

For each archival candidate `X`, confirm nothing live points at it:

```bash
cd /home/xnexdrgr/daii.xnexustech.com
# 1. Passenger config
grep -n "X" .htaccess release-new/backend/.htaccess 2>/dev/null    # must be empty
# 2. app code / config
grep -rn "X" release-new/backend/src release-new/backend/dist/main.js 2>/dev/null
# 3. cron / user scripts
crontab -l | grep -n "X"
# 4. the app's own env
#    (cPanel → Setup Node.js App → Environment variables — check no path points into X)
```

Only if all four are clean: `mkdir -p archive && mv X archive/` (a **move**,
reversible, never `rm`).

## 4. Ordering

1. Create `archive/` and `_deploy/` skeletons (mkdir).
2. `cp -a release-new/backend _deploy/previous/backend`.
3. Archive, one at a time with the §3 check between each:
   `release-v1.0.2-staging` → `frontend-v1.0.2-staging` →
   server-root `frontend` → server-root `backend` → the four root `*.zip`.
4. De-duplicate doc trees → `docs/`.
5. Rotate `stderr.log`.
6. Re-run `bash release-new/backend/tools/deploy/verify-deploy.sh` — must
   still pass (proves nothing archived was load-bearing).

## 5. Not done here

- No deletion of anything, anywhere.
- **`release-new/backend/node_modules` is a symlink** to the nodevenv
  `lib/node_modules` — it is RUNTIME infrastructure, never an archival
  candidate, never `rm`'d. (`find -type l` on the extracted snapshot misses
  it because `tar` could not recreate the link.)
- The `احمد/` folder named in `.gitignore` as possibly holding **real
  business data** is not present in this snapshot — if it exists on the
  host, treat it as CONFIDENTIAL and out of scope for cleanup.
