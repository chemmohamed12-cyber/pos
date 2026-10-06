import csv, hashlib, json, os, shutil, subprocess, sys, datetime, collections
sys.stdout.reconfigure(encoding='utf-8')
D = os.path.dirname(os.path.abspath(__file__))
REPO = r'D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\release-new'
BACK = os.path.join(REPO, 'backend')
ROOT = r'D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\_execution-baselines'
now = datetime.datetime.now()
EB = 'EB-WP04-' + now.strftime('%Y%m%d-%H%M%S')
SNAP = os.path.join(ROOT, EB)
os.makedirs(SNAP)
BS = os.path.join(SNAP, 'backend')

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=REPO, capture_output=True, text=True).stdout.strip()
start = {r['path']: r for r in csv.DictReader(open(os.path.join(D, 'tree_manifest_start.tsv'), encoding='utf-8'), delimiter='\t')}
own = {r['path']: r for r in csv.DictReader(open(os.path.join(D, 'ownership_manifest.tsv'), encoding='utf-8'), delimiter='\t')}
meta = dict(l.strip().split('=', 1) for l in open(os.path.join(D, 'tree_manifest_start.meta'), encoding='utf-8') if '=' in l)

# ---------- 1. copy scope ----------
def copytree(src, dst, skip=()):
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in skip]
        for f in files:
            s = os.path.join(root, f)
            rel = os.path.relpath(s, src)
            t = os.path.join(dst, rel)
            os.makedirs(os.path.dirname(t), exist_ok=True)
            shutil.copy2(s, t)

copytree(os.path.join(BACK, 'src'), os.path.join(BS, 'src'))
for f in ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'nest-cli.json', 'jest.config.js', 'eslint.config.mjs']:
    if os.path.exists(os.path.join(BACK, f)):
        shutil.copy2(os.path.join(BACK, f), os.path.join(BS, f))
# governing Architecture Baseline documents exactly as inventoried (files present in the start manifest, unchanged since)
docs_included = []
for p, r in start.items():
    if p.startswith('backend/docs/decisions/saas-control-plane/'):
        live = os.path.join(REPO, p.replace('/', os.sep))
        if os.path.exists(live) and sha(live) == r['sha256']:
            t = os.path.join(SNAP, p.replace('/', os.sep))
            os.makedirs(os.path.dirname(t), exist_ok=True)
            shutil.copy2(live, t)
            docs_included.append(p)

# ---------- 2. build dist INSIDE the snapshot (build artifact matches the pinned src) ----------
subprocess.run(['cmd', '/c', 'mklink', '/J', os.path.join(BS, 'node_modules'), os.path.join(BACK, 'node_modules')], capture_output=True)
b = subprocess.run(['node', os.path.join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], cwd=BS, capture_output=True, text=True, encoding='utf-8', errors='replace')
build_errors = [l for l in (b.stdout + b.stderr).splitlines() if ' error TS' in l]
subprocess.run(['cmd', '/c', 'rmdir', os.path.join(BS, 'node_modules')], capture_output=True)  # removes the junction only
for junk in ['tsconfig.build.tsbuildinfo', 'tsconfig.tsbuildinfo']:
    p = os.path.join(BS, junk)
    if os.path.exists(p):
        os.remove(p)
dist_files = sum(len(fs) for _, _, fs in os.walk(os.path.join(BS, 'dist')))

# ---------- 3. manifest + PIN HASH ----------
def manifest(base):
    rows = []
    for root, _, files in os.walk(base):
        for f in files:
            if f in ('PIN.txt', 'BASELINE.json'):
                continue
            p = os.path.join(root, f)
            rows.append((os.path.relpath(p, base).replace('\\', '/'), sha(p)))
    rows.sort()
    return rows, hashlib.sha256('\n'.join(f'{a}\t{b}' for a, b in rows).encode('utf-8')).hexdigest()

rows, pin_hash = manifest(SNAP)
with open(os.path.join(SNAP, 'SNAPSHOT-MANIFEST.tsv'), 'w', encoding='utf-8') as f:
    f.write('path\tsha256\n')
    for a, b_ in rows:
        f.write(f'{a}\t{b_}\n')

# ---------- 4. baseline membership (included vs excluded) ----------
def in_scope(p):
    return p.startswith('backend/src/') or p in docs_included
inc_status = ('OWNED / VERIFIED', 'HISTORICAL / ALREADY VERIFIED', 'TEST-ONLY')
counts = collections.Counter(); included = []; excluded = []
for p, r in own.items():
    if not in_scope(p):
        counts['OUT-OF-SCOPE (not in this baseline)'] += 1
        continue
    st = r['status'].split(' / ')[0] if False else r['status']
    live = os.path.join(REPO, p.replace('/', os.sep))
    drifted = (not os.path.exists(live)) or sha(live) != start[p]['sha256']
    if drifted:
        counts['DRIFTED since inventory (excluded)'] += 1; excluded.append((p, 'DRIFTED', r['status'])); continue
    if r['status'] in inc_status:
        counts[r['status']] += 1; included.append((p, r['status'], r['area21_shared']))
    else:
        counts[r['status']] += 1; excluded.append((p, r['status'].split(' / ')[0], r['status']))

incl_shared = [p for p, s, sh_ in included if sh_ == 'True']
unattr_in_baseline = [p for p, s, _ in included if s.startswith('UNATTRIBUTED')]
queue = [r for r in own.values() if r['status'] == 'UNATTRIBUTED' and r['area21_shared'] == 'True']

with open(os.path.join(D, 'baseline_included.tsv'), 'w', encoding='utf-8') as f:
    f.write('path\tstatus\tarea21_shared\n'); [f.write(f'{p}\t{s}\t{sh_}\n') for p, s, sh_ in included]
with open(os.path.join(D, 'baseline_excluded.tsv'), 'w', encoding='utf-8') as f:
    f.write('path\texcluded_as\tstatus\n'); [f.write(f'{p}\t{a}\t{s}\n') for p, a, s in excluded]
with open(os.path.join(D, 'area21_shared_reproof_queue.tsv'), 'w', encoding='utf-8') as f:
    f.write('path\tstatus\tmtime\thint_NOT_ownership_evidence\n'); [f.write(f"{r['path']}\t{r['status']}\t{r['mtime']}\t{r.get('hint_NOT_ownership_evidence','')}\n") for r in queue]
with open(os.path.join(D, 'baseline_area21_shared_included.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(incl_shared) + '\n')

info = dict(id=EB, head=head, pin_hash=pin_hash, created=now.strftime('%Y-%m-%d %H:%M:%S'), snapshot_dir=SNAP,
            scope='backend/src/** + backend build/test config + dist (built inside the snapshot from the pinned src) + Architecture Baseline docs exactly as inventoried (saas-control-plane)',
            inventory_manifest_sha256=meta.get('manifest_sha256'), inventory_entries=meta.get('entries'),
            files_in_snapshot=len(rows), dist_files=dist_files, build_ts_errors=len(build_errors), build_error_sample=build_errors[:5],
            counts=dict(counts), included=len(included), excluded=len(excluded), unattributed_in_baseline=len(unattr_in_baseline),
            area21_shared_included=len(incl_shared), reproof_queue=len(queue))
json.dump(info, open(os.path.join(SNAP, 'BASELINE.json'), 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
open(os.path.join(SNAP, 'PIN.txt'), 'w').write(f'{EB}\nHEAD={head}\nPIN_HASH={pin_hash}\ncreated={info["created"]}\n')
print(json.dumps(info, indent=2, ensure_ascii=False))
