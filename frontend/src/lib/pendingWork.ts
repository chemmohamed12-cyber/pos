import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * NAV-03 — one place that shows everything waiting for a decision. The ERP has TWO separate approval mechanisms and they stay separate:
 *   - the Approval Engine (maker != checker, matrix rules; decided in /approvals or the owning accounting screen), and
 *   - Process-Engine state transitions (PR, PO, warehouse transactions, sales-order stages, returns, new-item requests) decided inside their own screens.
 * This module only READS the existing list endpoints and counts what is waiting. Every source keeps its own permission: a 403/404 simply hides that
 * source for this user (an operator never sees a queue they cannot open), so no authorization semantics change here.
 */
export interface PendingSource {
  key: string;
  /** terminology code of the human label */
  labelCode: string;
  /** the screen where the item is actually decided */
  to: string;
  count: number;
  /** ISO timestamp of the oldest waiting item, when the endpoint exposes it */
  oldest: string | null;
}

interface Row {
  state?: string;
  status?: string;
  createdAt?: string;
  decidedAt?: string | null;
}

const oldestOf = (rows: Row[]): string | null => rows.map((r) => r.createdAt).filter((d): d is string => !!d).sort()[0] ?? null;

async function guarded<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    // not permitted / module not licensed for this user: hide the source; any other failure is also non-fatal for a summary widget
    return null;
  }
}

function fromRows(key: string, labelCode: string, to: string, rows: Row[] | null, keep: (r: Row) => boolean): PendingSource | null {
  if (!rows || !Array.isArray(rows)) return null;
  const waiting = rows.filter(keep);
  return { key, labelCode, to, count: waiting.length, oldest: oldestOf(waiting) };
}

export async function loadPendingSources(): Promise<PendingSource[]> {
  const [engine, prs, pos, wh, orders, returns, items] = await Promise.all([
    guarded(() => api.get<Row[]>('/approvals/requests')),
    guarded(() => api.get<Row[]>('/procurement/purchase-requests')),
    guarded(() => api.get<Row[]>('/procurement/purchase-orders')),
    guarded(() => api.get<{ pendingApprovalsCount: number }>('/warehouse-transactions/overview')),
    guarded(() => api.get<Row[]>('/sales-orders')),
    guarded(() => api.get<Row[]>('/returns')),
    guarded(() => api.get<Row[]>('/procurement/item-requests')),
  ]);

  const sources: Array<PendingSource | null> = [
    fromRows('approval_engine', 'pending_work.source.approval_engine', '/approvals', engine, (r) => r.decidedAt === null),
    fromRows('purchase_request', 'pending_work.source.purchase_request', '/purchase-requests', prs, (r) => r.state === 'submitted'),
    fromRows('purchase_order', 'pending_work.source.purchase_order', '/purchase-orders', pos, (r) => r.state === 'submitted'),
    wh && typeof wh.pendingApprovalsCount === 'number'
      ? { key: 'warehouse_transaction', labelCode: 'pending_work.source.warehouse_transaction', to: '/movement-center', count: wh.pendingApprovalsCount, oldest: null }
      : null,
    fromRows('sales_order_supervisor', 'pending_work.source.sales_order_supervisor', '/sales-orders', orders, (r) => r.status === 'supervisor_review'),
    fromRows('sales_order_manager', 'pending_work.source.sales_order_manager', '/sales-orders', orders, (r) => r.status === 'manager_approval'),
    fromRows('sales_order_deposit', 'pending_work.source.sales_order_deposit', '/sales-orders', orders, (r) => r.status === 'deposit_verification'),
    fromRows('return_request', 'pending_work.source.return_request', '/returns', returns, (r) => r.state === 'requested'),
    fromRows('item_request', 'pending_work.source.item_request', '/purchase-requests', items, (r) => r.status === 'pending'),
  ];
  return sources.filter((s): s is PendingSource => s !== null);
}

export function usePendingSources() {
  const [sources, setSources] = useState<PendingSource[] | null>(null);
  useEffect(() => {
    let live = true;
    loadPendingSources().then((s) => live && setSources(s));
    return () => {
      live = false;
    };
  }, []);
  return sources;
}
