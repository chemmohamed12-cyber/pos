import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * NAV-06 / NAV-08 / NAV-13 — which screens and sections the CURRENT user can actually reach, taken from the same server-driven navigation the sidebar
 * renders (`GET /me/navigation`: entitlement + role + permission already applied). Used only to decide which cross-links to SHOW; it grants nothing and
 * every screen/API keeps its own authorization. While loading (or if the call fails) it yields `null` and callers show no extra link.
 */
export interface NavItemLite {
  to: string;
  code: string;
}
export interface NavGroupLite {
  code: string;
  coverTo?: string;
  items: NavItemLite[];
}

let cache: { at: number; promise: Promise<NavGroupLite[] | null> } | null = null;
const TTL_MS = 30000;

function loadGroups(): Promise<NavGroupLite[] | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.promise;
  const promise = api
    .get<{ groups: NavGroupLite[] }>('/me/navigation')
    .then((r) => (Array.isArray(r.groups) ? r.groups : null))
    .catch(() => null);
  cache = { at: Date.now(), promise };
  return promise;
}

export function useNavGroups(): NavGroupLite[] | null {
  const [groups, setGroups] = useState<NavGroupLite[] | null>(null);
  useEffect(() => {
    let live = true;
    loadGroups().then((g) => live && setGroups(g));
    return () => {
      live = false;
    };
  }, []);
  return groups;
}

export function useVisibleRoutes(): Set<string> | null {
  const groups = useNavGroups();
  return groups ? new Set(groups.flatMap((g) => g.items.map((i) => i.to))) : null;
}
