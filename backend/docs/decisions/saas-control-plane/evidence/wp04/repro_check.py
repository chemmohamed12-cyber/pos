import hashlib, os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')
SNAP = r'D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\_execution-baselines\EB-WP04-20261005-155534\backend'
NM = r'D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\release-new\backend\node_modules'
TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'repro')
shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP)
shutil.copytree(os.path.join(SNAP, 'src'), os.path.join(TMP, 'src'))
for f in ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'nest-cli.json']:
    shutil.copy2(os.path.join(SNAP, f), TMP)
subprocess.run(['cmd', '/c', 'mklink', '/J', os.path.join(TMP, 'node_modules'), NM], capture_output=True)
b = subprocess.run(['node', os.path.join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], cwd=TMP, capture_output=True, text=True, encoding='utf-8', errors='replace')
subprocess.run(['cmd', '/c', 'rmdir', os.path.join(TMP, 'node_modules')], capture_output=True)
errs = [l for l in (b.stdout + b.stderr).splitlines() if ' error TS' in l]


def dist_rows(base):
    rows = {}
    d = os.path.join(base, 'dist')
    for root, _, files in os.walk(d):
        for f in files:
            p = os.path.join(root, f)
            rows[os.path.relpath(p, d).replace('\\', '/')] = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    return rows


a, c = dist_rows(SNAP), dist_rows(TMP)
diff = [k for k in set(a) | set(c) if a.get(k) != c.get(k)]
print('tsc errors in rebuild:', len(errs))
print('dist files: snapshot', len(a), '| rebuilt', len(c), '| differing', len(diff))
print('REPRODUCIBLE (rebuilt dist == pinned dist):', not diff)
for k in sorted(diff)[:8]:
    print('  differs:', k)
shutil.rmtree(TMP, ignore_errors=True)
