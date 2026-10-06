import json, os, re, sys, glob, collections
sys.stdout.reconfigure(encoding='utf-8')
PROJ = r'C:\Users\chem_\.claude\projects\D--CLAUDE-CODE-XNEXUS-WORKSPACE-1-hosting-daii-xnexustech-com-release-new'
REPO = r'D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\release-new'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'attribution_events.json')
WRITE_TOOLS = ('"name":"Write"', '"name":"Edit"', '"name":"MultiEdit"', '"name":"NotebookEdit"')


def norm(p):
    p = p.replace('/', '\\')
    if p.lower().startswith(REPO.lower()):
        rel = p[len(REPO):].lstrip('\\')
    else:
        rel = None
    return rel.replace('\\', '/') if rel else None


events = collections.defaultdict(dict)  # file -> {event_id: {'ts':..., 'tool':..., 'sessions': set()}}
sessions = {}
for path in sorted(glob.glob(os.path.join(PROJ, '*.jsonl'))):
    sid = os.path.basename(path)[:-6]
    first_user = None
    n_lines = 0
    wrote_matrix = False
    with open(path, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            n_lines += 1
            if first_user is None and '"type":"user"' in line[:200]:
                try:
                    d = json.loads(line)
                    c = d.get('message', {}).get('content')
                    if isinstance(c, str):
                        first_user = c[:160].replace('\n', ' ')
                    elif isinstance(c, list):
                        for b in c:
                            if isinstance(b, dict) and b.get('type') == 'text':
                                first_user = b['text'][:160].replace('\n', ' ')
                                break
                except Exception:
                    pass
            if '"type":"tool_use"' not in line or not any(t in line for t in WRITE_TOOLS):
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            ts = d.get('timestamp')
            content = d.get('message', {}).get('content')
            if not isinstance(content, list):
                continue
            for b in content:
                if not (isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('name') in ('Write', 'Edit', 'MultiEdit', 'NotebookEdit')):
                    continue
                fp = (b.get('input') or {}).get('file_path') or (b.get('input') or {}).get('notebook_path')
                if not fp:
                    continue
                rel = norm(fp)
                if not rel:
                    continue
                ev = events[rel].setdefault(b.get('id') or f'noid-{sid}-{ts}', {'ts': ts, 'tool': b['name'], 'sessions': set()})
                ev['sessions'].add(sid)
                if rel.endswith('AREA21-RETROFIT-MATRIX.md'):
                    wrote_matrix = True
    sessions[sid] = {'first_user': first_user, 'lines': n_lines, 'wrote_area21_matrix': wrote_matrix, 'size_mb': round(os.path.getsize(path) / 1e6, 1)}
    print('parsed', sid, sessions[sid], flush=True)

out = {'sessions': sessions, 'events': {f: {i: {'ts': v['ts'], 'tool': v['tool'], 'sessions': sorted(v['sessions'])} for i, v in d.items()} for f, d in events.items()}}
json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False)
print('files with Write/Edit evidence:', len(events))
