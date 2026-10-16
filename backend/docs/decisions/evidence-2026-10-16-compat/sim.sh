#!/usr/bin/env bash
# isolated legacy-engine simulation driver (never prints the DB password)
export SIM_ROOT=D:/DAII-SIM-1110
export SIM_ENV_FILE="D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/.env"
export DB_HOST=127.0.0.1 DB_PORT=5546 DB_USER=daii_biz_test
export DB_PASSWORD="$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('DAII_BIZ_PG_PASSWORD','User')" | tr -d '\r\n')"
export DB_NAME=daii_test_biz_t98_sim_cp SIM_TARGET_DB=daii_test_biz_t98_sim_cp SIM_ACTOR_EMAIL=bv.admin@example.test
export DATABASE_CREDENTIAL_ENCRYPTION_KEY=daii_dev_database_credential_encryption_key_do_not_use_in_prod
export PG_DUMP_BIN="C:\Program Files\PostgreSQL\18\bin\pg_dump.exe"
cd "D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/.claude/worktrees/integration/backend"
node tools/release-sim/local-deploy-harness.js "$@" 2>&1 | sed "s/$DB_PASSWORD/***/g"
