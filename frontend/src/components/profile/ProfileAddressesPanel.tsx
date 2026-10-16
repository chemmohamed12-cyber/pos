import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

/** Shared address-book panel (customer and supplier profiles). Presentational: the caller wires the actions to its own API. */
export interface ProfileAddress {
  id: string;
  label: string | null;
  addressLine: string;
  city: string | null;
  governorate: string | null;
  isDefault: boolean;
  /** Customer addresses only; the supplier API has no billing/shipping flags. */
  isBilling?: boolean;
  isShipping?: boolean;
}

interface Props {
  addresses: ProfileAddress[];
  canEdit: boolean;
  /** Show the billing / shipping flags (customers). */
  withFlags?: boolean;
  onAdd: (input: { label?: string; addressLine: string; city?: string; governorate?: string; isDefault?: boolean; isBilling?: boolean; isShipping?: boolean }) => Promise<void>;
  /** Omit when the API cannot change the default after creation. */
  onSetDefault?: (id: string) => Promise<void>;
  /** Omit when the API has no removal (the panel then simply hides the button). */
  onRemove?: (id: string) => Promise<void>;
}

export function ProfileAddressesPanel({ addresses, canEdit, withFlags, onAdd, onSetDefault, onRemove }: Props) {
  const { t, preload } = useLanguage();
  preload([
    'panel.addresses',
    'panel.no_addresses_yet',
    'field.label',
    'field.address',
    'field.city',
    'field.governorate',
    'field.is_default',
    'field.is_billing',
    'field.is_shipping',
    'field.actions',
    'action.add',
    'action.remove',
    'action.set_default',
  ]);
  const blank = { label: '', addressLine: '', city: '', governorate: '', isDefault: false, isBilling: false, isShipping: false };
  const [form, setForm] = useState(blank);
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
      await onAdd({ ...form, ...(withFlags ? {} : { isBilling: undefined, isShipping: undefined }) });
      setForm(blank);
    });
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>{t('panel.addresses')}</h3>
      {error && <div className="error-text">{error}</div>}
      {addresses.length === 0 ? (
        <div className="empty-state">{t('panel.no_addresses_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.label')}</th>
              <th>{t('field.address')}</th>
              <th>{t('field.city')}</th>
              <th>{t('field.governorate')}</th>
              <th>{t('field.is_default')}</th>
              {withFlags && <th>{t('field.is_billing')}</th>}
              {withFlags && <th>{t('field.is_shipping')}</th>}
              {canEdit && <th>{t('field.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {addresses.map((a) => (
              <tr key={a.id}>
                <td>{a.label ?? '—'}</td>
                <td>{a.addressLine}</td>
                <td>{a.city ?? '—'}</td>
                <td>{a.governorate ?? '—'}</td>
                <td>{a.isDefault ? '✓' : ''}</td>
                {withFlags && <td>{a.isBilling ? '✓' : ''}</td>}
                {withFlags && <td>{a.isShipping ? '✓' : ''}</td>}
                {canEdit && (
                  <td style={{ display: 'flex', gap: 6 }}>
                    {onSetDefault && !a.isDefault && (
                      <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => onSetDefault(a.id))}>
                        {t('action.set_default')}
                      </button>
                    )}
                    {onRemove && (
                      <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => onRemove(a.id))}>
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
            <label>{t('field.label')}</label>
            <input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 260 }}>
            <label>{t('field.address')}</label>
            <input value={form.addressLine} onChange={(e) => setForm((f) => ({ ...f, addressLine: e.target.value }))} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.city')}</label>
            <input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.governorate')}</label>
            <input value={form.governorate} onChange={(e) => setForm((f) => ({ ...f, governorate: e.target.value }))} />
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))} />
            {t('field.is_default')}
          </label>
          {withFlags && (
            <>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={form.isBilling} onChange={(e) => setForm((f) => ({ ...f, isBilling: e.target.checked }))} />
                {t('field.is_billing')}
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={form.isShipping} onChange={(e) => setForm((f) => ({ ...f, isShipping: e.target.checked }))} />
                {t('field.is_shipping')}
              </label>
            </>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.add')}
          </button>
        </form>
      )}
    </div>
  );
}
