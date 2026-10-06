import json, os, re, sys, glob, csv, datetime, collections
sys.stdout.reconfigure(encoding='utf-8')
D = os.path.dirname(os.path.abspath(__file__))
PROJ = r'C:\Users\chem_\.claude\projects\D--CLAUDE-CODE-XNEXUS-WORKSPACE-1-hosting-daii-xnexustech-com-release-new'
TITLES = {'0f4192f6-7b2e-4bf7-9e05-d2187845edf0': 'Multi-Company front', '43695077-c526-4930-aeb5-2fb2bb195a73': 'DAII HR (fork)', 'df001241-da5e-4d09-991c-bafc14f9a20c': 'DAII manfacturing',
          '9aa5343c-d8f7-46b4-9232-baedc278c0cc': 'DAII HR', '84e7fca6-9da1-46cc-b1ed-3e8f7620e909': 'this lane'}
rows = list(csv.DictReader(open(os.path.join(D, 'ownership_manifest.tsv'), encoding='utf-8'), delimiter='\t'))
targets = {r['path']: r for r in rows if r['status'] == 'UNATTRIBUTED'}
base2paths = collections.defaultdict(list)
for p in targets:
    base2paths[os.path.basename(p)].append(p)
pat = re.compile('|'.join(re.escape(b) for b in base2paths))
hits = collections.defaultdict(lambda: collections.defaultdict(list))  # path -> session -> [ts]
for path in glob.glob(os.path.join(PROJ, '*.jsonl')):
    sid = os.path.basename(path)[:-6]
    with open(path, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            if '"type":"tool_use"' not in line or not ('"name":"Bash"' in line or '"name":"PowerShell"' in line or '"name":"Write"' in line):
                continue
            ms = set(pat.findall(line))
            if not ms:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            ts = d.get('timestamp')
            for b in (d.get('message', {}).get('content') or []):
                if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('name') in ('Bash', 'PowerShell', 'Write'):
                    blob = json.dumps(b.get('input', {}), ensure_ascii=False)
                    if b.get('name') == 'Write' and not blob.count('open(') and 'write' not in blob.lower():
                        continue
                    for m in set(pat.findall(blob)):
                        for p in base2paths[m]:
                            hits[p][sid].append(ts)
res = []
for p, r in targets.items():
    mt = datetime.datetime.strptime(r['mtime'], '%Y-%m-%d %H:%M:%S')
    cands = []
    for sid, tss in hits.get(p, {}).items():
        near = [t for t in tss if t and abs((datetime.datetime.strptime(t[:19], '%Y-%m-%dT%H:%M:%S') + datetime.timedelta(hours=3) - mt).total_seconds()) <= 20 * 60]
        if near:
            cands.append(f"{TITLES.get(sid, sid[:8])} (script/command naming this file within 20 min of mtime)")
    res.append((p, '; '.join(sorted(set(cands))) or 'none'))
with open(os.path.join(D, 'unattributed_hints.tsv'), 'w', encoding='utf-8') as f:
    f.write('path\tcandidate_hint (NOT ownership evidence)\n')
    for p, h in res:
        f.write(f'{p}\t{h}\n')
c = collections.Counter(h for _, h in res)
print(len(res), 'unattributed scanned;', sum(1 for _, h in res if h != 'none'), 'have a time-correlated candidate')
for k, v in c.most_common(8):
    print(v, k)
