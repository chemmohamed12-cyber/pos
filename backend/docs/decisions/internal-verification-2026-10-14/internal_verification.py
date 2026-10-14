#!/usr/bin/env python3
"""INTERNAL VERIFICATION (not an independent review) — read-only, reproducible checks written as a checklist, separate from the code that is checked.

Usage:  python internal_verification.py <repo-root> <commit> > result.json
Every check reads git objects of <commit> (no working tree), prints PASS/FAIL with the observed values, and never modifies anything.
The checks restate acceptance requirements from the closure documents; a PASS here is an automated consistency check by the implementation team and is
NEVER recorded as an independent acceptance.
"""
import hashlib, json, re, subprocess, sys

REPO, COMMIT = sys.argv[1], sys.argv[2]
COMMIT_HAS_C15 = subprocess.run(['git', '-C', REPO, 'merge-base', '--is-ancestor', '9a693fc', COMMIT], capture_output=True).returncode == 0
COMMIT_HAS_C14 = subprocess.run(['git', '-C', REPO, 'merge-base', '--is-ancestor', '354d0f7', COMMIT], capture_output=True).returncode == 0
BASE = 'e5b8e2a'  # HEAD at the start of the 2026-10-13 closing directive (before d3ad24b / 8ec6de4)
PROGRAM_CODE_COMMITS = {'4dc3862': 'teardown retry (test harness)', 'd3ad24b': 'wages_payable template + spec', '8ec6de4': 'T1 lockfile', 'd68fd10': 'T-30 sibling probes (test only)', '354d0f7': 'C14 remediation (inventory.service.ts + T-30)', '9a693fc': 'C15 remediation (payments.service.ts + T-31)'}


def git(*a, raw=False):
    r = subprocess.run(['git', '-C', REPO, *a], capture_output=True)
    if r.returncode != 0 and not raw:
        return ''
    return r.stdout if raw else r.stdout.decode('utf-8', 'replace')


def files_at(rev):
    return [x for x in git('ls-tree', '-r', '--name-only', rev).split('\n') if x]


def show(rev, path):
    return git('show', f'{rev}:{path}')


results = []


def check(cid, requirement, ok, observed):
    results.append({'id': cid, 'requirement': requirement, 'result': 'PASS' if ok else 'FAIL', 'observed': observed})


def strip_comments(src):
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return '\n'.join(re.sub(r'(^|\s)//.*$', '', l) for l in src.split('\n'))


files = files_at(COMMIT)
src_files = [f for f in files if f.startswith('backend/src/') and f.endswith('.ts') and not f.endswith('.spec.ts') and '/testing/' not in f]

# IV-01 audit writer fails closed: no setval anywhere in production source or migrations; the writer takes sequence values with nextval only
setval_hits = [f for f in src_files if re.search(r'\bsetval\s*\(', strip_comments(show(COMMIT, f)), re.I)]
mig = [f for f in files if f.startswith('backend/src/') and 'migration' in f.lower() and f.endswith('.ts') and not f.endswith('.spec.ts')]
mig_setval = [f for f in mig if re.search(r'\bsetval\s*\(', strip_comments(show(COMMIT, f)), re.I)]
audit = strip_comments(show(COMMIT, 'backend/src/foundation/audit/audit.service.ts'))
check('IV-01a', 'No production source calls setval (audit sequences are never realigned by code)', not setval_hits, {'files_with_setval': setval_hits})
check('IV-01b', 'No migration calls setval on an audit sequence', not [f for f in mig_setval if 'audit' in show(COMMIT, f).lower()], {'migration_files_with_setval': mig_setval})
check('IV-01c', 'The audit writer uses nextval and a refusal path for sequence lag', 'nextval' in audit.lower() and 'AUDIT_SEQUENCE_LAG' in show(COMMIT, 'backend/src/foundation/audit/audit.service.ts'), {'nextval': 'nextval' in audit.lower(), 'AUDIT_SEQUENCE_LAG_present': 'AUDIT_SEQUENCE_LAG' in show(COMMIT, 'backend/src/foundation/audit/audit.service.ts')})

# IV-02 no code path rewrites or deletes audit history
mut = []
for f in src_files:
    t = strip_comments(show(COMMIT, f))
    if re.search(r'(UPDATE|DELETE\s+FROM)\s+"?audit_records"?', t, re.I):
        mut.append(f)
check('IV-02', 'No production source UPDATEs or DELETEs audit_records', not mut, {'files': mut})

