#!/usr/bin/env bash
# Final evidence run for the owner tools (stages: A, B1 restore points, B2 apply) on the FINAL tool hashes.
S="C:/Users/chem_/AppData/Local/Temp/claude/D--CLAUDE-CODE-XNEXUS-WORKSPACE-1-hosting-daii-xnexustech-com-release-new/2459ecb6-c283-4a87-93b2-677ef29fdc92/scratchpad"
cd "D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/.claude/worktrees/integration/backend"
export PW="$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('DAII_BIZ_PG_PASSWORD','User')" | tr -d '\r\n')"
REL=33e82cda-ac2b-4e27-b828-0d3d522aad0d; F="$S/final2"; mkdir -p "$F"; T="$S/tool.sh"; C=company-migration-catchup
ACT="--actor-email bv.admin@example.test --release-id $REL"
sha256sum tools/maintenance/company-migration-*.js > "$F/00-tool-hashes.txt"
echo "##### SCENARIO 1: default policy (create): refusals, failing run, recovery, no-op  [Companies A-Verify, B-Fail(sabotaged), C-After]"
ALL=daii_test_biz_t98_sim_co,daii_test_biz_t98_sim_co2,daii_test_biz_t98_sim_co3
node "$S/state.js" > "$F/s1-00-state.txt"
"$T" company-migration-status > "$F/s1-01-stageA.txt"; "$T" $C > "$F/s1-02-plan.json"
for c in "a:--apply" "b:--apply $ACT --confirm-databases $ALL" "c:--apply $ACT --confirm-databases daii_test_biz_t98_sim_co --i-confirm-restore-points" "d:--apply --actor-email bv.admin@example.test --release-id 11111111-2222-3333-4444-555555555555 --confirm-databases $ALL --i-confirm-restore-points" "e:--apply --actor-email nobody@example.test --release-id $REL --confirm-databases $ALL --i-confirm-restore-points" "f:--apply --restore-points-only $ACT --confirm-databases $ALL"; do k=${c%%:*}; a=${c#*:}; "$T" $C $a > "$F/s1-03-refusal-$k.txt" 2>&1; echo "refusal $k exit $?"; done
node "$S/state.js" > "$F/s1-04-state-after-refusals.txt"; diff -q "$F/s1-00-state.txt" "$F/s1-04-state-after-refusals.txt" && echo "refusals changed nothing"
"$T" $C --apply $ACT --confirm-databases $ALL --i-confirm-restore-points > "$F/s1-05-failing-run.txt"; echo "failing run exit $?"; grep ^STATUS "$F/s1-05-failing-run.txt"; node "$S/state.js" | tee "$F/s1-06-state-after-failure.txt"
node -e "const {Client}=require('pg');(async()=>{const c=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:'daii_test_biz_t98_sim_co2'});await c.connect();await c.query('ALTER TABLE customers DROP COLUMN \"partyType\"');await c.end()})()"; echo "(fixture: cause removed)"
"$T" $C --apply $ACT --confirm-databases daii_test_biz_t98_sim_co2,daii_test_biz_t98_sim_co3 --i-confirm-restore-points > "$F/s1-07-recovery-run.txt"; echo "recovery exit $?"; grep ^STATUS "$F/s1-07-recovery-run.txt"
"$T" $C --apply $ACT --confirm-databases "" --i-confirm-restore-points > "$F/s1-08-second-run.txt"; echo "second run exit $?"; grep ^STATUS "$F/s1-08-second-run.txt"; node "$S/state.js" | tee "$F/s1-09-state-final.txt"
echo "##### SCENARIO 2: owner flow with REAL restore point verification  [fresh Companies without any backup]"
DBS=$(node "$S/fixture2.js"); D1=${DBS%%,*}; D2=${DBS##*,}; BOTH=$DBS; echo "databases: $BOTH"
cnt(){ node -e "const {Client}=require('pg');(async()=>{const q=async(d,s)=>{const c=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:d});await c.connect();const r=(await c.query(s)).rows;await c.end();return r};console.log(JSON.stringify({backups:(await q('daii_test_biz_t98_sim_cp','select count(*)::int n from backup_runs'))[0].n,m1:(await q('$D1','select count(*)::int n from migrations'))[0].n,m2:(await q('$D2','select count(*)::int n from migrations'))[0].n}))})()"; }
"$T" company-migration-status > "$F/s2-01-stageA.txt"; "$T" $C > "$F/s2-02-plan.json"; cnt > "$F/s2-03-state-initial.txt"; cat "$F/s2-03-state-initial.txt"
RELEASE_COMPANY_BACKUP_POLICY=require-recent "$T" $C --apply $ACT --confirm-databases $BOTH --i-confirm-restore-points > "$F/s2-04-b2-without-restore-points.txt" 2>&1; echo "B2 require-recent without restore points exit $?"; grep -E "^REFUSED|REFUSED" "$F/s2-04-b2-without-restore-points.txt" | head -1 | cut -c1-160; cnt
RELEASE_COMPANY_BACKUP_POLICY=require-recent "$T" $C --restore-points-only $ACT --confirm-databases $BOTH > "$F/s2-05-b1-wrong-policy.txt" 2>&1; echo "B1 wrong policy exit $?"
"$T" $C --restore-points-only $ACT --confirm-databases $BOTH > "$F/s2-06-b1-restore-points.txt" 2>&1; echo "B1 exit $?"; grep ^STATUS "$F/s2-06-b1-restore-points.txt"; cnt | tee "$F/s2-07-state-after-b1.txt"
node -e "const t=require('fs').readFileSync('$F/s2-06-b1-restore-points.txt','utf8');const j=JSON.parse(t.slice(t.indexOf('{'),t.lastIndexOf('}')+1));console.log(j.restorePointDetails.map(r=>r.company+' '+r.artifact+' '+r.status+' '+r.sizeBytes+'B').join(' | '));require('fs').writeFileSync('$F/s2-files.txt',j.restorePointDetails.map(r=>r.company+'|'+r.file).join('\n'))"
PGR="/c/Program Files/PostgreSQL/18/bin/pg_restore.exe"; i=0
while IFS='|' read -r comp file; do i=$((i+1)); f=$(echo "$file" | sed 's|\|/|g'); "$PGR" --list "$f" | wc -l | sed "s/^/restore test $comp: TOC lines /"; db=daii_test_biz_t98_rtest$i
  node -e "const {Client}=require('pg');(async()=>{const c=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:'postgres'});await c.connect();await c.query('DROP DATABASE IF EXISTS $db WITH (FORCE)');await c.query('CREATE DATABASE $db');await c.end()})()"
  PGPASSWORD="$PW" "$PGR" --host 127.0.0.1 --port 5546 --username daii_biz_test --no-password --dbname $db --no-owner "$f" 2>&1 | head -2
  node -e "const {Client}=require('pg');(async()=>{const c=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:'$db'});await c.connect();const r=(await c.query('select (select count(*) from migrations)::int m,(select count(*) from information_schema.tables where table_schema=\'public\')::int t')).rows[0];console.log('  restored scratch DB: migrations',r.m,'tables',r.t);await c.end()})()"
done < "$F/s2-files.txt" | tee "$F/s2-08-restore-tests.txt"
RELEASE_COMPANY_BACKUP_POLICY=require-recent "$T" $C --apply $ACT --confirm-databases $BOTH --i-confirm-restore-points > "$F/s2-09-b2-apply.txt"; echo "B2 apply exit $?"; grep ^STATUS "$F/s2-09-b2-apply.txt"; cnt | tee "$F/s2-10-state-after-b2.txt"; node -e "const t=require('fs').readFileSync('$F/s2-09-b2-apply.txt','utf8');const j=JSON.parse(t.slice(t.indexOf('{'),t.lastIndexOf('}')+1));console.log(JSON.stringify(j.restorePoints.map(r=>r.basis)),JSON.stringify(j.result))"
"$T" $C --apply $ACT --confirm-databases "" --i-confirm-restore-points > "$F/s2-11-second-run.txt"; echo "second run exit $?"; grep ^STATUS "$F/s2-11-second-run.txt"
"$T" company-migration-status > "$F/s2-12-stageA-final.txt"; grep -E "COMPANY.*ACTIVE" "$F/s2-12-stageA-final.txt" | grep -E "r[0-9]{6}" | cut -c1-120
grep -l -F "$PW" "$F"/* | wc -l | sed 's/^/files containing the DB password: /'
