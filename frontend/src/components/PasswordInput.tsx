import { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  style?: React.CSSProperties;
}

/**
 * Show/hide toggle for a password-like field — `action.show_password`/
 * `action.hide_password` terminology already existed (seeded pre-recovery)
 * but no frontend field anywhere in the current source ever rendered a
 * toggle button, even though the recovered production bundle's own login
 * screen did (a `👁` button next to the password field). Reused across
 * `Login.tsx`, `Admin.tsx` (new user / reset password) and
 * `ExternalIntegrations.tsx` (pairing token).
 */
export function PasswordInput({ value, onChange, placeholder, required, autoFocus, style }: PasswordInputProps) {
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        style={style}
      />
      <button
        type="button"
        className="btn-link"
        onClick={() => setVisible((v) => !v)}
        title={t(visible ? 'action.hide_password' : 'action.show_password')}
        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, fontSize: '1rem' }}
      >
        {visible ? '🙈' : '👁'}
      </button>
    </div>
  );
}
