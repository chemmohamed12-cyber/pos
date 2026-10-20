import 'reflect-metadata';
import { TreasuryController } from './treasury.controller';
import { TreasuryDocumentsController } from './treasury-documents.controller';
import { BankStatementsController, CashSessionsController } from './bank-statements.controller';
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

  it.each([
    ['list', 'finance.cash_document.view', 'read-only'],
    ['get', 'finance.cash_document.view', 'read-only'],
    ['effect', 'finance.cash_document.view', 'read-only'],
    ['create', 'finance.cash_document.create', 'editable'],
    ['update', 'finance.cash_document.create', 'editable'],
    ['submit', 'finance.cash_document.submit', 'editable'],
    ['decide', 'finance.cash_document.approve', 'editable'],
    ['execute', 'finance.cash_document.execute', 'editable'],
    ['cancel', 'finance.cash_document.cancel', 'editable'],
    ['reverse', 'finance.cash_document.reverse', 'editable'],
  ])('Treasury Documents route %s requires %s (%s) — prepare, submit, approve, execute, cancel and reverse are separate permissions', (method, node, access) => {
    const r = required(TreasuryDocumentsController.prototype, method);
    expect(r?.nodeKey).toBe(node);
    expect(r?.access).toBe(access);
    expect(MODULE_REGISTRY.nodesForModule('finance')).toContain(node);
  });

  it.each([
    ['list', 'finance.bank_statement.view', 'read-only'], ['get', 'finance.bank_statement.view', 'read-only'], ['reconciliation', 'finance.bank_statement.view', 'read-only'],
    ['import', 'finance.bank_statement.import', 'editable'], ['suggest', 'finance.bank_statement.match', 'editable'], ['confirm', 'finance.bank_statement.match', 'editable'],
    ['unmatch', 'finance.bank_statement.unmatch', 'editable'], ['reconcile', 'finance.bank_statement.reconcile', 'editable'], ['reopen', 'finance.bank_statement.reopen', 'editable'],
  ])('Bank statements route %s requires %s (%s) - import, match, unmatch, reconcile and reopen are separate permissions', (method, node, access) => {
    const r = required(BankStatementsController.prototype, method);
    expect(r?.nodeKey).toBe(node);
    expect(r?.access).toBe(access);
    expect(MODULE_REGISTRY.nodesForModule('finance')).toContain(node);
  });

  it.each([
    ['list', 'finance.cash_session.view', 'read-only'], ['get', 'finance.cash_session.view', 'read-only'], ['open', 'finance.cash_session.open', 'editable'],
    ['close', 'finance.cash_session.close', 'editable'], ['reopen', 'finance.cash_session.reopen', 'editable'],
  ])('Cash sessions route %s requires %s (%s)', (method, node, access) => {
    const r = required(CashSessionsController.prototype, method);
    expect(r?.nodeKey).toBe(node);
    expect(r?.access).toBe(access);
    expect(MODULE_REGISTRY.nodesForModule('finance')).toContain(node);
  });
});
