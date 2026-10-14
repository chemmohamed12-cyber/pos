#!/usr/bin/env node
/**
 * HOTFIX for the INSTALLED release engine v1.1.5 (one function, one file).
 *
 * Problem (host evidence, release 1.1.7 upload 2026-10-10 01:22 Cairo): the engine's pre-swap environment check calls
 *   const { stdout } = await execFileAsync(node, ['-e', script, schemaFile], ...); stdout.trim()
 * and on this host `stdout` is undefined, so EVERY deploy aborts before the swap with
 *   "ENVIRONMENT_INVALID ... Cannot read properties of undefined (reading 'trim')".
 * The deploying engine is the INSTALLED one, so a fix inside a new package cannot help: the installed file has to be corrected once.
 *
 * What it changes: ONLY the body that builds `script` and reads its answer in `verifyCandidateEnvironment` — the child now writes its verdict to a temp FILE and the engine
 * reads that file (nothing depends on how this runtime returns a child's stdout). Same schema, same validation, same decisions.
 *
 * Safety: DRY RUN by default. It refuses unless the file's SHA-256 is the known 1.1.5 build and the original block is present exactly once. `--apply` writes a timestamped
 * backup next to the file FIRST, patches, runs `node --check` on the result and restores the backup automatically if that fails. It touches nothing else (no database, no
 * environment, no other file) and does not restart the application.
 *
 * usage:  node patch-envcheck-1.1.5.js <path-to-backend>            # dry run
 *         node patch-envcheck-1.1.5.js <path-to-backend> --apply
 *         node patch-envcheck-1.1.5.js <path-to-backend> --restore  # put the newest backup back
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const KNOWN_SHA256 = '3cfa3278793aadbf8b405eecab7720b94811300688ea2898222573debdbff5b5'; // dist/foundation/release/release-execution.service.js of Daii-Release-v1.1.5-2026-10-09.zip
const ORIGINAL = `        const script = "const m=require(process.argv[1]);const s=m.configurationValidationSchema;" +
            "if(!s||typeof s.validate!=='function'){console.log(JSON.stringify({skipped:true}));process.exit(0)}" +
            "const r=s.validate(process.env,{abortEarly:false,allowUnknown:true});" +
            "console.log(JSON.stringify({errors:r.error?r.error.details.map(function(d){return d.message}):[]}))";
        try {
            const { stdout } = await execFileAsync(this.config.releaseBuild.nodeBin, ['-e', script, schemaFile], { cwd: candidatePath, env: process.env, timeout: 30_000 });
            const parsed = JSON.parse(stdout.trim().split('\\n').pop() ?? '{}');`;
const REPLACEMENT = `        const script = "const fs=require('fs');const out=process.argv[2];" +
            "const m=require(process.argv[1]);const s=m.configurationValidationSchema;" +
            "if(!s||typeof s.validate!=='function'){fs.writeFileSync(out,JSON.stringify({skipped:true}));process.exit(0)}" +
            "const r=s.validate(process.env,{abortEarly:false,allowUnknown:true});" +
            "fs.writeFileSync(out,JSON.stringify({errors:r.error?r.error.details.map(function(d){return d.message}):[]}))";
        const __hfFs = require('fs'), __hfWorkDir = __hfFs.mkdtempSync(require('path').join(require('os').tmpdir(), 'daii-envcheck-')), __hfOut = require('path').join(__hfWorkDir, 'verdict.json');
        try {
            await new Promise((resolve, reject) => require('child_process').execFile(this.config.releaseBuild.nodeBin, ['-e', script, schemaFile, __hfOut], { cwd: candidatePath, env: process.env, timeout: 30_000 }, (e) => (e ? reject(e) : resolve())));
            const parsed = JSON.parse(__hfFs.readFileSync(__hfOut, 'utf8'));`;

const [, , backendDir, flag] = process.argv;
if (!backendDir) { console.error('usage: node patch-envcheck-1.1.5.js <path-to-backend> [--apply|--restore]'); process.exit(2); }
const file = path.join(backendDir, 'dist', 'foundation', 'release', 'release-execution.service.js');
if (!fs.existsSync(file)) { console.error('NOT FOUND: ' + file); process.exit(2); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

if (flag === '--restore') {
  const baks = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('release-execution.service.js.bak-')).sort();
  if (!baks.length) { console.error('no backup found'); process.exit(1); }
  const bak = path.join(path.dirname(file), baks[baks.length - 1]);
  fs.copyFileSync(bak, file);
  console.log('restored ' + bak + ' -> ' + file + '\nsha256 now ' + sha(fs.readFileSync(file)));
  process.exit(0);
}

const buf = fs.readFileSync(file);
const crlf = buf.toString('utf8').includes('\r\n');
console.log('file   : ' + file + '\nsha256 : ' + sha(buf) + (sha(buf) === KNOWN_SHA256 ? '  (= the known v1.1.5 build)' : '  (DIFFERENT from the known v1.1.5 build)'));
if (sha(buf) !== KNOWN_SHA256) { console.error('REFUSING: the installed file is not the v1.1.5 build this hotfix was written and tested for. Nothing changed.'); process.exit(3); }
let text = buf.toString('utf8'); if (crlf) text = text.replace(/\r\n/g, '\n');
const count = text.split(ORIGINAL).length - 1;
if (count !== 1) { console.error('REFUSING: the original block was found ' + count + ' time(s), expected exactly 1. Nothing changed.'); process.exit(3); }
const patched = text.replace(ORIGINAL, () => REPLACEMENT);
console.log('plan   : replace 1 block (' + ORIGINAL.split('\n').length + ' lines -> ' + REPLACEMENT.split('\n').length + ' lines) in verifyCandidateEnvironment');
if (flag !== '--apply') { console.log('DRY RUN - nothing written. Re-run with --apply to patch.'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const bak = file + '.bak-' + stamp;
fs.copyFileSync(file, bak);
fs.writeFileSync(file, crlf ? patched.replace(/\n/g, '\r\n') : patched);
try {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
} catch (e) {
  fs.copyFileSync(bak, file);
  console.error('node --check FAILED, original restored. ' + String(e.stderr || e.message).split('\n')[0]);
  process.exit(4);
}
console.log('PATCHED. backup: ' + bak + '\nsha256 now: ' + sha(fs.readFileSync(file)) + '\nNext: restart the application (cPanel > Setup Node.js App > Restart) so the new code is loaded.');
