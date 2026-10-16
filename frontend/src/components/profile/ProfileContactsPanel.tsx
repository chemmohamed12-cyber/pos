import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

/** Shared contact-persons panel (customer and supplier profiles). Presentational: the caller wires the three actions to its own API. */
export interface ProfileContact {
  id: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
}

interface Props {
  contacts: ProfileContact[];
  canEdit: boolean;
  onAdd: (input: { name: string; title?: string; phone?: string; email?: string; isPrimary?: boolean }) => Promise<void>;
  onSetPrimary: (id: string) => Promise<void>;
  /** Omit when the API has no removal (the panel then simply hides the button). */
  onRemove?: (id: string) => Promise<void>;
}

export function ProfileContactsPanel({ contacts, canEdit, onAdd, onSetPrimary, onRemove }: Props) {
  const { t, preload } = useLanguage();
  preload([
    'panel.contacts',
    'panel.no_contacts_yet',
    'field.name',
    'field.contact_title',
    'field.phone',
    'field.email',
    'field.is_primary',
    'field.actions',
    'action.add',
    'action.remove',
    'action.set_primary',
  ]);
  const [form, setForm] = useState({ name: '', title: '', phone: '', email: '', isPrimary: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The change could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await onAdd({ name: form.name, title: form.title, phone: form.phone, email: form.email, isPrimary: form.isPrimary });
      setForm({ name: '', title: '', phone: '', email: '', isPrimary: false });
    });
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>{t('panel.contacts')}</h3>
      {error && <div className="error-text">{error}</div>}
      {contacts.length === 0 ? (
        <div className="empty-state">{t('panel.no_contacts_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.name')}</th>
              <th>{t('field.contact_title')}</th>
              <th>{t('field.phone')}</th>
              <th>{t('field.email')}</th>
              <th>{t('field.is_primary')}</th>
              {canEdit && <th>{t('field.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.title ?? '—'}</td>
                <td>{c.phone ?? '—'}</td>
                <td>{c.email ?? '—'}</td>
                <td>{c.isPrimary ? '✓' : ''}</td>
                {canEdit && (
                  <td style={{ display: 'flex', gap: 6 }}>
                    {!c.isPrimary && (
                      <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => onSetPrimary(c.id))}>
                        {t('action.set_primary')}
                      </button>
                    )}
                    {onRemove && (
                      <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => onRemove(c.id))}>
                        {t('action.remove')}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canEdit && (
        <form onSubmit={submit} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 16 }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.name')}</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.contact_title')}</label>
            <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.phone')}</label>
            <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.email')}</label>
            <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm((f) => ({ ...f, isPrimary: e.target.checked }))} />
            {t('field.is_primary')}
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.add')}
          </button>
        </form>
      )}
    </div>
  );
}
