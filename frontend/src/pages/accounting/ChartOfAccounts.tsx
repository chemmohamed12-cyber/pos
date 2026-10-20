import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { loadingLabel } from '../../lib/displayNames';

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
const CURRENCY_MODES = ['functional_only', 'single_foreign', 'any'] as const;
const CONTROL_FUNCTIONS = ['ar', 'ap', 'bank', 'inventory', 'tax_payable', 'tax_receivable', 'retained_earnings', 'fx_gain_loss', 'rounding', 'fixed_asset'] as const;
const DIMENSION_RULE_MODES = ['required', 'optional', 'blocked'] as const;

interface GLAccount {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  accountType: (typeof ACCOUNT_TYPES)[number];
  normalBalance: 'debit' | 'credit';
  isContra: boolean;
  parentAccountId: string | null;
  isPostable: boolean;
  controlFunction: (typeof CONTROL_FUNCTIONS)[number] | null;
  currencyMode: (typeof CURRENCY_MODES)[number];
  restrictCurrencyCode: string | null;
  allowManualJournal: boolean;
  isActive: boolean;
  description: string | null;
}
interface GLAccountTreeNode extends GLAccount {
  children: GLAccountTreeNode[];
}
interface DimensionType {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}
interface DimensionRule {
  dimensionTypeId: string;
  mode: (typeof DIMENSION_RULE_MODES)[number];
  defaultValueId: string | null;
}
interface Template {
  key: string;
  name: string;
}

const PRELOAD = [
  'nav_group.accounting',
  'nav.chart_of_accounts',
  'field.account_code',
  'field.account_name',
  'field.account_name_ar',
  'field.description',
  'field.account_type',
  'field.normal_balance',
  'field.parent_account',
  'field.is_postable',
  'field.is_contra',
  'field.control_function',
  'field.currency_mode',
  'field.restrict_currency',
  'field.allow_manual_journal',
  'field.dimension_rule_mode',
  'field.default_dimension_value',
  'field.status',
  'field.actions',
  ...ACCOUNT_TYPES.map((v) => `value.account_type.${v}`),
  'value.normal_balance.debit',
  'value.normal_balance.credit',
  ...CURRENCY_MODES.map((v) => `value.currency_mode.${v}`),
  ...CONTROL_FUNCTIONS.map((v) => `value.control_function.${v}`),
  ...DIMENSION_RULE_MODES.map((v) => `value.dimension_rule_mode.${v}`),
  'label.header_account',
  'action.add_account',
  'action.add_child_account',
  'action.reparent_account',
  'action.assign_control_function',
  'action.import_starter_chart',
  'action.deactivate_account',
  'action.activate_account',
  'action.save',
  'action.cancel',
  'action.edit',
  'panel.no_accounts_yet',
  'panel.chart_is_empty_import_hint',
  'panel.account_dimension_rules',
];

