import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { loadingLabel } from '../../lib/displayNames';

/** NAV-02 — the mandatory Accounting Policy accounts (the Configuration Engine keys posting reads), shown grouped, validated against THIS Company's chart. */
interface AccountRef {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  accountType: string;
}
interface PolicyEntry {
  reason: string | null;
  code: string;
  status: 'ok' | 'invalid';
  problem: string | null;
  warning: string | null;
  account: AccountRef | null;
}
interface PolicyKey {
  key: string;
  group: string;
  kind: 'account' | 'reason_map';
  expectedTypes: string[];
  status: 'unset' | 'ok' | 'invalid';
  code: string | null;
  problem: string | null;
  warning: string | null;
  account: AccountRef | null;
  entries: PolicyEntry[];
}
interface GLAccount {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  accountType: string;
  isPostable: boolean;
  isActive: boolean;
  controlFunction: string | null;
}

const GROUPS = ['inventory', 'sales', 'procurement', 'cash', 'fixed_assets'] as const;
const shortName = (key: string) => key.replace(/^accounting\./, '');

export function AccountingPolicy() {
  const { t, preload } = useLanguage();
  const [items, setItems] = useState<PolicyKey[] | null>(null);
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mapDrafts, setMapDrafts] = useState<Record<string, Array<{ reason: string; code: string }>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});

  preload([
    'nav.accounting_policy',
    'panel.policy_intro',
    'panel.policy_scope_note',
    'panel.policy_unset_effect',
    'field.reason_code',
    'field.account',
    'action.save',
    'action.clear_setting',
    'action.add_reason',
    'action.remove',
    'value.policy_status.unset',
    'value.policy_status.ok',
    'value.policy_status.invalid',
    ...GROUPS.map((g) => `policy_group.${g}`),
    ...(items ?? []).flatMap((i) => [`policy.${shortName(i.key)}.label`, `policy.${shortName(i.key)}.help`]),
  ]);

  async function load() {
    try {
      const [policy, accs] = await Promise.all([api.get<PolicyKey[]>('/accounting/policy-config'), api.get<GLAccount[]>('/accounting/accounts')]);
      setItems(policy);
      setAccounts(accs);
      setDrafts(Object.fromEntries(policy.filter((p) => p.kind === 'account').map((p) => [p.key, p.code ?? ''])));
      setMapDrafts(Object.fromEntries(policy.filter((p) => p.kind === 'reason_map').map((p) => [p.key, p.entries.map((e) => ({ reason: e.reason ?? '', code: e.code }))])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the accounting policy.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  // only accounts posting could actually use: active, postable, no control function
  const usable = useMemo(() => accounts.filter((a) => a.isActive && a.isPostable && !a.controlFunction).sort((a, b) => a.code.localeCompare(b.code)), [accounts]);
  const label = (a: { code: string; name: string; nameAr: string | null; accountType: string }) => `${a.code} — ${a.nameAr ?? a.name} (${a.accountType})`;

  async function save(p: PolicyKey) {
    setBusy(p.key);
    setError(null);
    try {
      const value = p.kind === 'account' ? drafts[p.key] : Object.fromEntries((mapDrafts[p.key] ?? []).filter((r) => r.reason.trim() && r.code).map((r) => [r.reason.trim(), r.code]));
      const updated = await api.post<PolicyKey>(`/accounting/policy-config/${p.key}`, { value });
      setItems((prev) => (prev ?? []).map((x) => (x.key === p.key ? updated : x)));
      const warn = updated.kind === 'account' ? updated.warning : updated.entries.map((e) => e.warning).filter(Boolean).join(' ');
      setMessages((m) => ({ ...m, [p.key]: warn ?? '' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the setting.');
    } finally {
      setBusy(null);
    }
  }

  async function clear(p: PolicyKey) {
    setBusy(p.key);
    setError(null);
    try {
      const updated = await api.delete<PolicyKey>(`/accounting/policy-config/${p.key}`);
      setItems((prev) => (prev ?? []).map((x) => (x.key === p.key ? updated : x)));
      setDrafts((d) => ({ ...d, [p.key]: '' }));
      setMapDrafts((d) => ({ ...d, [p.key]: [] }));
      setMessages((m) => ({ ...m, [p.key]: '' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to clear the setting.');
    } finally {
      setBusy(null);
    }
  }

  const badge = (status: PolicyKey['status']) => (
    <span className={`status-badge${status === 'ok' ? '' : status === 'invalid' ? ' negative' : ''}`} style={status === 'unset' ? { opacity: 0.7 } : undefined}>
      {t(`value.policy_status.${status}`)}
    </span>
  );
  const select = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 300 }}>
      <option value="">—</option>
      {value && !usable.some((a) => a.code === value) && <option value={value}>{value}</option>}
      {usable.map((a) => (
        <option key={a.id} value={a.code}>
          {label(a)}
        </option>
      ))}
    </select>
  );

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.accounting_policy')}</h1>
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <p style={{ marginTop: 0 }}>{t('panel.policy_intro')}</p>
        <p style={{ marginBottom: 4, fontSize: 13, opacity: 0.8 }}>{t('panel.policy_unset_effect')}</p>
        <p style={{ marginBottom: 0, fontSize: 13, opacity: 0.8 }}>{t('panel.policy_scope_note')}</p>
      </div>
      {error && <div className="error-text">{error}</div>}
      {items === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : (
        GROUPS.map((g) => (
          <div key={g} className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ marginTop: 0 }}>{t(`policy_group.${g}`)}</h3>
            {items
              .filter((i) => i.group === g)
              .map((p) => (
                <div key={p.key} style={{ borderTop: '1px solid rgba(128,128,128,0.2)', padding: '12px 0' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{t(`policy.${shortName(p.key)}.label`)}</strong>
                    {badge(p.status)}
                    <code style={{ fontSize: 11, opacity: 0.6 }}>{p.key}</code>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.75, margin: '4px 0 8px' }}>{t(`policy.${shortName(p.key)}.help`)}</div>
                  {p.kind === 'account' ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {select(drafts[p.key] ?? '', (v) => setDrafts((d) => ({ ...d, [p.key]: v })))}
                      <button className="btn btn-primary" disabled={busy === p.key || !drafts[p.key]} onClick={() => save(p)}>
                        {t('action.save')}
                      </button>
                      {p.status !== 'unset' && (
                        <button className="btn btn-secondary" disabled={busy === p.key} onClick={() => clear(p)}>
                          {t('action.clear_setting')}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div>
                      {(mapDrafts[p.key] ?? []).map((row, idx) => (
                        <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                          <input
                            placeholder={t('field.reason_code')}
                            value={row.reason}
                            maxLength={40}
                            style={{ width: 170 }}
                            onChange={(e) => setMapDrafts((d) => ({ ...d, [p.key]: d[p.key].map((r, i) => (i === idx ? { ...r, reason: e.target.value } : r)) }))}
                          />
                          {select(row.code, (v) => setMapDrafts((d) => ({ ...d, [p.key]: d[p.key].map((r, i) => (i === idx ? { ...r, code: v } : r)) })))}
                          <button className="btn btn-secondary" onClick={() => setMapDrafts((d) => ({ ...d, [p.key]: d[p.key].filter((_, i) => i !== idx) }))}>
                            {t('action.remove')}
                          </button>
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-secondary" onClick={() => setMapDrafts((d) => ({ ...d, [p.key]: [...(d[p.key] ?? []), { reason: '', code: '' }] }))}>
                          {t('action.add_reason')}
                        </button>
                        <button className="btn btn-primary" disabled={busy === p.key || (mapDrafts[p.key] ?? []).length === 0} onClick={() => save(p)}>
                          {t('action.save')}
                        </button>
                        {p.status !== 'unset' && (
                          <button className="btn btn-secondary" disabled={busy === p.key} onClick={() => clear(p)}>
                            {t('action.clear_setting')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {p.problem && <div className="error-text" style={{ marginTop: 6 }}>{p.problem}</div>}
                  {p.entries.filter((e) => e.problem).map((e) => (
                    <div key={e.reason} className="error-text" style={{ marginTop: 6 }}>
                      {e.reason}: {e.problem}
                    </div>
                  ))}
                  {(messages[p.key] || p.warning) && <div style={{ marginTop: 6, fontSize: 12, color: '#b45309' }}>{messages[p.key] || p.warning}</div>}
                </div>
              ))}
          </div>
        ))
      )}
    </div>
  );
}
