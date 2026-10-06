/**
 * Company-aware cache/key convention (CTO Foundation directive). This
 * codebase has no data-fetch caching layer today (every page does its own
 * `useEffect` + `fetch` — no react-query/swr) — per directive we do NOT
 * introduce one just for this. What we DO establish now, so it's there
 * before any page starts caching anything, is the invariant every future
 * cache key (or memoization dependency array) must follow:
 *
 *   companyScopedKey(companyId, 'customers', 'list', filters)
 *     !== companyScopedKey(otherCompanyId, 'customers', 'list', filters)
 *
 * i.e. [companyContext, domain, resource, ...params] — never
 * [domain, resource, ...params] alone. A key built without the Company
 * segment is the exact shape that leaks Company B's cached response into
 * Company A's screen after a switch.
 */
export function companyScopedKey(companyId: string | null, ...parts: Array<string | number | null | undefined>): string {
  return [companyId ?? 'no-company', ...parts.map((p) => (p === null || p === undefined ? '' : String(p)))].join(':');
}

/**
 * Simplest correct invalidation strategy given today's architecture (raw
 * per-page `useEffect` fetches, no cache store to selectively clear): force
 * every routed screen to fully remount on Company switch, so its own
 * `useEffect` reruns from scratch against the new Company session. Pass
 * this as the `key` prop on whatever wraps `<Outlet/>`. No Company-scoped
 * `useState` can survive a switch this way — the safe default until/unless
 * a real cache layer is introduced (a separate architecture decision, not
 * something Foundation should smuggle in here).
 */
export function companyRemountKey(companyId: string | null): string {
  return companyId ?? 'no-company';
}