# IV-03 wages_payable template change is exactly one account and touches no payroll/commission/disbursement code
d = git('diff', '--name-only', 'd3ad24b^', 'd3ad24b').split('\n')
d = [x for x in d if x]
tmpl_diff = git('diff', '-U0', 'd3ad24b^', 'd3ad24b', '--', 'backend/src/domains/accounting/domain/account-templates/ifrs-sme.template.ts')
added = [l for l in tmpl_diff.split('\n') if l.startswith('+') and not l.startswith('+++')]
removed = [l for l in tmpl_diff.split('\n') if l.startswith('-') and not l.startswith('---')]
payroll_touched = [x for x in d if re.search(r'payroll|commission|disbursement|handler', x, re.I) and 'spec' not in x and 'characterization' not in x and 'docs/' not in x]
check('IV-03a', 'd3ad24b adds exactly one template account line (2150 wages_payable) and removes none', len(added) == 1 and not removed and "'2150'" in added[0] and 'wages_payable' in added[0], {'added': added, 'removed': removed})
check('IV-03b', 'd3ad24b touches no payroll/commission/disbursement/handler production code', not payroll_touched, {'files_changed': d, 'suspect': payroll_touched})
check('IV-03c', 'The template supplies exactly one wages_payable account', show(COMMIT, 'backend/src/domains/accounting/domain/account-templates/ifrs-sme.template.ts').count("controlFunction: 'wages_payable'") == 1, {})

# IV-04 T1 lockfile: whole-file properties (not only the touched entries)
lock = json.loads(show(COMMIT, 'backend/package-lock.json'))
pk = lock.get('packages', {})
bad_host, no_integrity, non_sha512 = [], [], []
for k, v in pk.items():
    if not k:
        continue
    res = v.get('resolved')
    if res is None:
        if not v.get('link'):
            no_integrity.append(k)
        continue
    if not res.startswith('https://registry.npmjs.org/'):
        bad_host.append((k, res))
    i = v.get('integrity')
    if not i:
        no_integrity.append(k)
    elif not i.startswith('sha512-'):
        non_sha512.append(k)
check('IV-04a', 'Every locked package resolves from https://registry.npmjs.org/', not bad_host, {'packages': len(pk), 'non_registry': bad_host[:5]})
check('IV-04b', 'Every locked package carries an integrity hash (sha512)', not no_integrity and not non_sha512, {'missing': no_integrity[:5], 'non_sha512': non_sha512[:5]})
pj_a, pj_b = show(COMMIT, 'backend/package.json'), show('8ec6de4^', 'backend/package.json')
check('IV-04c', 'package.json is byte-identical to its state before T1', pj_a == pj_b, {'sha256_now': hashlib.sha256(pj_a.encode()).hexdigest()[:16], 'sha256_before': hashlib.sha256(pj_b.encode()).hexdigest()[:16]})
before = json.loads(show('8ec6de4^', 'backend/package-lock.json'))['packages']
added_pk = [k for k in pk if k not in before]
check('IV-04d', 'The 8 packages added by T1 are MIT-licensed', len(added_pk) == 8 and all((pk[k].get('license') or '') == 'MIT' for k in added_pk), {'added': [(k, pk[k].get('version'), pk[k].get('license')) for k in added_pk]})
check('IV-04e', 'The lock root declares the same dependency set as package.json', lock['packages'][''].get('dependencies') == json.loads(pj_a).get('dependencies') and lock['packages'][''].get('devDependencies') == json.loads(pj_a).get('devDependencies'), {})

# IV-05 scope guard: program code commits touch only tests, tools, template data, lockfile
prod_touched = {}
for c, what in PROGRAM_CODE_COMMITS.items():
    ch = [x for x in git('diff', '--name-only', f'{c}^', c).split('\n') if x]
    p = [x for x in ch if x.startswith('backend/src/') and not x.endswith('.spec.ts') and '/testing/' not in x]
    prod_touched[c] = {'scope': what, 'production_paths_touched': p}
allowed = {  # production paths each program commit is authorised to touch (CTO authorisations of 2026-10-13 and 2026-10-14)
    'd3ad24b': {'backend/src/domains/accounting/domain/account-templates/ifrs-sme.template.ts'},
    '354d0f7': {'backend/src/domains/inventory-warehouse/application/inventory.service.ts'},
    '9a693fc': {'backend/src/domains/customer-finance/application/payments.service.ts'},
}
unexpected = {c: [x for x in v['production_paths_touched'] if x not in allowed.get(c, set())] for c, v in prod_touched.items()}
check('IV-05', 'Program code commits change no production source other than the authorised template data row', not any(unexpected.values()), prod_touched)

