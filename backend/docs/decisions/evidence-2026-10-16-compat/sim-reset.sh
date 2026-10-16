#!/usr/bin/env bash
# Reset the isolated sim to the 1.1.9 state: stop app, restore ACTIVE=1.1.9 from the prev slot, recreate DBs from the _base templates, clear engine storage.
S="C:/Users/chem_/AppData/Local/Temp/claude/D--CLAUDE-CODE-XNEXUS-WORKSPACE-1-hosting-daii-xnexustech-com-release-new/2459ecb6-c283-4a87-93b2-677ef29fdc92/scratchpad"
for f in "$S"/simapp-*.pid; do [ -f "$f" ] && powershell -NoProfile -Command "Stop-Process -Id (Get-Content '$f') -Force -ErrorAction SilentlyContinue" ; rm -f "$f"; done
sleep 2
cd D:/DAII-SIM-1110/deploy
PREV=$(ls -d app.prev-* 2>/dev/null | head -1)
if [ -n "$PREV" ]; then rm -rf app; mv "$PREV" app; fi
rm -rf app.next-* app.failed-* app.prev-* ../storage/release-manifests ../storage/release-staging ../storage/backups
grep '"version"' app/package.json
export PW="$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('DAII_BIZ_PG_PASSWORD','User')" | tr -d '\r\n')"
cd "D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/.claude/worktrees/integration/backend"
node -e "
const {Client}=require('pg');(async()=>{const c=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:'postgres'});await c.connect();
for(const s of ['cp','co']){const n='daii_test_biz_t98_sim_'+s;await c.query('DROP DATABASE IF EXISTS \"'+n+'\" WITH (FORCE)');await c.query('CREATE DATABASE \"'+n+'\" TEMPLATE \"'+n+'_base\"')}
console.log('databases reset from base');await c.end()})().catch(e=>{console.error(e.message);process.exit(1)})"
