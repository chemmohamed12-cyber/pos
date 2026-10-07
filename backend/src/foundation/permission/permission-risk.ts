/**
 * Authorization Foundation F3 — risk classification of permission nodes (Blueprint §8; Phase-0 appendix E, "Company-Admin critical-permission analysis").
 *
 *  - `critical`  : the 19 operational/financial nodes whose misuse is hard to undo (reopen a closed fiscal period, reverse a journal, adjust AR/AP/cash,
 *                  disburse payroll, terminate an employee, void a supplier invoice, delete master structures…). The list is explicit, not inferred.
 *  - `sensitive` : state-changing / money-moving verbs (approve, post, pay, close, cancel, issue, receive, transfer, release, award, settle, manage…).
 *  - `low`       : everything else (views, drafts, ordinary edits).
 *
 * A role COVERS a critical node when its effective level on that node (most-specific grant along the ancestor chain, like the Permission Engine) is
 * `editable` — so a module-wide `accounting` editable grant covers every critical accounting node. The anti-elevation rule is built on this: a
 * critical capability is granted only by someone who holds it EXPLICITLY (a grant that reaches it), never by administration authority alone.
 */
export type NodeRisk = 'low' | 'sensitive' | 'critical';

export const CRITICAL_NODES: readonly string[] = [
  'accounting.fiscal_period.reopen',
  'accounting.closing_exception.resolve',
  'accounting.ap.adjust',
  'accounting.ar.adjust',
  'accounting.cash.adjust',
  'accounting.fixed_asset.post',
  'accounting.fixed_asset.adjust',
  'accounting.journal.reverse',
  'accounting.inventory.adjust',
  'finance.invoice.cancel',
  'hr.employee.terminate',
  'inventory.stock_count.adjust',
  'logistics.return.adjust',
  'manufacturing.bom.delete',
  'manufacturing.routing.delete',
  'manufacturing.work_center.delete',
  'payroll.run.approve',
  'payroll.run.disburse',
  'procurement.supplier_invoice.void',
];

const SENSITIVE_VERBS = new Set([
  'approve', 'post', 'pay', 'close', 'cancel', 'void', 'delete', 'issue', 'receive', 'transfer', 'release', 'award', 'settle', 'manage', 'adjust', 'reverse',
  'reopen', 'terminate', 'disburse', 'submit', 'confirm', 'link_user', 'material_issue', 'material_return', 'finished_goods_receive', 'resolve', 'reclose',
]);

const CRITICAL_SET = new Set(CRITICAL_NODES);

export function nodeRisk(node: string): NodeRisk {
  if (CRITICAL_SET.has(node)) return 'critical';
  const last = node.split('.').pop() as string;
  return SENSITIVE_VERBS.has(last) ? 'sensitive' : 'low';
}