# IV-06 protected baseline: DB guard, approved-instance list and authorization guards not modified by the program commits
protected_re = re.compile(r'^backend/tools/testing/(jest-)?db-guard[^/]*$')  # the DB guard, its approved-instance registration and its jest hooks (tests of the guard excluded below)
changed_protected = {}
for c in PROGRAM_CODE_COMMITS:
    ch = set(git('diff', '--name-only', f'{c}^', c).split('\n'))
    hit = [x for x in ch if protected_re.match(x) and '.test.' not in x]
    guards = [x for x in ch if re.search(r'(^|/)[^/]*guard[^/]*\.ts$', x) and not x.endswith('.spec.ts')]
    if hit or guards:
        changed_protected[c] = hit + guards
check('IV-06', 'No program code commit modifies the DB guard or any guard class', not changed_protected, {'changed': changed_protected})

# IV-07 test integrity: no spec file removed since the baseline; no new skip/only markers in the program test diffs
removed_specs = [x for x in git('diff', '--name-status', '--diff-filter=D', BASE, COMMIT).split('\n') if x and x.split('\t')[-1].endswith('.spec.ts')]
new_skips = []
for c in PROGRAM_CODE_COMMITS:
    dd = git('diff', '-U0', f'{c}^', c, '--', '*.spec.ts')
    for l in dd.split('\n'):
        if l.startswith('+') and not l.startswith('+++') and re.search(r'\b(it|describe|test)\.(skip|only)\b|\bxit\b|\bxdescribe\b', l):
            new_skips.append((c, l[:120]))
check('IV-07a', 'No spec file was deleted since the baseline', not removed_specs, {'removed': removed_specs})
check('IV-07b', 'No program commit adds a skip/only marker to a spec', not new_skips, {'added_markers': new_skips})

# IV-08 the regression list only grew
old = set(l.strip() for l in show(BASE, 'backend/tools/testing/regression-specs-all.txt').split('\n') if l.strip() and not l.startswith('#'))
new = set(l.strip() for l in show(COMMIT, 'backend/tools/testing/regression-specs-all.txt').split('\n') if l.strip() and not l.startswith('#'))
check('IV-08', 'The isolation regression list only grew (no entry removed)', old <= new, {'before': len(old), 'after': len(new), 'removed': sorted(old - new), 'added': sorted(new - old)})

# IV-09 business-suite order: existing steps keep their relative order; the only addition is T-30 (placed right after T-29)
def biz_steps(rev):
    return re.findall(r"\['(T-\d\d(?:\+T-\d\d)?|F-[A-Z]+-\d+)', '", show(rev, 'backend/tools/testing/biz-run.js'))
now, base_steps = biz_steps(COMMIT), biz_steps(BASE)
check('IV-09', 'biz-run.js keeps the order of every existing step; T-30 (and, from the C15 work, T-31) are the only additions and follow T-29 in order',
      [x for x in now if x not in ('T-30', 'T-31')] == base_steps and 'T-30' in now and now.index('T-30') == now.index('T-29') + 1 and ('T-31' not in now or now.index('T-31') == now.index('T-30') + 1),
      {'base_steps': len(base_steps), 'now_steps': len(now), 'added': [x for x in now if x in ('T-30', 'T-31')]})

