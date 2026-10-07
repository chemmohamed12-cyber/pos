import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { PasswordInput } from '../components/PasswordInput';

interface Preview {
  companyName: string;
  email: string;
  fullName: string | null;
}

export const PENDING_INVITATION_KEY = 'daii_pending_invitation';

/**
 * Invitation acceptance (F2). Public route: the one-time token in the link is the credential.
 *  - signed in as the invited e-mail  -> "Accept" (an existing account never gets a password set through a token)
 *  - signed in as someone else        -> explains and offers sign-out (the token only works for its own e-mail)
 *  - not signed in                    -> sign in with the existing account, or create the account (only possible when the e-mail has none)
 */
export function AcceptInvitation() {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const { user, login, logout, selectCompany } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [preview, setPreview] = useState<Preview | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .get<Preview>(`/invitations/preview?token=${encodeURIComponent(token)}`)
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setFullName(p.fullName ?? '');
      })
      .catch(() => live && setInvalid(true));
    return () => {
      live = false;
    };
  }, [token]);

  async function finish(companyId: string) {
    try {
      sessionStorage.removeItem(PENDING_INVITATION_KEY);
    } catch {
      /* ignore */
    }
    await selectCompany(companyId);
    navigate('/');
  }

  async function acceptAsSignedIn() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ companyId: string }>('/invitations/accept', { token });
      await finish(res.companyId);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'INVITATION_INVALID' ? (ar ? 'هذه الدعوة غير صالحة لهذا الحساب.' : 'This invitation is not valid for this account.') : err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ companyId: string }>('/invitations/register', { token, fullName, password });
      await login(preview.email, password);
      await finish(res.companyId);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ACCOUNT_EXISTS_SIGN_IN') setError(ar ? 'لهذا البريد حساب بالفعل — سجّل الدخول بحسابك لقبول الدعوة.' : 'This e-mail already has an account — sign in with it to accept.');
      else setError(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  function goSignIn() {
    try {
      sessionStorage.setItem(PENDING_INVITATION_KEY, token);
    } catch {
      /* ignore */
    }
    navigate('/login');
  }

  const sameEmail = !!user && !!preview && user.email.trim().toLowerCase() === preview.email;

  return (
    <div className="login-page">
      <div className="login-card" style={{ maxWidth: 460 }}>
        <h1>{ar ? 'دعوة للانضمام إلى شركة' : 'Company invitation'}</h1>
        {invalid && <div className="error-text" role="alert">{ar ? 'هذه الدعوة غير صالحة أو انتهت صلاحيتها.' : 'This invitation is not valid or has expired.'}</div>}
        {!invalid && !preview && <div className="subtitle">…</div>}
        {preview && (
          <>
            <div className="subtitle">
              {ar ? `تمت دعوتك للانضمام إلى «${preview.companyName}» بالبريد ` : `You were invited to join “${preview.companyName}” as `}
              <b style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{preview.email}</b>
            </div>
            {user ? (
              sameEmail ? (
                <button className="btn btn-primary" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={acceptAsSignedIn}>
                  {ar ? 'قبول الدعوة' : 'Accept invitation'}
                </button>
              ) : (
                <div style={{ marginTop: 12 }}>
                  <div className="error-text">{ar ? `أنت مسجّل الدخول بحساب مختلف (${user.email}). الدعوة تعمل فقط لحساب ${preview.email}.` : `You are signed in as ${user.email}. This invitation only works for ${preview.email}.`}</div>
                  <button className="btn btn-secondary" style={{ width: '100%', marginTop: 8 }} onClick={() => logout()}>
                    {ar ? 'تسجيل الخروج' : 'Sign out'}
                  </button>
                </div>
              )
            ) : (
              <>
                <button className="btn btn-secondary" style={{ width: '100%', marginTop: 12 }} onClick={goSignIn}>
                  {ar ? 'لدي حساب — تسجيل الدخول' : 'I already have an account — sign in'}
                </button>
                <div style={{ margin: '14px 0 6px', color: '#6b7280', textAlign: 'center' }}>{ar ? 'أو أنشئ حسابك' : 'or create your account'}</div>
                <form onSubmit={onCreate}>
                  <div className="form-field">
                    <label>{ar ? 'الاسم' : 'Full name'}</label>
                    <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
                  </div>
                  <div className="form-field">
                    <label>{ar ? 'كلمة المرور (8 أحرف على الأقل)' : 'Password (min. 8 characters)'}</label>
                    <PasswordInput value={password} onChange={setPassword} required />
                  </div>
                  <button className="btn btn-primary" type="submit" disabled={busy || password.length < 8} style={{ width: '100%' }}>
                    {ar ? 'إنشاء الحساب والانضمام' : 'Create account and join'}
                  </button>
                </form>
              </>
            )}
            {error && <div className="error-text" role="alert" style={{ marginTop: 10 }}>{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
