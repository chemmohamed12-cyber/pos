import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

/**
 * Shared profile layout (master-data gap matrix §5.2) — one info card used by BOTH the customer and the supplier profile, each over its own
 * API. It is purely presentational: the caller supplies the field list, the current values and an `onSave(patch)`. Only the keys the user
 * actually changed are sent (an empty string clears a field on the server), so a partial edit never overwrites anything else.
 */
export interface ProfileField {
  key: string;
  labelCode: string;
  kind?: 'text' | 'textarea' | 'select' | 'email' | 'url';
  /** For `select`: the stored value and the terminology code of its label. */
  options?: Array<{ value: string; labelCode: string }>;
  /** Spans the full row (notes, address). */
  wide?: boolean;
}

interface Props {
  titleCode: string;
  fields: ProfileField[];
  values: Record<string, string | null | undefined>;
  canEdit: boolean;
  onSave: (patch: Record<string, string>) => Promise<void>;
}

export function ProfileFieldsCard({ titleCode, fields, values, canEdit, onSave }: Props) {
  const { t, preload } = useLanguage();
  preload([
    titleCode,
    'action.edit',
    'action.save',
    'action.cancel',
    ...fields.map((f) => f.labelCode),
    ...fields.flatMap((f) => (f.options ?? []).map((o) => o.labelCode)),
  ]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setDraft(Object.fromEntries(fields.map((f) => [f.key, values[f.key] ?? ''])));
    setError(null);
    setEditing(true);
  }

  async function save() {
    const patch: Record<string, string> = {};
    for (const f of fields) {
      const next = draft[f.key] ?? '';
      if (next !== (values[f.key] ?? '')) patch[f.key] = next;
    }
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the profile.');
    } finally {
      setSaving(false);
    }
  }

  const display = (f: ProfileField): string => {
    const v = values[f.key];
    if (v === null || v === undefined || v === '') return '—';
    if (f.kind === 'select') {
      const o = f.options?.find((x) => x.value === v);
      return o ? t(o.labelCode) : v;
    }
    return v;
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{t(titleCode)}</h3>
        {canEdit && !editing && (
          <button className="btn btn-secondary" onClick={startEdit}>
            {t('action.edit')}
          </button>
        )}
        {editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={saving} onClick={save}>
              {saving ? '...' : t('action.save')}
            </button>
            <button className="btn btn-secondary" disabled={saving} onClick={() => setEditing(false)}>
              {t('action.cancel')}
            </button>
          </div>
        )}
      </div>
      {error && <div className="error-text">{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px 24px' }}>
        {fields.map((f) => (
          <div key={f.key} className="form-field" style={{ marginBottom: 0, gridColumn: f.wide ? '1 / -1' : undefined }}>
            <label>{t(f.labelCode)}</label>
            {!editing ? (
              <div style={{ whiteSpace: 'pre-wrap', minHeight: 24 }}>{display(f)}</div>
            ) : f.kind === 'textarea' ? (
              <textarea rows={3} value={draft[f.key] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
            ) : f.kind === 'select' ? (
              <select value={draft[f.key] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}>
                <option value="">—</option>
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.labelCode)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.kind === 'email' ? 'email' : 'text'}
                inputMode={f.kind === 'url' ? 'url' : undefined}
                value={draft[f.key] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
