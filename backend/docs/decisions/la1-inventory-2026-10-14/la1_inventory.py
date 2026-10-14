#!/usr/bin/env python3
"""LA-1 call-site inventory (read-only; works on git objects of one commit): every production-source place that can obtain a Company-database connection.
Three mechanisms, found by searching the whole of backend/src (no test or spec files):
  M1  CompanyConnectionManagerService API: `.getDataSource(` / `.listActiveCompanyIds(` / `.readRegistry(` / `.companyIdOf(`
  M2  direct construction: `new DataSource(` / `createCompanyDataSource(`
  M3  files that inject CompanyConnectionManagerService (to catch a consumer that uses none of the above call shapes)
Usage: python la1_inventory.py <repo-root> <commit> > inventory.json
"""
import json, re, subprocess, sys
REPO, COMMIT = sys.argv[1], sys.argv[2]
def git(*a):
    return subprocess.run(['git', '-C', REPO, *a], capture_output=True).stdout.decode('utf-8', 'replace')
files = [f for f in git('ls-tree', '-r', '--name-only', COMMIT, '--', 'backend/src').split('\n') if f.endswith('.ts') and not f.endswith('.spec.ts') and '/testing/' not in f and not f.endswith('.test-helper.ts')]
m1, m2, m3 = [], [], []
for f in files:
    src = git('show', f'{COMMIT}:{f}')
    for n, line in enumerate(src.split('\n'), 1):
        code = re.sub(r'//.*$', '', line)
        if re.search(r'\.(getDataSource|listActiveCompanyIds|readRegistry|companyIdOf)\(', code):
            m1.append(f'{f[len("backend/src/"):]}:{n}')
        if re.search(r'new DataSource\(|createCompanyDataSource\(', code):
            m2.append(f'{f[len("backend/src/"):]}:{n}')
    if 'CompanyConnectionManagerService' in src and not f.endswith('.module.ts'):
        m3.append(f[len('backend/src/'):])
def by_file(sites):
    d = {}
    for s in sites:
        d.setdefault(s.rsplit(':', 1)[0], []).append(s.rsplit(':', 1)[1])
    return d
out = {'commit': COMMIT, 'M1_connection_manager_calls': {'sites': len(m1), 'files': len(by_file(m1)), 'by_file': by_file(m1)},
       'M2_direct_construction': {'sites': len(m2), 'files': len(by_file(m2)), 'by_file': by_file(m2)},
       'M3_files_injecting_the_manager': {'files': len(m3), 'list': sorted(m3)}}
print(json.dumps(out, indent=1))
