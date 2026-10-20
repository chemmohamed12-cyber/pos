import 'reflect-metadata';
import { TreasuryController } from './treasury.controller';
import { PaymentsController } from '../../customer-finance/interface/payments.controller';
import { PERMISSION_METADATA_KEY, RequiredPermission } from '../../../foundation/permission/require-permission.decorator';
import { MODULE_REGISTRY } from '../../../foundation/module-registry/module-registry';
import { nodeRisk } from '../../../foundation/permission/permission-risk';

/**
 * T2 (2026-10-20) — authorization separation on the money-moving routes: each action has its OWN permission node (account administration, GL mapping, posting a
 * cash movement, transfer, reversal, payment reversal), all declared in the Finance manifest. Because the Permission Engine resolves a node through its ancestors,
 * a role holding `finance` editable still reaches every one of them (no existing role gains or loses access); an owner can now grant or withhold each
 * action separately — a more specific grant on a node wins over the module-wide one.
 */
describe('Treasury / payment authorization separation', () => {
  const required = (proto: object, method: string): RequiredPermission => Reflect.getMetadata(PERMISSION_METADATA_KEY, (proto as Record<string, object>)[method]) as RequiredPermission;
  const tp = TreasuryController.prototype;

  const expected: Array<[string, string]> = [
    ['createAccountType', 'finance.cash_account.manage'],
    ['listAccountTypes', 'finance.cash.view'],
    ['createAccount', 'finance.cash_account.manage'],
    ['listAccounts', 'finance.cash.view'],
    ['setAccountStatus', 'finance.cash_account.manage'],
    ['setGlMapping', 'finance.cash_account.mapping.manage'],
    ['cashIn', 'finance.cash.post'],
    ['cashOut', 'finance.cash.post'],
    ['transfer', 'finance.cash.transfer'],
    ['ledger', 'finance.cash.view'],
    ['reverse', 'finance.cash.reverse'],
  ];

  it.each(expected)('Treasury route %s requires %s (editable)', (method, node) => {
    const r = required(tp, method);
    expect(r).toBeDefined();
    expect(r.nodeKey).toBe(node);
    expect(r.access).toBe('editable');
  });

  it('payment reversal has its own node, separate from recording a payment', () => {
    const pp = PaymentsController.prototype;
    expect(required(pp, 'reverse').nodeKey).toBe('finance.payment.reverse');
    expect(required(pp, 'record').nodeKey).toBe('finance.payment.create');
  });

  it('every node used above is declared in the Finance manifest, and the destructive ones are classified sensitive or higher', () => {
    const nodes = new Set(MODULE_REGISTRY.nodesForModule('finance'));
    for (const [, node] of expected) expect(nodes.has(node)).toBe(true);
    expect(nodes.has('finance.payment.reverse')).toBe(true);
    for (const n of ['finance.cash.reverse', 'finance.payment.reverse', 'finance.cash.transfer', 'finance.cash_account.mapping.manage']) expect(nodeRisk(n)).not.toBe('low');
  });
});
