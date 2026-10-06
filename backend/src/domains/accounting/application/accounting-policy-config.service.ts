import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';

export type PolicyGroup = 'inventory' | 'sales' | 'procurement' | 'cash' | 'fixed_assets';
export type PolicyKind = 'account' | 'reason_map';

export interface PolicyKeyDef {
  key: string;
  group: PolicyGroup;
  kind: PolicyKind;
  /** Account types that are TYPICAL for this setting. A different type only produces a WARNING — it is never an accounting rule here. */
  expectedTypes: string[];
}

/**
 * NAV-02 (2026-10-06) — the mandatory Accounting Policy configuration that is ACTUALLY CONSUMED by posting code (verified by source search: each
 * key below is read by a posting handler / pre-mutation gate and fails closed when unset or unusable). Five other declared keys
 * (`accounting.{ap,ar}_*_account_code` hints) are intentionally NOT listed: no code reads them, so exposing them would mislead the operator —
 * they belong to the AR/AP adjustment-account policy decision (see the NAV closure report).
 */
export const ACCOUNTING_POLICY_KEYS: readonly PolicyKeyDef[] = [
  { key: 'accounting.inventory_opening_balance_account_code', group: 'inventory', kind: 'account', expectedTypes: ['equity'] },
  { key: 'accounting.inventory_adjustment_gain_account_code', group: 'inventory', kind: 'account', expectedTypes: ['revenue'] },
  { key: 'accounting.inventory_adjustment_loss_account_code', group: 'inventory', kind: 'account', expectedTypes: ['expense'] },
  { key: 'accounting.inventory_cogs_account_code', group: 'inventory', kind: 'account', expectedTypes: ['expense'] },
  { key: 'accounting.inventory_manual_receipt_reason_accounts', group: 'inventory', kind: 'reason_map', expectedTypes: ['equity', 'revenue', 'liability'] },
  { key: 'accounting.sales_returns_account_code', group: 'sales', kind: 'account', expectedTypes: ['revenue', 'expense'] },
  { key: 'accounting.purchase_price_variance_account_code', group: 'procurement', kind: 'account', expectedTypes: ['expense'] },
  { key: 'accounting.cash_bank_opening_balance_account_code', group: 'cash', kind: 'account', expectedTypes: ['equity'] },
  { key: 'accounting.cash_movement_clearing_account_code', group: 'cash', kind: 'account', expectedTypes: ['asset', 'liability'] },
  { key: 'accounting.fixed_asset_gain_on_disposal_account_code', group: 'fixed_assets', kind: 'account', expectedTypes: ['revenue'] },
  { key: 'accounting.fixed_asset_loss_on_disposal_account_code', group: 'fixed_assets', kind: 'account', expectedTypes: ['expense'] },
  { key: 'accounting.fixed_asset_acquisition_clearing_account_code', group: 'fixed_assets', kind: 'account', expectedTypes: ['liability', 'asset'] },
];

export interface PolicyAccountRef {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  accountType: string;
}
export interface PolicyEntryView {
  reason: string | null;
  code: string;
  status: 'ok' | 'invalid';
  problem: string | null;
  warning: string | null;
  account: PolicyAccountRef | null;
}
export interface PolicyKeyView {
  key: string;
  group: PolicyGroup;
  kind: PolicyKind;
  expectedTypes: string[];
  status: 'unset' | 'ok' | 'invalid';
  /** account kind: the configured code; reason_map: null (see entries). */
  code: string | null;
  problem: string | null;
  warning: string | null;
  account: PolicyAccountRef | null;
  entries: PolicyEntryView[];
}

const REASON_CODE = /^[A-Za-z0-9_]{1,40}$/;
const INSTALLATION_SCOPE = { scope_type: 'installation', scope_id: null } as const;

/**
 * NAV-02 — a safe management surface over the EXISTING Configuration Engine for the accounting policy accounts. Nothing here changes any
 * accounting rule: the values are stored exactly where posting already reads them (the engine's installation scope), and the validation is the
 * SAME rule posting applies (`resolveConfiguredPostableAccount` / `InventoryPostingPolicyService.accountProblem`): the account must exist in
 * the requesting Company's chart, be active, postable and carry no control function. Account TYPE suitability is advisory only (a warning), because
 * choosing the right account family is an accounting decision, not a UI rule. Fail-closed behaviour is untouched: an unset or unusable value still
 * rejects the posting that needs it.
 *
 * Scope note (disclosed): the engine has no Company scope level — a value is installation-wide, while the chart is per Company. Validation here is
 * against the CALLER's Company chart; the same code must therefore exist in every Company of the installation (escalated in the closure report).
 */
@Injectable()
export class AccountingPolicyConfigService {
  constructor(
    private readonly config: ConfigurationEngineService,
    private readonly audit: AuditService,
  ) {}

  private def(key: string): PolicyKeyDef {
    const d = ACCOUNTING_POLICY_KEYS.find((k) => k.key === key);
    if (!d) throw new NotFoundException(`"${key}" is not a managed accounting policy setting.`);
    return d;
  }

