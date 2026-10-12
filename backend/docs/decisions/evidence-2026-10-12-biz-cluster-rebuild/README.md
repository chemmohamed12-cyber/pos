# Test cluster 127.0.0.1:5546 — rebuild record (2026-10-12)

Authority: CTO "Test Environment Recovery and Verification Directive" (reference f843eae).

- **Why:** the original disposable cluster (system identifier `7695079006474257732`) stopped starting: `PANIC: could not locate a valid checkpoint record` after an unclean stop with `fsync=off` (`crashed-original-server.log`). `pg_resetwal` was not run; no improvised recovery.
- **Preserved (not deleted):** `.test-cluster/pg5546-crashed-backup-2026-10-12` (copy made before any change, 981 files) and `.test-cluster/pg5546-crashed-original-2026-10-12` (the original data directory, renamed; also 981 files). Both are outside git.
- **Rebuild:** `node tools/testing/biz-cluster-setup.js setup` (the approved procedure, unchanged): PostgreSQL 18.6, loopback only, scram-sha-256 only, `fsync=off`, role `daii_biz_test` LOGIN CREATEDB only, new passwords persisted only as User environment variables.
- **New identity:** system identifier `7695619915229547252` (`cluster-facts.json`). Previous facts: `cluster-facts-original-for-reference.json` and the unchanged `../evidence-2026-10-10-biz-cluster/cluster-facts.json`.
- **Test-configuration changes only:** `tools/testing/approved-test-databases.json` — `expectedSystemIdentifier` updated and `identityHistory` added; `tools/testing/db-guard-final-entry.test.js` — reads the facts file of the rebuilt cluster (all assertions unchanged, rebuilt facts file added to the secret scan). Same host, port, patterns, approver text; no production configuration touched; no guard rule weakened. Guard suite after the change: 50/50.
- **Health:** server started cleanly (`ready to accept connections`), `status` shows the expected roles/hba/settings; no user databases exist yet (the harness creates disposable `daii_test_biz_t*` databases per run).