function buildTree(flat: GLAccount[]): GLAccountTreeNode[] {
  const byId = new Map<string, GLAccountTreeNode>(flat.map((a) => [a.id, { ...a, children: [] }]));
  const roots: GLAccountTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentAccountId && byId.has(node.parentAccountId)) byId.get(node.parentAccountId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function emptyCreateForm(parentAccountId: string | null) {
  return {
    code: '',
    name: '',
    nameAr: '',
    accountType: 'asset' as (typeof ACCOUNT_TYPES)[number],
    isContra: false,
    parentAccountId,
    isPostable: true,
  };
}

/**
 * COA-01 — edit an existing account's descriptive fields (name, Arabic name, description). Code and type stay immutable by design;
 * contra / currency changes are intentionally NOT offered here (they alter normal-balance semantics and need an accounting decision
 * once the account has history). Remounted per account via `key`.
 */
function AccountDetailsEditor({ account, busy, onSave }: { account: GLAccount; busy: boolean; onSave: (patch: { name: string; nameAr: string | null; description: string | null }) => Promise<void> }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(account.name);
  const [nameAr, setNameAr] = useState(account.nameAr ?? '');
  const [description, setDescription] = useState(account.description ?? '');
  if (!open) {
    return (
      <div className="form-field">
        <button className="btn btn-secondary" onClick={() => setOpen(true)}>
          {t('action.edit')}
        </button>
      </div>
    );
  }
  return (
    <form
      className="form-field"
      onSubmit={async (e) => {
        e.preventDefault();
        await onSave({ name, nameAr: nameAr.trim() || null, description: description.trim() || null });
        setOpen(false);
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <label>{t('field.account_name')}</label>
      <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} />
      <label>{t('field.account_name_ar')}</label>
      <input value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={160} />
      <label>{t('field.description')}</label>
      <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={512} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {t('action.save')}
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
          {t('action.cancel')}
        </button>
      </div>
    </form>
  );
}

/** F02 — Chart of Accounts (ADR-034). Recovered/integrated frontend source — a recursive tree with a detail/edit panel for the selected node. */
export function ChartOfAccounts() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [accounts, setAccounts] = useState<GLAccount[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [dimensionTypes, setDimensionTypes] = useState<DimensionType[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rules, setRules] = useState<DimensionRule[] | null>(null);
  const [createForm, setCreateForm] = useState(emptyCreateForm(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function loadAccounts() {
    try {
      setAccounts(await api.get<GLAccount[]>('/accounting/accounts?includeInactive=true'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load chart of accounts.');
    }
  }

  useEffect(() => {
    loadAccounts();
    api.get<Template[]>('/accounting/chart/templates').then(setTemplates).catch(() => setTemplates([]));
    api.get<DimensionType[]>('/accounting/dimension-types').then(setDimensionTypes).catch(() => setDimensionTypes([]));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setRules(null);
      return;
    }
    api
      .get<DimensionRule[]>(`/accounting/accounts/${selectedId}/dimension-rules`)
      .then(setRules)
      .catch(() => setRules([]));
  }, [selectedId]);

  const tree = accounts ? buildTree(accounts) : [];
  const selected = accounts?.find((a) => a.id === selectedId) ?? null;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/accounts', {
        ...createForm,
        nameAr: createForm.nameAr || undefined,
        parentAccountId: createForm.parentAccountId || undefined,
      });
      setShowCreate(false);
      setCreateForm(emptyCreateForm(null));
      await loadAccounts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create account.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(a: GLAccount) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/accounts/${a.id}`, { isActive: !a.isActive });
      await loadAccounts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update account.');
    } finally {
      setBusy(false);
    }
  }

  async function saveDetails(a: GLAccount, patch: { name: string; nameAr: string | null; description: string | null }) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/accounts/${a.id}`, patch);
      await loadAccounts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update account.');
    } finally {
      setBusy(false);
    }
  }

  async function assignControlFunction(a: GLAccount, cf: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/accounts/${a.id}/control-function`, { controlFunction: cf || null });
      await loadAccounts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign control function.');
    } finally {
      setBusy(false);
    }
  }

  async function reparent(a: GLAccount, newParentId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/accounts/${a.id}/reparent`, { newParentId: newParentId || null });
      await loadAccounts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to move account.');
    } finally {
      setBusy(false);
    }
  }

  async function importTemplate(templateKey: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/chart/import-template', { templateKey, dryRun: false });
      await loadAccounts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to import starter chart.');
    } finally {
      setBusy(false);
    }
  }

  async function saveRules() {
    if (!selected || !rules) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/accounts/${selected.id}/dimension-rules`, { rules });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save dimension rules.');
    } finally {
      setBusy(false);
    }
  }

  function TreeNode({ node, depth }: { node: GLAccountTreeNode; depth: number }) {
    return (
      <>
        <div
          className={`tree-row${selectedId === node.id ? ' active' : ''}`}
          style={{
            paddingInlineStart: depth * 20,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: '6px 8px',
            cursor: 'pointer',
            background: selectedId === node.id ? 'rgba(59,130,246,0.1)' : undefined,
            opacity: node.isActive ? 1 : 0.5,
          }}
          onClick={() => setSelectedId(node.id)}
        >
          <span style={{ fontFamily: 'monospace' }}>{node.code}</span>
          <span>{node.nameAr ?? node.name}</span>
          {!node.isPostable && <span className="status-badge">{t('label.header_account')}</span>}
          {node.controlFunction && <span className="status-badge">{t(`value.control_function.${node.controlFunction}`)}</span>}
          {!node.isActive && <span className="status-badge negative">{t('field.status')}</span>}
        </div>
        {node.children.map((c) => (
          <TreeNode key={c.id} node={c} depth={depth + 1} />
        ))}
      </>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.chart_of_accounts')}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => { setCreateForm(emptyCreateForm(null)); setShowCreate(true); }}>
            {t('action.add_account')}
          </button>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      {templates.length > 0 && accounts?.length === 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <p>{t('panel.chart_is_empty_import_hint')}</p>
          {templates.map((tpl) => (
            <button key={tpl.key} className="btn btn-secondary" disabled={busy} onClick={() => importTemplate(tpl.key)} style={{ marginInlineEnd: 8 }}>
              {t('action.import_starter_chart')} — {tpl.name}
            </button>
          ))}
        </div>
      )}

      {showCreate && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.account_code')}</label>
              <input value={createForm.code} onChange={(e) => setCreateForm({ ...createForm, code: e.target.value })} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.account_name')}</label>
              <input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.account_name_ar')}</label>
              <input value={createForm.nameAr} onChange={(e) => setCreateForm({ ...createForm, nameAr: e.target.value })} />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.account_type')}</label>
              <select value={createForm.accountType} onChange={(e) => setCreateForm({ ...createForm, accountType: e.target.value as never })}>
                {ACCOUNT_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {t(`value.account_type.${v}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
              <label>{t('field.parent_account')}</label>
              <select value={createForm.parentAccountId ?? ''} onChange={(e) => setCreateForm({ ...createForm, parentAccountId: e.target.value || null })}>
                <option value="">—</option>
                {(accounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.nameAr ?? a.name}
                  </option>
                ))}
              </select>
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={createForm.isPostable} onChange={(e) => setCreateForm({ ...createForm, isPostable: e.target.checked })} />
              {t('field.is_postable')}
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={createForm.isContra} onChange={(e) => setCreateForm({ ...createForm, isContra: e.target.checked })} />
              {t('field.is_contra')}
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('action.save')}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setShowCreate(false)}>
              {t('action.cancel')}
            </button>
          </form>
        </div>
      )}

      <div style={{ display: 'flex', gap: 20 }}>
        <div className="card" style={{ flex: '1 1 55%', maxHeight: 640, overflowY: 'auto' }}>
          {accounts === null ? (
            <div className="empty-state">{loadingLabel()}</div>
          ) : tree.length === 0 ? (
            <div className="empty-state">{t('panel.no_accounts_yet')}</div>
          ) : (
            tree.map((n) => <TreeNode key={n.id} node={n} depth={0} />)
          )}
        </div>

        {selected && (
          <div className="card" style={{ flex: '1 1 45%' }}>
            <h3 style={{ marginTop: 0 }}>
              {selected.code} — {selected.nameAr ?? selected.name}
            </h3>

            <AccountDetailsEditor key={selected.id + (selected.name ?? '') + (selected.nameAr ?? '') + (selected.description ?? '')} account={selected} busy={busy} onSave={(patch) => saveDetails(selected, patch)} />

            <div className="form-field">
              <label>{t('action.add_child_account')}</label>
              <button className="btn btn-secondary" onClick={() => { setCreateForm(emptyCreateForm(selected.id)); setShowCreate(true); }}>
                {t('action.add_child_account')}
              </button>
            </div>

            <div className="form-field">
              <label>{t('action.reparent_account')}</label>
              <select
                value={selected.parentAccountId ?? ''}
                onChange={(e) => reparent(selected, e.target.value)}
                disabled={busy}
              >
                <option value="">—</option>
                {(accounts ?? [])
                  .filter((a) => a.id !== selected.id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.nameAr ?? a.name}
                    </option>
                  ))}
              </select>
            </div>

            <div className="form-field">
              <label>{t('field.control_function')}</label>
              <select value={selected.controlFunction ?? ''} onChange={(e) => assignControlFunction(selected, e.target.value)} disabled={busy}>
                <option value="">—</option>
                {CONTROL_FUNCTIONS.map((cf) => (
                  <option key={cf} value={cf}>
                    {t(`value.control_function.${cf}`)}
                  </option>
                ))}
              </select>
            </div>

            <button className="btn btn-secondary" disabled={busy} onClick={() => toggleActive(selected)}>
              {t(selected.isActive ? 'action.deactivate_account' : 'action.activate_account')}
            </button>

            {dimensionTypes.length > 0 && rules && (
              <div style={{ marginTop: 20 }}>
                <h4>{t('panel.account_dimension_rules')}</h4>
                {dimensionTypes.map((dt) => {
                  const rule = rules.find((r) => r.dimensionTypeId === dt.id) ?? { dimensionTypeId: dt.id, mode: 'optional' as const, defaultValueId: null };
                  return (
                    <div key={dt.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ minWidth: 140 }}>{dt.name}</span>
                      <select
                        value={rule.mode}
                        onChange={(e) => {
                          const next = rules.filter((r) => r.dimensionTypeId !== dt.id);
                          setRules([...next, { ...rule, mode: e.target.value as never }]);
                        }}
                      >
                        {DIMENSION_RULE_MODES.map((m) => (
                          <option key={m} value={m}>
                            {t(`value.dimension_rule_mode.${m}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
                <button className="btn btn-primary" disabled={busy} onClick={saveRules}>
                  {t('action.save')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
