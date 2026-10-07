import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setAccessToken, getAccessToken, setUnauthorizedHandler } from '../lib/api';
import { canFrom, inScopeFrom, type AccessLevel, type AuthzView, type ScopeKind } from '../lib/authz';

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
}

/** Mirrors backend `CompanyStatus` (`company-status.ts`) exactly — never a locally-invented subset. */
export type CompanyStatus = 'PROVISIONING' | 'READY' | 'DEGRADED' | 'SUSPENDED' | 'MIGRATING' | 'FAILED' | 'DECOMMISSIONED';

/** One row of the real `GET /memberships/mine` (`memberships-mine.controller.ts`) — `companyId`/`roleKey` from `Membership`, `companyName`/`status` from `Company`. */
export interface CompanyMembership {
  companyId: string;
  companyName: string;
  status: CompanyStatus;
  roleKey: string;
}

/**
 * The active Company session — distinct from the platform session
 * (`user`). Only ever set from a REAL `POST /auth/select-company` response
 * (`AuthService.selectCompany`, Multi-Company Area 5) — never fabricated,
 * never inferred from a role or a URL param (CTO Foundation directive).
 */
export interface CompanyContext {
  companyId: string;
  companyName: string;
  status: CompanyStatus;
  roleKey: string;
}

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (...roles: string[]) => boolean;
  /** F1.3 — the Company-aware authorization view from `GET /auth/me` (`null` until loaded). UX guidance only; the backend is the authority. */
  authz: AuthzView | null;
  /** F1.3 — `can('accounting.journal.post', 'editable')`: a lookup in the effective capabilities of the CURRENT Company. Show/enable hint, never a grant. */
  can: (node: string, level?: AccessLevel) => boolean;
  /** F1.3 — is this org unit / warehouse / department inside the user's scope (hint; services enforce scope). */
  inScope: (kind: ScopeKind, id: string) => boolean;
  /** Active Company session, or null before one is selected. */
  companyContext: CompanyContext | null;
  /** The caller's own Company memberships, for the Company Switcher / initial-selection screen. `null` = not loaded yet (see `refreshMemberships`); `[]` = loaded and genuinely zero. */
  memberships: CompanyMembership[] | null;
  /**
   * Loads `memberships` from the real `GET /memberships/mine`. Leaves
   * `memberships` at `null` on failure (never `[]`) so the UI can render a
   * genuine "unavailable" state instead of a fake empty company list.
   */
  refreshMemberships: () => Promise<void>;
  /** Mints a fresh Company-scoped session via the REAL `POST /auth/select-company` endpoint and replaces the active token. Never accepts a client-invented companyId — the caller must come from `memberships`. */
  selectCompany: (companyId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const LAST_COMPANY_KEY = 'daii_last_company';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [companyContext, setCompanyContext] = useState<CompanyContext | null>(null);
  const [memberships, setMemberships] = useState<CompanyMembership[] | null>(null);
  const [authz, setAuthz] = useState<AuthzView | null>(null);

  /** Reloads the authorization view under the CURRENT token (platform token before a Company is entered, Company token after). Failure leaves it `null` — never a fabricated grant. */
  async function refreshAuthz() {
    try {
      setAuthz(await api.get<AuthzView>('/auth/me'));
    } catch {
      setAuthz(null);
    }
  }

  async function loadMe() {
    try {
      const me = await api.get<CurrentUser>('/auth/me');
      const rows = await loadMemberships();
      // Establish the Company session BEFORE the app renders (`loading` stays
      // true until the finally block), so Company-scoped screens never fire
      // their first fetch without a Company token.
      if (rows) await restoreCompanySession(rows);
      await refreshAuthz();
      setUser(me);
    } catch {
      setAccessToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setCompanyContext(null);
      setMemberships(null);
      setAuthz(null);
    });
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
    setCompanyContext(null);
    setMemberships(null);
    await loadMe();
  }

  function logout() {
    try {
      sessionStorage.removeItem(LAST_COMPANY_KEY);
    } catch {
      /* ignore */
    }
    setAccessToken(null);
    setUser(null);
    setCompanyContext(null);
    setMemberships(null);
    setAuthz(null);
  }

  const can = (node: string, level: AccessLevel = 'read-only') => canFrom(authz, node, level);
  const inScope = (kind: ScopeKind, id: string) => inScopeFrom(authz, kind, id);

  function hasRole(...roles: string[]) {
    if (!user) return false;
    if (user.roles.includes('admin')) return true;
    return roles.some((r) => user.roles.includes(r));
  }

  async function loadMemberships(): Promise<CompanyMembership[] | null> {
    try {
      const rows = await api.get<CompanyMembership[]>('/memberships/mine');
      setMemberships(rows);
      return rows;
    } catch {
      // Leave at null (not []) — the UI must render this as "unavailable", never "zero companies".
      setMemberships(null);
      return null;
    }
  }

  async function refreshMemberships() {
    await loadMemberships();
  }

  /**
   * A login or page reload starts with no Company session in memory. Re-enter
   * the Company this browser tab last used if the user is still a READY member
   * of it, otherwise the single READY Company if there is exactly one. Both go
   * through the REAL `POST /auth/select-company` (server-validated against
   * Membership) — nothing is read from a token claim or invented. With several
   * Companies and no remembered choice the Company Switcher asks the user.
   */
  async function restoreCompanySession(rows: CompanyMembership[]) {
    const ready = rows.filter((m) => m.status === 'READY');
    let remembered: string | null = null;
    try {
      remembered = sessionStorage.getItem(LAST_COMPANY_KEY);
    } catch {
      /* storage unavailable — fall through to the single-Company rule */
    }
    const target = ready.find((m) => m.companyId === remembered) ?? (ready.length === 1 ? ready[0] : undefined);
    if (!target) return;
    try {
      await enterCompany(target);
    } catch {
      // Not fatal: the user can still pick a Company in the switcher.
    }
  }

  async function enterCompany(membership: CompanyMembership) {
    const tokens = await api.post<{ accessToken: string }>('/auth/select-company', { companyId: membership.companyId }, { skipUnauthorizedHandler: true });
    setAccessToken(tokens.accessToken);
    setCompanyContext({ companyId: membership.companyId, companyName: membership.companyName, status: membership.status, roleKey: membership.roleKey });
    await refreshAuthz(); // the Company token changes the authorization domain: capabilities/scopes are the NEW Company's
    try {
      sessionStorage.setItem(LAST_COMPANY_KEY, membership.companyId);
    } catch {
      /* storage unavailable — remembering the choice is a convenience only */
    }
  }

  async function selectCompany(companyId: string) {
    // `skipUnauthorizedHandler`: a 401 here can mean "you are not a member
    // of this Company" (a normal rejection of this one action, per
    // `AuthService.selectCompany`) rather than "your session token is
    // invalid" — must not trigger a full logout.
    const membership = memberships?.find((m) => m.companyId === companyId);
    if (membership) return enterCompany(membership);
    // Unknown to the loaded list: still let the server decide (it rejects a non-member).
    const tokens = await api.post<{ accessToken: string }>('/auth/select-company', { companyId }, { skipUnauthorizedHandler: true });
    setAccessToken(tokens.accessToken);
    setCompanyContext(null);
    await refreshAuthz();
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, login, logout, hasRole, authz, can, inScope, companyContext, memberships, refreshMemberships, selectCompany }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
