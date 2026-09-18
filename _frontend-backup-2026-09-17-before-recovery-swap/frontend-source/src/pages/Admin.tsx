import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';

interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  status: string;
  roles: string[];
}

const ROLES = ['admin', 'finance', 'sales_rep', 'sales_supervisor', 'sales_manager', 'warehouse_worker', 'warehouse_supervisor', 'inventory_controller', 'driver'];
const STATUSES = ['active', 'suspended', 'disabled', 'pending'];

export function Admin() {
  const { t, preload } = useLanguage();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [statusSelections, setStatusSelections] = useState<Record<string, string>>({});
  const [passwordInputs, setPasswordInputs] = useState<Record<string, string>>({});
  const [profileEdits, setProfileEdits] = useState<Record<string, { fullName: string; email: string }>>({});
  const [newUser, setNewUser] = useState({ fullName: '', email: '', password: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  preload([
    ...ROLES.map((r) => `role.${r}`),
    ...STATUSES.map((s) => `status.${s}`),
    'field.name',
    'field.email',
    'field.status',
    'field.assign_role',
    'field.current_roles',
    'field.new_password',
    'field.password',
    'panel.add_new_user',
    'action.save',
    'action.revoke',
    'action.reset_password',
    'action.activate',
    'action.deactivate',
    'action.create',
  ]);

  async function load() {
    const data = await api.get<AdminUser[]>('/admin/users');
    setUsers(data);
    setProfileEdits(Object.fromEntries(data.map((u) => [u.id, { fullName: u.fullName, email: u.email }])));
  }

  useEffect(() => {
    load();
  }, []);

  async function createUser() {
    const { fullName, email, password } = newUser;
    if (!fullName.trim() || !email.trim() || password.length < 8) {
      setError('Full name, email, and a password of at least 8 characters are required.');
      return;
    }
    withBusy('create-user', async () => {
      await api.post('/auth/register', { fullName: fullName.trim(), email: email.trim(), password });
      setMessage(`User "${fullName.trim()}" created.`);
      setNewUser({ fullName: '', email: '', password: '' });
      await load();
    });
  }

  function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setMessage(null);
    fn()
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Action failed.'))
      .finally(() => setBusy(null));
  }

  async function saveProfile(userId: string) {
    const edit = profileEdits[userId];
    if (!edit || !edit.fullName.trim() || !edit.email.trim()) return;
    withBusy(`profile-${userId}`, async () => {
      await api.post(`/admin/users/${userId}/profile`, { fullName: edit.fullName.trim(), email: edit.email.trim() });
      setMessage('Profile updated.');
      await load();
    });
  }

  async function assignRole(userId: string) {
    const roleKey = selections[userId];
    if (!roleKey) return;
    withBusy(`assign-${userId}`, async () => {
      await api.post('/admin/roles/assign', { userId, roleKey });
      setMessage(`Assigned ${roleKey}.`);
      await load();
    });
  }

  async function revokeRole(userId: string, roleKey: string) {
    withBusy(`revoke-${userId}-${roleKey}`, async () => {
      await api.post('/admin/roles/revoke', { userId, roleKey });
      setMessage(`Revoked ${roleKey}.`);
      await load();
    });
  }

  async function setStatus(userId: string) {
    const status = statusSelections[userId];
    if (!status) return;
    withBusy(`status-${userId}`, async () => {
      await api.post(`/admin/users/${userId}/status`, { status });
      setMessage(`Status set to ${status}.`);
      await load();
    });
  }

  async function resetPassword(userId: string) {
    const newPassword = passwordInputs[userId];
    if (!newPassword || newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    withBusy(`reset-${userId}`, async () => {
      await api.post(`/admin/users/${userId}/reset-password`, { newPassword });
      setMessage('Password reset. The user has been signed out everywhere.');
      setPasswordInputs((prev) => ({ ...prev, [userId]: '' }));
    });
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.admin')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}
      {message && <div style={{ color: '#1c7a3e', fontSize: '0.85rem', marginBottom: 10 }}>{message}</div>}

      <div className="card" style={{ marginBottom: 16, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>{t('panel.add_new_user')}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {t('field.name')}
            <input
              type="text"
              value={newUser.fullName}
              onChange={(e) => setNewUser((prev) => ({ ...prev, fullName: e.target.value }))}
              style={{ width: 160 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {t('field.email')}
            <input
              type="email"
              value={newUser.email}
              onChange={(e) => setNewUser((prev) => ({ ...prev, email: e.target.value }))}
              style={{ width: 200 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {t('field.password')}
            <input
              type="password"
              value={newUser.password}
              onChange={(e) => setNewUser((prev) => ({ ...prev, password: e.target.value }))}
              style={{ width: 160 }}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={busy === 'create-user' || !newUser.fullName.trim() || !newUser.email.trim() || newUser.password.length < 8}
            onClick={createUser}
          >
            {t('action.create')}
          </button>
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>{t('field.name')}</th>
            <th>{t('field.email')}</th>
            <th>{t('field.status')}</th>
            <th>{t('field.current_roles')}</th>
            <th>{t('field.assign_role')}</th>
            <th>{t('action.reset_password')}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const edit = profileEdits[u.id] ?? { fullName: u.fullName, email: u.email };
            const profileChanged = edit.fullName.trim() !== u.fullName || edit.email.trim() !== u.email;
            return (
            <tr key={u.id}>
              <td>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={edit.fullName}
                    onChange={(e) => setProfileEdits((prev) => ({ ...prev, [u.id]: { ...edit, fullName: e.target.value } }))}
                    style={{ width: 130 }}
                  />
                </div>
              </td>
              <td>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="email"
                    value={edit.email}
                    onChange={(e) => setProfileEdits((prev) => ({ ...prev, [u.id]: { ...edit, email: e.target.value } }))}
                    style={{ width: 170 }}
                  />
                  <button
                    className="btn btn-secondary"
                    disabled={busy === `profile-${u.id}` || !profileChanged || !edit.fullName.trim() || !edit.email.trim()}
                    onClick={() => saveProfile(u.id)}
                  >
                    {t('action.save')}
                  </button>
                </div>
              </td>
              <td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="status-badge">{t(`status.${u.status}`)}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <select
                      value={statusSelections[u.id] ?? ''}
                      onChange={(e) => setStatusSelections((prev) => ({ ...prev, [u.id]: e.target.value }))}
                    >
                      <option value="">—</option>
                      {STATUSES.filter((s) => s !== u.status).map((s) => (
                        <option key={s} value={s}>
                          {t(`status.${s}`)}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn btn-secondary"
                      disabled={busy === `status-${u.id}` || !statusSelections[u.id]}
                      onClick={() => setStatus(u.id)}
                    >
                      {statusSelections[u.id] === 'active' ? t('action.activate') : t('action.deactivate')}
                    </button>
                  </div>
                </div>
              </td>
              <td>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {u.roles.length === 0 && <span style={{ color: '#888' }}>—</span>}
                  {u.roles.map((r) => (
                    <span key={r} className="status-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {t(`role.${r}`)}
                      <button
                        className="btn-link"
                        disabled={busy === `revoke-${u.id}-${r}`}
                        onClick={() => revokeRole(u.id, r)}
                        title={t('action.revoke')}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#a33', padding: 0 }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <div style={{ display: 'flex', gap: 6 }}>
                  <select value={selections[u.id] ?? ''} onChange={(e) => setSelections((prev) => ({ ...prev, [u.id]: e.target.value }))}>
                    <option value="">—</option>
                    {ROLES.filter((r) => !u.roles.includes(r)).map((r) => (
                      <option key={r} value={r}>
                        {t(`role.${r}`)}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-secondary" disabled={busy === `assign-${u.id}` || !selections[u.id]} onClick={() => assignRole(u.id)}>
                    {t('action.save')}
                  </button>
                </div>
              </td>
              <td>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="password"
                    placeholder={t('field.new_password')}
                    value={passwordInputs[u.id] ?? ''}
                    onChange={(e) => setPasswordInputs((prev) => ({ ...prev, [u.id]: e.target.value }))}
                    style={{ width: 140 }}
                  />
                  <button
                    className="btn btn-secondary"
                    disabled={busy === `reset-${u.id}` || !passwordInputs[u.id]}
                    onClick={() => resetPassword(u.id)}
                  >
                    {t('action.reset_password')}
                  </button>
                </div>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
