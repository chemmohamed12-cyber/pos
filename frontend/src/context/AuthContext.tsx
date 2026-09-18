import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setAccessToken, getAccessToken, setUnauthorizedHandler } from '../lib/api';

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
}

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (...roles: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadMe() {
    try {
      const me = await api.get<CurrentUser>('/auth/me');
      setUser(me);
    } catch {
      setAccessToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    if (getAccessToken()) {
      loadMe();
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login(email: string, password: string) {
    const tokens = await api.post<{ accessToken: string }>('/auth/login', { email, password });
    setAccessToken(tokens.accessToken);
    await loadMe();
  }

  function logout() {
    setAccessToken(null);
    setUser(null);
  }

  function hasRole(...roles: string[]) {
    if (!user) return false;
    if (user.roles.includes('admin')) return true;
    return roles.some((r) => user.roles.includes(r));
  }

  return <AuthContext.Provider value={{ user, loading, login, logout, hasRole }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
