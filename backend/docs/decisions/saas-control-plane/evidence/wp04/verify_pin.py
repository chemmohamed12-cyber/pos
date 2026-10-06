import csv, hashlib, json, os, sys
sys.stdout.reconfigure(encoding='utf-8')
SNAP = r'D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\_execution-baselines\EB-WP04-20261005-155534'
META = {'PIN.txt', 'BASELINE.json', 'SNAPSHOT-MANIFEST.tsv'}
info = json.load(open(os.path.join(SNAP, 'BASELINE.json'), encoding='utf-8'))
stored = [l.rstrip('\n').split('\t') for l in open(os.path.join(SNAP, 'SNAPSHOT-MANIFEST.tsv'), encoding='utf-8')][1:]


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


rows = []
for root, _, files in os.walk(SNAP):
    for f in files:
        if f in META:
            continue
        p = os.path.join(root, f)
        rows.append((os.path.relpath(p, SNAP).replace('\\', '/'), sha(p)))
rows.sort()
ver_hash = hashlib.sha256('\n'.join(f'{a}\t{b}' for a, b in rows).encode('utf-8')).hexdigest()
stored_t = [(a, b) for a, b in stored]
mism = [a for (a, b), (c, d) in zip(rows, stored_t) if (a, b) != (c, d)]
print('pin_hash         :', info['pin_hash'])
print('verification hash:', ver_hash)
print('files verified   :', len(rows), '| stored manifest rows:', len(stored_t), '| per-file mismatches:', len(mism) + abs(len(rows) - len(stored_t)))
print('PIN HASH = VERIFICATION HASH:', info['pin_hash'] == ver_hash)
