param(
  [Parameter(Mandatory)][string]$Root,        # e.g. D:/DAII-LOCAL-DEPLOY-R1111B  (new SIM_ROOT)
  [Parameter(Mandatory)][string]$Zip,         # package under test
  [Parameter(Mandatory)][string]$Ns,          # e.g. t72 -> databases daii_test_biz_t72_*
  [Parameter(Mandatory)][string]$Baseline,    # installed v1.1.10 tree to copy as the ACTIVE slot
  [int]$Port = 3690
)
$ErrorActionPreference = 'Stop'
$S = 'D:\DAII-LOCAL-DEPLOY-R1111\scripts'
$Ev = Join-Path $Root 'evidence'
New-Item -ItemType Directory -Force "$Root\deploy", $Ev | Out-Null
$main = "daii_test_biz_${Ns}_rh_main"; $co = "daii_test_biz_${Ns}_rh_co1"; $fm = "daii_test_biz_${Ns}_fresh_main"; $fc = "daii_test_biz_${Ns}_fresh_co1"; $dm = "daii_test_biz_${Ns}_down_main"; $dc = "daii_test_biz_${Ns}_down_co1"
# --- env file (same credentials/keys as the first rehearsal; DB names differ)
$src = Get-Content D:\DAII-LOCAL-DEPLOY-R1111\rehearsal.env | Where-Object { $_ -notmatch '^DB_NAME=' }
Set-Content "$Root\rehearsal.env" (@($src) + "DB_NAME=$main") -Encoding ascii
function LoadEnv { Get-Content "$Root\rehearsal.env" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] } } }
LoadEnv
# --- 1. installed v1.1.10 as ACTIVE slot
if (-not (Test-Path "$Root\deploy\app\dist\main.js")) { robocopy $Baseline "$Root\deploy\app" /E /NFL /NDL /NJH /NJS /NP /MT:8 | Out-Null }
$env:RH_APP = "$Root\deploy\app"
"installed build: " + ((Select-String -Path "$Root\deploy\app\package.json" -Pattern '"version"' | Select -First 1).Line.Trim()) | Tee-Object "$Ev\00-summary.log"
# --- 2. v1.1.10-schema databases
$env:RH_MAIN = $main; $env:RH_CO = $co; Set-Location $env:RH_APP
node "$S\bootstrap-1110.js" 2>&1 | Tee-Object -Append "$Ev\00-summary.log"
foreach ($d in $main, $co) { node "$S\schema-sig.js" $d "$Ev\pre-$d.json" | Tee-Object -Append "$Ev\00-summary.log" }
# --- 3. unmodified v1.1.10 release engine: backup -> upload -> link -> deploy (company fan-out ON)
$env:SIM_ROOT = ($Root -replace '\\','/'); $env:SIM_ENV_FILE = "$Root\rehearsal.env"; $env:SIM_TARGET_DB = $main; $env:RELEASE_COMPANY_MIGRATIONS = 'on'
Set-Location D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\release-new\.claude\worktrees\treasury-integrity\backend
$H = 'tools/release-sim/local-deploy-harness.js'
$bk = (node $H backup 2>&1 | Tee-Object "$Ev\01-backup.log" | Out-String); $bkId = [regex]::Match($bk, '"backupRunId":\s*"([^"]+)"').Groups[1].Value
$up = (node $H upload ($Zip -replace '\\','/') 2>&1 | Tee-Object "$Ev\02-upload.log" | Out-String); $relId = [regex]::Match($up, '"releaseId":\s*"([^"]+)"').Groups[1].Value
"backupRunId=$bkId releaseId=$relId" | Tee-Object -Append "$Ev\00-summary.log"
node $H link $relId $bkId 2>&1 | Tee-Object "$Ev\03-link.log" | Out-Null
$ErrorActionPreference = 'Continue'
node $H deploy $relId 2>&1 | Tee-Object "$Ev\04-deploy.log" | Out-Null
$ErrorActionPreference = 'Stop'
$dep = Get-Content "$Ev\04-deploy.log" -Raw
"deploy status: " + [regex]::Match($dep, '"status":\s*"(\w+)"').Groups[1].Value + " | fanout: " + [regex]::Match($dep, '"action": "release.deploy.company_fanout",[\s\S]{0,200}?"after": "([^"]+\\"migrated\\"[^"]+)"').Groups[1].Value | Tee-Object -Append "$Ev\00-summary.log"
# --- 4. schema equivalence: upgraded vs fresh install with the NEW tree
$env:RH_APP = "$Root\deploy\app"
foreach ($d in $main, $co) { node "$S\schema-sig.js" $d "$Ev\post-$d.json" | Tee-Object -Append "$Ev\00-summary.log" }
$env:RH_MAIN = $fm; $env:RH_CO = $fc; Set-Location $env:RH_APP
node "$S\bootstrap-1110.js" 2>&1 | Tee-Object -Append "$Ev\00-summary.log"
foreach ($d in $fm, $fc) { node "$S\schema-sig.js" $d "$Ev\fresh-$d.json" | Tee-Object -Append "$Ev\00-summary.log" }
# --- 5. reversibility on clones of the upgraded databases
LoadEnv
@"
const path=require('path');const {Client}=require(path.join(process.env.RH_APP,'node_modules','pg'));
(async()=>{const c=new Client({host:process.env.DB_HOST,port:+process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:'postgres'});await c.connect();
for(const [s,d] of [['$main','$dm'],['$co','$dc']]){await c.query('DROP DATABASE IF EXISTS "'+d+'" WITH (FORCE)');await c.query('CREATE DATABASE "'+d+'" TEMPLATE "'+s+'"');}
await c.end();})().catch(e=>{console.error(e.message);process.exit(1)});
"@ | Set-Content "$Ev\clone.js" -Encoding ascii
node "$Ev\clone.js"
foreach ($d in $dm, $dc) { $env:RH_CLONE = $d; $env:N = '21'; node "$S\down-test.js" 2>&1 | Tee-Object -Append "$Ev\06-down-test.log" | Out-Null; node "$S\schema-sig.js" $d "$Ev\after-down-$d.json" | Tee-Object -Append "$Ev\00-summary.log" }
"REHEARSAL-STAGE-1-COMPLETE" | Tee-Object -Append "$Ev\00-summary.log"