# IV-10 the C14 correction changes only the three named methods in inventory.service.ts
inv = 'backend/src/domains/inventory-warehouse/application/inventory.service.ts'
if COMMIT_HAS_C14:
    dd = git('diff', '-U0', '354d0f7^', '354d0f7', '--', inv)
    hunks = [l for l in dd.split('\n') if l.startswith('@@')]
    ctx = ' '.join(re.findall(r'@@ [^@]*@@ (.*)', dd))
    touched_methods = sorted(set(re.findall(r'(relocateReservedStock|releaseReservedQuantityForReference|releaseReservation)', dd)))
    other_methods = [m for m in re.findall(r'^[+-]\s+async (\w+)\(', dd, re.M) if m not in ('releaseReservation',)]
    check('IV-10a', 'The C14 diff to inventory.service.ts has only the three expected hunks', len(hunks) == 3, {'hunks': hunks})
    new_lines = show('354d0f7', inv).split('\n')
    enclosing = set()
    for h in hunks:
        m = re.match(r'@@ -\d+(?:,\d+)? \+(\d+)', h)
        start = int(m.group(1)) if m else 0
        for k in range(min(start, len(new_lines)) - 1, -1, -1):  # nearest preceding method declaration in the NEW file
            mm = re.match(r'\s+(?:async\s+)?(\w+)\(', new_lines[k]) if re.match(r'\s+async\s+\w+\(', new_lines[k]) else None
            if mm:
                enclosing.add(mm.group(1))
                break
    sig_changed = [l for l in dd.split('\n') if re.match(r'^[+-]\s+async \w+\(', l)]
    check('IV-10b', 'Each C14 hunk lies inside one of the three named methods and no method signature changed',
          enclosing == {'relocateReservedStock', 'releaseReservedQuantityForReference', 'releaseReservation'} and not sig_changed, {'enclosing_methods_of_hunks': sorted(enclosing), 'signature_lines_changed': sig_changed})
    t30_old, t30_new = show('d68fd10', 'backend/src/foundation/testing/t30-n02-sibling-probes.biz.real-pg.spec.ts'), show('354d0f7', 'backend/src/foundation/testing/t30-n02-sibling-probes.biz.real-pg.spec.ts')
    ids_old = set(re.findall(r"result\(e, `?'?([A-Za-z0-9-]+)", t30_old)); ids_new = set(re.findall(r"result\(e, `?'?([A-Za-z0-9-]+)", t30_new))
    check('IV-10c', 'T-30 keeps every original case id and expectation count; the correction only adds cases', ids_old <= ids_new and t30_new.count("'PASS' : 'FAIL-DEFECT'") >= t30_old.count("'PASS' : 'FAIL-DEFECT'"), {'ids_before': len(ids_old), 'ids_after': len(ids_new)})

# IV-11 the C15 correction changes only recordPayment / recordOnAccountPayment in payments.service.ts, replacing exactly the two plain-manager transaction lines
if COMMIT_HAS_C15:
    pay = 'backend/src/domains/customer-finance/application/payments.service.ts'
    dd = git('diff', '-U0', '9a693fc^', '9a693fc', '--', pay)
    hunks = [l for l in dd.split('\n') if l.startswith('@@')]
    removed = [l for l in dd.split('\n') if l.startswith('-') and not l.startswith('---')]
    added_code = [l for l in dd.split('\n') if l.startswith('+') and not l.startswith('+++') and not l.strip().lstrip('+').strip().startswith('//')]
    check('IV-11a', 'The C15 diff to payments.service.ts has exactly two hunks and removes exactly the two lines `manager ? await run(manager) : await this.dataSource.transaction(run)`',
          len(hunks) == 2 and len(removed) == 2 and all('manager ? await run(manager) : await this.dataSource.transaction(run)' in l for l in removed), {'hunks': hunks, 'removed': [l.strip() for l in removed]})
    check('IV-11b', 'The only non-comment lines added are `const saved = await runInTransaction(this.dataSource, manager, run);` (twice)',
          len(added_code) == 2 and all('const saved = await runInTransaction(this.dataSource, manager, run);' in l for l in added_code), {'added_code_lines': [l.strip() for l in added_code]})
    t_old, t_new = show('d4bda3b', 'backend/src/foundation/testing/t31-latent-idiom-probes.biz.real-pg.spec.ts'), show('9a693fc', 'backend/src/foundation/testing/t31-latent-idiom-probes.biz.real-pg.spec.ts')
    ids_o = set(re.findall(r"result\(e, [`'](P\d[A-Za-z0-9-]*)", t_old)); ids_n = set(re.findall(r"result\(e, [`'](P\d[A-Za-z0-9-]*)", t_new))
    check('IV-11c', 'T-31 keeps every earlier case id and only adds cases (P4, P5)', ids_o <= ids_n and len(ids_n) > len(ids_o), {'before': sorted(ids_o), 'after_new': sorted(ids_n - ids_o)})

summary = {'commit': COMMIT, 'baseline': BASE, 'checks': len(results), 'pass': sum(r['result'] == 'PASS' for r in results), 'fail': sum(r['result'] == 'FAIL' for r in results),
           'label': 'INTERNAL VERIFICATION (implementation-team automated checks) — NOT an independent review'}
print(json.dumps({'summary': summary, 'results': results}, indent=1))
