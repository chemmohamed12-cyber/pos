#!/usr/bin/env bash
# usage: sim-app-start.sh <dir-with-dist> <db-name> <port> <logfile> ; writes pid to <logfile>.pid
DIR="$1"; DBN="$2"; PORT="$3"; LOG="$4"
PW="$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('DAII_BIZ_PG_PASSWORD','User')" | tr -d '\r\n')"
ENVF="${LOG}.env"
grep -v "^DB_\|^PORT=\|^NODE_ENV\|^DATABASE_CREDENTIAL\|^JWT_ACCESS_SECRET\|^JWT_REFRESH_SECRET\|^INTEGRATION_ENCRYPTION_KEY" "D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/.env" > "$ENVF"
cat >> "$ENVF" <<EOF
NODE_ENV=${SIM_NODE_ENV:-development}
PORT=$PORT
DB_HOST=127.0.0.1
DB_PORT=5546
DB_USER=daii_biz_test
DB_PASSWORD=$PW
DB_NAME=$DBN
DATABASE_CREDENTIAL_ENCRYPTION_KEY=${SIM_DBKEY:-daii_dev_database_credential_encryption_key_do_not_use_in_prod}
${SIM_EXTRA}
MEDIA_STORAGE_PATH=D:/DAII-SIM-1110/storage/media
EOF
powershell -NoProfile -Command "
\$envs = Get-Content '$ENVF' | Where-Object { \$_ -match '^[A-Z_]+=' };
foreach (\$l in \$envs) { \$i = \$l.IndexOf('='); [Environment]::SetEnvironmentVariable(\$l.Substring(0,\$i), \$l.Substring(\$i+1), 'Process') }
\$p = Start-Process -FilePath node -ArgumentList 'dist/main.js' -WorkingDirectory '$DIR' -RedirectStandardOutput '${LOG}.out' -RedirectStandardError '${LOG}.err' -PassThru -WindowStyle Hidden;
\$p.Id | Out-File -Encoding ascii '${LOG}.pid'; 'started pid ' + \$p.Id"
rm -f "$ENVF"
