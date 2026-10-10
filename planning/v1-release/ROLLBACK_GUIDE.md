# Rollback Guide — Daii V1

## Application rollback

Standard blue/green or redeploy-previous-artifact rollback — the backend and frontend are stateless build artifacts (`backend/dist/`, `frontend/dist/`). No in-process state to drain beyond normal graceful shutdown.

## Database rollback

Migrations are reversible one at a time:

```bash
cd backend
npm run migration:revert
```

Each `down()` was spot-checked this release round (30+ of 70 migrations, spanning the full timeline) and correctly reverses its `up()` — including correct child-before-parent drop order and numbering-sequence cleanup. Revert one migration at a time and re-check application compatibility after each, rather than reverting many at once, since a rolled-back schema must still match whichever application build you're rolling back to.

**No destructive migration exists in the current set** — no `down()` silently drops data outside of what its own `up()` added; column adds are reverted with `DROP COLUMN`, table creates with `DROP TABLE`, matching what was created.

## If a security fix needs to be rolled back

Don't. Every fix in `SECURITY_AUDIT_FINAL.md` closes a real, live-verified authorization or data-integrity gap (one BLOCKER, three HIGH). Rolling any of them back re-opens that gap. If a fix is suspected of causing a regression, fix the regression forward rather than reverting the security boundary.

## Emergency: database connection lost mid-deploy

The app retries the database connection on boot (`TypeOrmModule` retry logic observed live this round: 3 retries with backoff before failing). If it exhausts retries, it exits non-zero — no partial/degraded boot state to clean up. Restart once connectivity is restored.
