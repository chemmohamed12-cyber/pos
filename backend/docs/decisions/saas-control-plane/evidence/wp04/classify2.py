import json, os, re, sys, csv, collections, datetime
sys.stdout.reconfigure(encoding='utf-8')
D = os.path.dirname(os.path.abspath(__file__))
REPO = r'D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\release-new'
ME = '84e7fca6-9da1-46cc-b1ed-3e8f7620e909'
FRONT = '0f4192f6-7b2e-4bf7-9e05-d2187845edf0'
TITLES = {FRONT: 'Multi-Company front', '43695077-c526-4930-aeb5-2fb2bb195a73': 'DAII HR (fork)', 'df001241-da5e-4d09-991c-bafc14f9a20c': 'DAII manfacturing',
          '9aa5343c-d8f7-46b4-9232-baedc278c0cc': 'DAII HR', ME: 'this lane (Multi-Company back21)'}
att = json.load(open(os.path.join(D, 'attribution_events.json'), encoding='utf-8'))
events = att['events']
rows = [l.rstrip('\n').split('\t') for l in open(os.path.join(D, 'tree_manifest_start.tsv'), encoding='utf-8')][1:]
HIST_CUTOFF = datetime.datetime(2026, 10, 4, 23, 59, 59)  # Area 21 retrofit window ended on 2026-10-04

matrix = open(os.path.join(REPO, 'backend', 'docs', 'decisions', 'AREA21-RETROFIT-MATRIX.md'), encoding='utf-8').read()
documented = set()
for m in re.finditer(r'Files? changed[^\n]*(?:\n(?!\s*\n)[^\n]*)*', matrix, re.I):
    documented.update(re.findall(r'[\w.\-]+\.(?:ts|tsx|md)', m.group(0)))

MY_TEST_ONLY = {
    'backend/src/foundation/company/company-suspension-access-path.characterization.spec.ts',
    'backend/src/foundation/database-provisioning/module-add-existing-company.characterization.spec.ts',
    'backend/src/foundation/database-provisioning/ui-created-company-admin.characterization.spec.ts',
    'backend/src/foundation/database-provisioning/provisioning-lifecycle.characterization.spec.ts',
    'backend/src/foundation/limit-engine/limits-scope.characterization.spec.ts',
    'backend/src/foundation/testing/saas-characterization.helpers.ts',
    'backend/src/foundation/testing/saas-provisioning-kit.ts',
}
SHARED = re.compile(r'(company-context\.guard|company-connection-manager|database-registry/|foundation/events/|event-bus|approval-engine/|approval\.controller|entitlement|require-module|require-feature|module-registry/|foundation/plans/|foundation/authentication/|company-entity-registry|-company-entities\.ts|\.scheduler\.ts|foundation/navigation/|limit-engine/|foundation/permission/|foundation/authorization/|foundation/company/|database-provisioning/|app\.module\.ts)', re.I)
COMPANY_CTRL = re.compile(r'domains/[a-z\-]+/interface/.*\.(controller|company-isolation\.spec)\.ts')


def lt(ts_utc):  # transcript timestamps are UTC; tree mtimes are local (+03)
    return datetime.datetime.strptime(ts_utc[:19], '%Y-%m-%dT%H:%M:%S') + datetime.timedelta(hours=3)


def owner(sess):
    s = set(sess)
    if ME in s and FRONT in s:
        return 'ANC'      # inherited program history (before the fork)
    if ME in s:
        return 'ME'
    if FRONT in s:
        return 'FRONT'
    return 'OTHER'


out = []
for path, gs, sha, nbytes, mtime in rows:
    evs = events.get(path, {})
    kinds = collections.defaultdict(list)
    for eid, e in evs.items():
        kinds[owner(e['sessions'])].append(e)
    has_mine = bool(kinds['ME'] or kinds['ANC'])
    foreign_sessions = set()
    for k in ('FRONT', 'OTHER'):
        for e in kinds[k]:
            foreign_sessions.update(TITLES.get(s, s[:8]) for s in e['sessions'])
    has_foreign = bool(kinds['FRONT'] or kinds['OTHER'])
    last = max((lt(e['ts']) for e in evs.values() if e['ts']), default=None)
    mt = datetime.datetime.strptime(mtime, '%Y-%m-%d %H:%M:%S') if mtime else None
    late = bool(last and mt and mt > last + datetime.timedelta(minutes=10))
    base = os.path.basename(path)
    if path.startswith('backend/docs/decisions/saas-control-plane/'):
        grp, status, why = 'A', 'OWNED / VERIFIED', 'Control Plane documentation: Write results in this lane transcript; read-back verified'
    elif path in MY_TEST_ONLY:
        grp, status, why = 'E', 'TEST-ONLY', 'untracked test-only artifact authored in this lane (Write evidence)'
    elif has_foreign and has_mine:
        grp, status, why = 'B', 'FOREIGN / NEEDS RE-PROOF', 'MIXED: this lineage AND foreign writes (' + ', '.join(sorted(foreign_sessions)) + ')' + (' + later unevidenced modification' if late else '')
    elif has_foreign:
        grp, status, why = 'B', 'FOREIGN / NEEDS RE-PROOF', 'foreign Write/Edit evidence only (' + ', '.join(sorted(foreign_sessions)) + ')' + (' + later unevidenced modification' if late else '')
    elif has_mine and not late:
        grp, status, why = 'C', 'HISTORICAL / ALREADY VERIFIED', 'Write/Edit evidence only from this lineage (' + ('pre-fork ancestry' if kinds['ANC'] and not kinds['ME'] else 'this lane') + '); closure per Area 21 matrix'
    elif has_mine and late:
        grp, status, why = 'D', 'UNATTRIBUTED', 'this lineage wrote it earlier, but mtime is later than its last evidenced write (modified by an unevidenced means)'
    elif base in documented and mt and mt <= HIST_CUTOFF:
        grp, status, why = 'C', 'HISTORICAL / ALREADY VERIFIED', 'documented as changed by the Area 21 retrofit (Matrix "Files changed"); mtime within the retrofit window; no transcript Write/Edit evidence (script-written)'
    else:
        grp, status, why = 'D', 'UNATTRIBUTED', 'no Write/Edit evidence in any transcript' + ('; documented in matrix but mtime after the retrofit window' if base in documented else '; not documented in the Area 21 matrix')
    shared = bool(SHARED.search(path)) or bool(COMPANY_CTRL.search(path))
    out.append(dict(path=path, git=gs, sha256=sha, bytes=nbytes, mtime=mtime, group=grp, status=status, evidence=why, area21_shared=shared))

fields = list(out[0].keys())
for name, pred in [('ownership_manifest.tsv', lambda r: True), ('foreign_change_manifest.tsv', lambda r: r['status'].startswith('FOREIGN')),
                   ('unattributed_change_manifest.tsv', lambda r: r['status'] == 'UNATTRIBUTED')]:
    with open(os.path.join(D, name), 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter='\t')
        w.writeheader(); w.writerows([r for r in out if pred(r)])
c = collections.Counter(r['status'] for r in out)
print(dict(c), 'total', len(out))
print('MIXED (this lineage + foreign):', sum(1 for r in out if r['evidence'].startswith('MIXED')))
print('late-unevidenced among foreign:', sum(1 for r in out if r['status'].startswith('FOREIGN') and 'later unevidenced' in r['evidence']))
print('area21/shared by status:', dict(collections.Counter(r['status'] for r in out if r['area21_shared'])))
