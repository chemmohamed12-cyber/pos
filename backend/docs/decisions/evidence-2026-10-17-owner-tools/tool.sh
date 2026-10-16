#!/usr/bin/env bash
export SIM=D:/DAII-SIM-1110
export DB_HOST=127.0.0.1 DB_PORT=5546 DB_USER=daii_biz_test
export DB_PASSWORD="$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('DAII_BIZ_PG_PASSWORD','User')" | tr -d '\r\n')"
export DB_NAME=daii_test_biz_t98_sim_cp NODE_ENV=development
export DATABASE_CREDENTIAL_ENCRYPTION_KEY=daii_dev_database_credential_encryption_key_do_not_use_in_prod
export RELEASE_APP_ROOT=$SIM/deploy/app RELEASE_DEPLOY_ROOT=$SIM/deploy RELEASE_ACTIVE_DIRNAME=app RELEASE_STAGING_PATH=$SIM/storage/release-staging RELEASE_MANIFESTS_PATH=$SIM/storage/release-manifests RELEASE_BACKUP_STORAGE_PATH=$SIM/storage/backups FRONTEND_RUNTIME_PATH=$SIM/deploy/app/public ENTITLEMENT_MODE=unlicensed-full
export PG_DUMP_BIN="C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" PG_RESTORE_BIN="C:\Program Files\PostgreSQL\18\bin\pg_restore.exe"
set -a; . <(grep -E '^(JWT_|INTEGRATION_|CLOSING_|MEDIA_)' "D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/.env" | tr -d '\r'); set +a
cd "D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/.claude/worktrees/integration/backend"
SCRIPT="$1"; shift; node "tools/maintenance/$SCRIPT.js" --app-root $SIM/deploy/app "$@" 2>&1 | sed "s/$DB_PASSWORD/***/g"
exit ${PIPESTATUS[0]}
