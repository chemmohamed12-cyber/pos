// Thin fetch wrapper — every request goes through here so auth headers
// and the {success, data, error} envelope are handled in exactly one
// place (matches the backend's DAII_API_ARCHITECTURE.md §2 error contract).
const API_BASE = '/api';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let accessToken: string | null = localStorage.getItem('daii_access_token');
let onUnauthorized: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
  if (token) localStorage.setItem('daii_access_token', token);
  else localStorage.removeItem('daii_access_token');
}

export function getAccessToken() {
  return accessToken;
}

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function apiFetch<T>(method: string, path: string, body?: unknown, opts?: { skipUnauthorizedHandler?: boolean }): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json: { success: boolean; data?: T; error?: { code: string; message: string } };
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
    throw new ApiError(res.status, json.error?.code ?? 'UNKNOWN', json.error?.message ?? 'Request failed.');
  }
  return json.data as T;
}

/** Multipart upload — `apiFetch` always JSON-encodes its body, which can't carry a File; this is the one escape hatch (same raw-fetch-with-FormData shape ExcelImportExport already used inline). */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const formData = new FormData();
  formData.append('file', file);
  const headers: Record<string, string> = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: formData });
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
  post: <T>(path: string, body?: unknown, opts?: { skipUnauthorizedHandler?: boolean }) => apiFetch<T>('POST', path, body, opts),
  delete: <T>(path: string) => apiFetch<T>('DELETE', path),
};

/**
 * Raw binary fetch — `apiFetch` always parses the `{success, data}` JSON
 * envelope, which a protected file download (e.g. `GET /media/:id`) never
 * returns. Attaches the same Bearer token by hand since a plain `<img>`/
 * `<a>` tag can't carry it — the caller turns the Blob into an object URL.
 */
export async function downloadBlob(path: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', `Failed to download (status ${res.status}).`);
  return res.blob();
}
