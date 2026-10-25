import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { apiErrorText } from './payrollUi';

type SodProfile = 'standard' | 'strict';
const PROFILES: SodProfile[] = ['standard', 'strict'];

/** Addendum A-6 — the Company's separation-of-duties profile for payroll runs. The mandatory floor (approver is neither preparer nor submitter) applies in every profile and is not editable. */
export function PayrollSettings() {
  const { t, preload } = useLanguage();
  const { can } = useAuth();
  const [profile, setProfile] = useState<SodProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const canManage = can('payroll.settings.manage');

  preload(['nav.payroll_settings', 'field.sod_profile', 'panel.sod_profile_hint', 'msg.settings_saved', 'msg.loading', 'msg.load_failed', 'msg.action_failed', ...PROFILES.map((p) => `value.sod_profile.${p}`), ...PROFILES.map((p) => `panel.sod_profile_${p}`)]);

  useEffect(() => {
    (async () => {
      try {
        setProfile((await api.get<{ profile: SodProfile }>('/payroll/settings/sod-profile')).profile);
      } catch (err) {
        setError(apiErrorText(err, t, 'msg.load_failed'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(next: SodProfile) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setProfile((await api.put<{ profile: SodProfile }>('/payroll/settings/sod-profile', { profile: next })).profile);
      setSaved(true);
    } catch (err) {
      setError(apiErrorText(err, t, 'msg.action_failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.payroll_settings')}</h1>
      </div>
      {error && <div className="error-text">{error}</div>}
      {saved && <div style={{ color: 'var(--success, #1a7f37)', marginBottom: 12 }}>{t('msg.settings_saved')}</div>}
      <div className="card">
        <h3>{t('field.sod_profile')}</h3>
        <p>{t('panel.sod_profile_hint')}</p>
        {profile === null ? (
          <div className="empty-state">{t('msg.loading')}</div>
        ) : (
          PROFILES.map((p) => (
            <label key={p} style={{ display: 'block', marginBottom: 12 }}>
              <input type="radio" name="sod_profile" checked={profile === p} disabled={!canManage || busy} onChange={() => save(p)} /> <strong>{t(`value.sod_profile.${p}`)}</strong>
              <div>{t(`panel.sod_profile_${p}`)}</div>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
