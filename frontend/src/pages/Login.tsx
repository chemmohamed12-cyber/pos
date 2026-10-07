import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { ApiError } from '../lib/api';
import { PasswordInput } from '../components/PasswordInput';

export function Login() {
  const { login } = useAuth();
  const { lang, setLang } = useLanguage();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      // F2: a person who came from an invitation link and chose "sign in" returns to that invitation to accept it.
      let pending: string | null = null;
      try {
        pending = sessionStorage.getItem('daii_pending_invitation');
      } catch {
        /* ignore */
      }
      navigate(pending ? `/accept-invitation?token=${encodeURIComponent(pending)}` : '/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>{lang === 'ar' ? 'منصة دائي' : 'Daii Platform'}</h1>
        <div className="subtitle">{lang === 'ar' ? 'تسجيل الدخول للمتابعة' : 'Sign in to continue'}</div>
        <form onSubmit={onSubmit}>
          <div className="form-field">
            <label>{lang === 'ar' ? 'البريد الإلكتروني' : 'Email'}</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div className="form-field">
            <label>{lang === 'ar' ? 'كلمة المرور' : 'Password'}</label>
            <PasswordInput value={password} onChange={setPassword} required />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%', marginTop: 8 }}>
            {busy ? '...' : lang === 'ar' ? 'تسجيل الدخول' : 'Log In'}
          </button>
        </form>
        <button
          className="btn btn-secondary"
          style={{ width: '100%', marginTop: 10 }}
          onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
          type="button"
        >
          {lang === 'ar' ? 'English' : 'العربية'}
        </button>
      </div>
    </div>
  );
}
