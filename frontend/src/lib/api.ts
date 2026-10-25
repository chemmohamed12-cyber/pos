// Thin fetch wrapper — every request goes through here so auth headers
// and the {success, data, error} envelope are handled in exactly one
// place (matches the backend's DAII_API_ARCHITECTURE.md §2 error contract).
const API_BASE = '/api';

export class ApiError extends Error {
  status: number;
  code: string;
  /** Parameters a localizable refusal carries (substituted into its registered label). */
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let accessToken: string | null = localStorage.getItem('daii_access_token');
let refreshToken: string | null = localStorage.getItem('daii_refresh_token');
let onUnauthorized: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
  if (token) localStorage.setItem('daii_access_token', token);
  else {
    // no access token = no session: the refresh token goes with it
    localStorage.removeItem('daii_access_token');
    refreshToken = null;
    localStorage.removeItem('daii_refresh_token');
  }
}

/** A freshly issued token pair (login / select-company / refresh). The refresh token is ROTATED by the server on every use, so the newest one must always replace the stored one. */
export function setSession(tokens: { accessToken: string; refreshToken?: string }) {
  setAccessToken(tokens.accessToken);
  if (tokens.refreshToken) {
    refreshToken = tokens.refreshToken;
    localStorage.setItem('daii_refresh_token', tokens.refreshToken);
  }
}

export function getRefreshToken() {
  return refreshToken;
}

/** Seconds until the access token's `exp`, or null when it cannot be read (treated as "unknown": the server stays the judge). */
function secondsToExpiry(token: string | null): number | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp - Date.now() / 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Silent session renewal. The access token lives 15 minutes; without this the user was signed out in the middle of work (and of a release deployment that takes minutes).
 * ONE refresh at a time (concurrent requests share it). Returns true when a new pair was stored; false when there is nothing to refresh with or the server refused
 * (expired / revoked / reused refresh token). A network or 5xx failure is not a refusal and never discards the stored token.
 */
let refreshing: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  if (!refreshToken) return Promise.resolve(false);
  if (!refreshing) {
    const used = refreshToken;
    refreshing = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: used }) });
        if (!res.ok) return false;
        const json = await res.json();
        if (!json.success || !json.data?.accessToken) return false;
        setSession(json.data);
        return true;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/** Renew shortly BEFORE expiry so a request never goes out with a token the server will refuse. */
async function ensureFreshToken() {
  const left = secondsToExpiry(accessToken);
  if (left !== null && left < 30 && refreshToken) await refreshSession();
}

/** Sends a request; on a 401 renews the session ONCE and repeats it with the new token. The caller decides what a remaining 401 means. */
async function sendWithRefresh(make: (token: string | null) => Promise<Response>, canRefresh: boolean): Promise<Response> {
  if (canRefresh) await ensureFreshToken();
  const res = await make(accessToken);
  if (res.status === 401 && canRefresh && refreshToken && (await refreshSession())) return make(accessToken);
  return res;
}

export function getAccessToken() {
  return accessToken;
}

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/** T2: a client-generated key for one logical submission (one form instance). The server stores key + result in the same transaction as the money movement, so a retry or double-click replays the result instead of repeating the effect. */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function apiFetch<T>(method: string, path: string, body?: unknown, opts?: { skipUnauthorizedHandler?: boolean; idempotencyKey?: string }): Promise<T> {
  // A route that answers 401 for "not a member of this Company" (skipUnauthorizedHandler) must not be retried with a renewed token: that 401 is about THAT action, not the session.
  const res = await sendWithRefresh(
    (token) =>
      fetch(`${API_BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    !opts?.skipUnauthorizedHandler && path !== '/auth/login' && path !== '/auth/refresh',
  );

  let json: { success: boolean; data?: T; error?: { code: string; message: string; details?: Record<string, unknown> } };
  try {
    json = await res.json();
  } catch {
    throw new ApiError(res.status, 'NON_JSON_RESPONSE', `Unexpected non-JSON response (status ${res.status}).`);
  }

  // `POST /auth/select-company` also answers 401 for "authenticated, but not
  // a member of this Company" (AuthService.selectCompany) — a normal,
  // recoverable rejection of ONE action, not proof the current session's
  // token is invalid. Callers that know this (via `skipUnauthorizedHandler`)
  // handle that 401 themselves instead of triggering a full logout.
  if (res.status === 401 && onUnauthorized && !opts?.skipUnauthorizedHandler) onUnauthorized();

  if (!json.success) {
    throw new ApiError(res.status, json.error?.code ?? 'UNKNOWN', json.error?.message ?? 'Request failed.', json.error?.details);
  }
  return json.data as T;
}

/** Multipart upload — `apiFetch` always JSON-encodes its body, which can't carry a File; this is the one escape hatch (same raw-fetch-with-FormData shape ExcelImportExport already used inline). */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await sendWithRefresh((token) => fetch(`${API_BASE}${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: formData }), true);
  let json: { success: boolean; data?: T; error?: { code: string; message: string } };
  try {
    json = await res.json();
  } catch {
    throw new ApiError(res.status, 'NON_JSON_RESPONSE', `Unexpected non-JSON response (status ${res.status}).`);
  }
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  if (!json.success) throw new ApiError(res.status, json.error?.code ?? 'UNKNOWN', json.error?.message ?? 'Upload failed.');
  return json.data as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>('GET', path),
  post: <T>(path: string, body?: unknown, opts?: { skipUnauthorizedHandler?: boolean; idempotencyKey?: string }) => apiFetch<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown) => apiFetch<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>('PATCH', path, body),
  delete: <T>(path: string) => apiFetch<T>('DELETE', path),
};

/**
 * Raw binary fetch — `apiFetch` always parses the `{success, data}` JSON
 * envelope, which a protected file download (e.g. `GET /media/:id`) never
 * returns. Attaches the same Bearer token by hand since a plain `<img>`/
 * `<a>` tag can't carry it — the caller turns the Blob into an object URL.
 */
export async function downloadBlob(path: string): Promise<Blob> {
  const res = await sendWithRefresh((token) => fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), true);
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', `Failed to download (status ${res.status}).`);
  return res.blob();
}
