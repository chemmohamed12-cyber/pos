import { createContext, useContext, useState, type ReactNode } from 'react';

export type AccessLevel = 'read-only' | 'editable';
export const ROLES: Record<string, { label: string; userId: string; grants: Record<string, AccessLevel> }> = {
  viewer: { label: 'Viewer (documents read-only)', userId: 'u-viewer', grants: { 'finance.cash_document.view': 'read-only', 'accounting.cash.view': 'read-only' } },
  preparer: { label: 'Preparer', userId: 'u-prep', grants: { 'finance.cash_document.view': 'read-only', 'finance.cash_document.create': 'editable', 'finance.cash_document.submit': 'editable', 'accounting.cash.view': 'read-only' } },
  approver: { label: 'Approver', userId: 'u-appr', grants: { 'finance.cash_document.view': 'read-only', 'finance.cash_document.approve': 'editable' } },
  executor: { label: 'Executor', userId: 'u-exec', grants: { 'finance.cash_document.view': 'read-only', 'finance.cash_document.execute': 'editable' } },
  admin: { label: 'Finance admin (all)', userId: 'u-admin', grants: { finance: 'editable', 'accounting.cash': 'editable' } },
};
interface Value { user: { id: string; email: string; fullName: string; roles: string[] }; can: (node: string, level?: AccessLevel) => boolean; role: string; setRole: (r: string) => void }
const Ctx = createContext<Value | null>(null);

function covers(grants: Record<string, AccessLevel>, node: string, level: AccessLevel): boolean {
  const parts = node.split('.');
  for (let i = parts.length; i > 0; i--) {
    const g = grants[parts.slice(0, i).join('.')];
    if (g) return level === 'read-only' ? true : g === 'editable'; // most specific grant wins, like the Permission Engine
  }
  return false;
}
export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState(localStorage.getItem('harness_role') ?? 'admin');
  const r = ROLES[role] ?? ROLES.admin;
  const value: Value = {
    user: { id: r.userId, email: `${r.userId}@harness.local`, fullName: r.label, roles: [] },
    can: (node, level = 'read-only') => covers(r.grants, node, level),
    role,
    setRole: (x) => { localStorage.setItem('harness_role', x); setRoleState(x); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}
