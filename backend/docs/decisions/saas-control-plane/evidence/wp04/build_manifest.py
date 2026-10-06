import hashlib, os, subprocess, sys, datetime
sys.stdout.reconfigure(encoding='utf-8')
REPO = r'D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\release-new'
OUTDIR = os.path.dirname(os.path.abspath(__file__))
tag = sys.argv[1]  # 'start' or 'end'

st = subprocess.run(['git', 'status', '--porcelain=v1', '-uall'], cwd=REPO, capture_output=True, text=True, encoding='utf-8').stdout
head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=REPO, capture_output=True, text=True).stdout.strip()
rows = []
for line in st.splitlines():
    code, path = line[:2], line[3:]
    if path.startswith('"'):
        path = path.strip('"')
    full = os.path.join(REPO, path.replace('/', os.sep))
    if code.strip() == 'D' or not os.path.exists(full):
        rows.append((path, code.strip() or '?', 'DELETED', 0, ''))
        continue
    h = hashlib.sha256(open(full, 'rb').read()).hexdigest()
    rows.append((path, code.strip(), h, os.path.getsize(full), datetime.datetime.fromtimestamp(os.path.getmtime(full)).strftime('%Y-%m-%d %H:%M:%S')))
rows.sort()
with open(os.path.join(OUTDIR, f'tree_manifest_{tag}.tsv'), 'w', encoding='utf-8') as f:
    f.write('path\tgit_status\tsha256\tbytes\tmtime\n')
    for r in rows:
        f.write('\t'.join(str(x) for x in r) + '\n')
mh = hashlib.sha256('\n'.join(f'{r[0]}\t{r[2]}' for r in rows).encode('utf-8')).hexdigest()
open(os.path.join(OUTDIR, f'tree_manifest_{tag}.meta'), 'w').write(f'HEAD={head}\nentries={len(rows)}\nmanifest_sha256={mh}\ncaptured={datetime.datetime.now():%Y-%m-%d %H:%M:%S}\n')
print(f'{tag}: HEAD={head[:12]} entries={len(rows)} modified={sum(1 for r in rows if r[1]=="M")} untracked={sum(1 for r in rows if r[1]=="??")} deleted={sum(1 for r in rows if r[2]=="DELETED")} manifest_sha256={mh}')