  private ref(a: GLAccount): PolicyAccountRef {
    return { id: a.id, code: a.code, name: a.name, nameAr: a.nameAr ?? null, accountType: a.accountType };
  }

  /** Same rule as posting: exists / active / postable / non-control. */
  private problem(a: GLAccount | null): string | null {
    if (!a) return 'does not exist in this Company\'s chart of accounts';
    if (!a.isActive) return 'is inactive';
    if (!a.isPostable) return 'is not postable (a header account)';
    if (a.controlFunction) return `is a control account (${a.controlFunction})`;
    return null;
  }

  private warning(a: GLAccount, expected: string[]): string | null {
    return expected.includes(a.accountType) ? null : `Account type "${a.accountType}" is unusual for this setting (typical: ${expected.join(' / ')}).`;
  }

  private async entry(manager: EntityManager, code: string, expected: string[], reason: string | null): Promise<PolicyEntryView> {
    const a = await manager.getRepository(GLAccount).findOne({ where: { code } });
    const problem = this.problem(a);
    return { reason, code, status: problem ? 'invalid' : 'ok', problem: problem ? `Account "${code}" ${problem}.` : null, warning: a && !problem ? this.warning(a, expected) : null, account: a ? this.ref(a) : null };
  }

  private async view(def: PolicyKeyDef, manager: EntityManager): Promise<PolicyKeyView> {
    const raw = this.config.get<unknown>(def.key);
    const base = { key: def.key, group: def.group, kind: def.kind, expectedTypes: def.expectedTypes, code: null as string | null, problem: null as string | null, warning: null as string | null, account: null as PolicyAccountRef | null, entries: [] as PolicyEntryView[] };
    if (def.kind === 'account') {
      const code = typeof raw === 'string' ? raw.trim() : '';
      if (!code) return { ...base, status: 'unset' };
      const e = await this.entry(manager, code, def.expectedTypes, null);
      return { ...base, status: e.status, code, problem: e.problem, warning: e.warning, account: e.account };
    }
    const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const entries: PolicyEntryView[] = [];
    for (const [reason, v] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof v === 'string' && v.trim() !== '') entries.push(await this.entry(manager, v.trim(), def.expectedTypes, reason));
    }
    if (entries.length === 0) return { ...base, status: 'unset' };
    return { ...base, status: entries.some((e) => e.status === 'invalid') ? 'invalid' : 'ok', entries };
  }

  /** Every managed key with its current value and its status against THIS Company's chart. */
  async list(manager: EntityManager): Promise<PolicyKeyView[]> {
    const out: PolicyKeyView[] = [];
    for (const d of ACCOUNTING_POLICY_KEYS) out.push(await this.view(d, manager));
    return out;
  }

  /** Validates against the caller's Company chart (hard rules), then stores through the existing engine. Returns the refreshed view (with advisory warnings). */
  async set(key: string, value: unknown, actorUserId: string, manager: EntityManager): Promise<PolicyKeyView> {
    const def = this.def(key);
    let toStore: unknown;
    if (def.kind === 'account') {
      if (typeof value !== 'string' || value.trim() === '') throw new BadRequestException('An account code is required (use clear to remove the setting).');
      const e = await this.entry(manager, value.trim(), def.expectedTypes, null);
      if (e.status === 'invalid') throw new ConflictException(e.problem);
      toStore = value.trim();
    } else {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('A map of reason code → account code is required.');
      const clean: Record<string, string> = {};
      for (const [reason, code] of Object.entries(value as Record<string, unknown>)) {
        if (!REASON_CODE.test(reason)) throw new BadRequestException(`Reason code "${reason}" is invalid (letters, digits and underscore, max 40).`);
        if (typeof code !== 'string' || code.trim() === '') throw new BadRequestException(`Reason "${reason}" needs an account code.`);
        const e = await this.entry(manager, code.trim(), def.expectedTypes, reason);
        if (e.status === 'invalid') throw new ConflictException(`Reason "${reason}": ${e.problem}`);
        clean[reason] = code.trim();
      }
      if (Object.keys(clean).length === 0) throw new BadRequestException('At least one reason is required (use clear to remove the setting).');
      toStore = clean;
    }
    const before = this.config.get<unknown>(key);
    await this.config.set(key, INSTALLATION_SCOPE, toStore, { userId: actorUserId });
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'accounting.policy_config.updated', resource: 'config_key', resourceId: key, result: 'success', correlationId: null, before: { value: before ?? null }, after: { value: toStore as never } },
      manager,
    );
    return this.view(def, manager);
  }

  /** Removes the value (back to fail-closed). */
  async clear(key: string, actorUserId: string, manager: EntityManager): Promise<PolicyKeyView> {
    const def = this.def(key);
    const before = this.config.get<unknown>(key);
    await this.config.clear(key, INSTALLATION_SCOPE, { userId: actorUserId });
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'accounting.policy_config.cleared', resource: 'config_key', resourceId: key, result: 'success', correlationId: null, before: { value: before ?? null }, after: { value: null } },
      manager,
    );
    return this.view(def, manager);
  }
}
