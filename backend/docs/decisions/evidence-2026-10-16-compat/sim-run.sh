#!/usr/bin/env bash
# full engine sequence for the 1.1.10 package; extra env (e.g. RELEASE_COMPANY_MIGRATIONS) is inherited. usage: sim-run.sh <tag>
S="C:/Users/chem_/AppData/Local/Temp/claude/D--CLAUDE-CODE-XNEXUS-WORKSPACE-1-hosting-daii-xnexustech-com-release-new/2459ecb6-c283-4a87-93b2-677ef29fdc92/scratchpad"
T="$1"; PKG="D:/DAII-LOCAL-DEPLOY/release-out/Daii-Release-v1.1.10-2026-10-16.zip"
"$S/sim.sh" backup > "$S/run-$T-backup.json"; B=$(grep -o '"backupRunId": "[^"]*"' "$S/run-$T-backup.json" | cut -d'"' -f4)
"$S/sim.sh" upload "$PKG" > "$S/run-$T-upload.json"; R=$(grep -o '"releaseId": "[^"]*"' "$S/run-$T-upload.json" | cut -d'"' -f4)
"$S/sim.sh" link $R $B > "$S/run-$T-link.json"
"$S/sim.sh" deploy $R > "$S/run-$T-deploy.json"
echo "release=$R backup=$B"; grep '"status"' "$S/run-$T-deploy.json" | head -2
node -e "
const t=require('fs').readFileSync('$S/run-$T-deploy.json','utf8');const j=JSON.parse(t.slice(t.indexOf('{\n  \"releaseId\"')));
console.log(j.status,j.errorMessage);for(const e of j.events)if(/fanout|evidence|failed|rolled/.test(e.action))console.log(e.action,e.result,e.after.slice(0,700))"
