Evidence for the restore-point stage (B1) and the two-step Stage B (final tool hashes in 00-tool-hashes.txt; final2.sh is the script).
Scenario 1 (create policy): refusals a-f (exit 3, nothing changed), failing run (A migrated, B failed, C not attempted, exit 2), recovery, no-op.
Scenario 2 (owner flow): B2 with require-recent and no restore points = REFUSED before any migration; B1 with the wrong policy = REFUSED; B1 = RESTORE_POINTS_READY (files, sizes, SHA-256); B2 uses them (basis "recent") = SUCCESS; second run NOTHING_TO_DO.
s2-08-restore-tests.txt: BOTH restore points were restored with pg_restore into scratch databases (migrations 288, tables 181 = source). Done on the isolated test cluster (PostgreSQL 18 tools), not on PostgreSQL 10.
launcher-b1-failed-dump-refused-fixture-artifact.txt: a launcher run whose fake environment had a corrupted PG_DUMP_BIN: the dump failed, the tool answered REFUSED (exit 3), no migration ran, no Company status changed (also shows the failed-restore-point path).
The database password does not appear in any file here (literal search).
