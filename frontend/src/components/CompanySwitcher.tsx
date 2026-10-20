import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { ApiError } from '../lib/api';
import { nameOf, currentLang, STATUS_NAMES } from '../lib/displayNames';

/**
 * Company Switcher — renders strictly from `AuthContext`'s
 * `memberships`/`companyContext`, backed by the real `GET /memberships/mine`.
 * Renders nothing for a single-company/no-membership case (nothing to
 * switch between), which is the correct state, not a bug.
 *
 * A membership whose Company `status` isn't `READY` is shown but disabled
 * — `/memberships/mine` does not filter by lifecycle state, and the CTO's
 * Multi-Company UX decision is explicit: PROVISIONING (or any other
 * non-READY state) must never be treated as selectable/usable.
 *
 * The actual switch is the real flow (never a bare `setCompanyId`):
 * select -> `selectCompany(companyId)` -> POST /auth/select-company ->
 * fresh Company-scoped token replaces the session -> caller must remount
 * Company-scoped content (see `companyRemountKey` in `lib/companyScope.ts`).
 */
export function CompanySwitcher() {
  const { companyContext, memberships, selectCompany } = useAuth();
  const { lang } = useLanguage();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!memberships || memberships.length <= 1) {
    // Nothing to switch between yet — either memberships haven't loaded,
    // or the user genuinely belongs to at most one Company.
    return companyContext ? <span className="company-switcher-single">{companyContext.companyName}</span> : null;
  }

  async function onChange(companyId: string) {
    if (companyId === companyContext?.companyId) return;
    const target = memberships?.find((m) => m.companyId === companyId);
    if (target && target.status !== 'READY') return; // defensive — the <option> is already disabled
    setSwitching(true);
    setError(null);
    try {
      await selectCompany(companyId);
      // Company-scoped data must be discarded and refetched under the new
      // session — the simplest correct way with today's per-page fetch
      // architecture is a full reload, which re-runs every mounted
      // screen's data effects against the new token from a clean slate.
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : lang === 'ar' ? 'تعذر تبديل الشركة.' : 'Could not switch company.');
      setSwitching(false);
    }
  }

  return (
    <div className="company-switcher">
      <select
        className="company-switcher-select"
        value={companyContext?.companyId ?? ''}
        disabled={switching}
        onChange={(e) => onChange(e.target.value)}
      >
        {!companyContext && (
          <option value="" disabled>
            {lang === 'ar' ? 'اختر الشركة' : 'Select company'}
          </option>
        )}
        {memberships.map((m) => (
          <option key={m.companyId} value={m.companyId} disabled={m.status !== 'READY'}>
            {m.companyName}
            {m.status !== 'READY' ? ` (${nameOf(STATUS_NAMES, m.status.toLowerCase(), currentLang())})` : ''}
          </option>
        ))}
      </select>
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
