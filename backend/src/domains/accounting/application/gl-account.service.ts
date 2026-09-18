import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource, EntityManager, FindOptionsWhere, ILike, IsNull } from 'typeorm';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { GLAccountDimensionRule } from '../infrastructure/gl-account-dimension-rule.entity';
import { FinancialDimensionType } from '../infrastructure/financial-dimension-type.entity';
import { FinancialDimensionValue } from '../infrastructure/financial-dimension-value.entity';
import { GLAccountType, deriveNormalBalance, isGLAccountType } from '../domain/gl-account-type';
import {
  AccountCurrencyMode,
  ControlFunction,
  DimensionRuleMode,
  SINGLETON_CONTROL_FUNCTIONS,
  isAccountCurrencyMode,
  isControlFunction,
  isDimensionRuleMode,
} from '../domain/control-function';
import { ACCOUNT_TEMPLATES, getAccountTemplate } from '../domain/account-templates/ifrs-sme.template';
import { CurrencyService } from './currency.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { LimitService } from '../../../foundation/limit-engine/limit.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { ENTITLEMENT_RESOLVER, EntitlementResolver } from '../../../foundation/module-registry/entitlement-resolver.token';

/** F11 (ADR-044 D9) — the feature this whole file's dimension-rule enforcement is gated by. */
const DIMENSIONS_FEATURE_CODE = 'accounting.financial_dimensions';

const MAX_GL_ACCOUNTS_LIMIT_KEY = 'accounting.max_gl_accounts';

export interface CreateGLAccountInput {
  code: string;
  name: string;
  /** Global UX Audit directive — optional Arabic name; render falls back to `name` when absent (see `GLAccount.nameAr`). */
  nameAr?: string | null;
  accountType: GLAccountType;
  isContra?: boolean;
  parentAccountId?: string | null;
  isPostable?: boolean;
  controlFunction?: ControlFunction | null;
  currencyMode?: AccountCurrencyMode;
  restrictCurrencyCode?: string | null;
  allowManualJournal?: boolean;
  orgUnitId?: string | null;
  description?: string | null;
}

export interface UpdateGLAccountInput {
  name?: string;
  nameAr?: string | null;
  description?: string | null;
  isActive?: boolean;
  isContra?: boolean;
  currencyMode?: AccountCurrencyMode;
  restrictCurrencyCode?: string | null;
  allowManualJournal?: boolean;
}

export interface DimensionRuleInput {
  dimensionTypeId: string;
  mode: DimensionRuleMode;
  defaultValueId?: string | null;
}

export interface AssertPostableOptions {
  businessDate: string;
  orgUnitId: string | null;
  currencyCode: string;
  dimensions?: Array<{ typeId: string; valueId: string | null }>;
  /** F03's event-driven poster passes `true` to bypass the `allowManualJournal` gate on control accounts. */
  systemPosting?: boolean;
}

export interface GLAccountTreeNode extends GLAccount {
  children: GLAccountTreeNode[];
}

export interface ImportTemplateResult {
  templateKey: string;
  dryRun: boolean;
  created: number;
  accounts: Array<{ code: string; name: string; nameAr: string; accountType: string; isPostable: boolean; parentCode: string | null }>;
}

/**
 * F02 — Chart of Accounts (Blueprint §3/§5, ADR-034). The GL account
 * master. **The CRUD is not the point — the accounting invariants are**
 * (Blueprint §22.4, CTO directive §4): every reject path fails closed.
 *
 * `normalBalance` is service-owned (ADR-034 D3) — always recomputed from
 * `accountType` + `isContra`, never taken from a caller.
 */
@Injectable()
export class GLAccountService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly limits: LimitService,
    private readonly organization: OrganizationService,
    private readonly currencies: CurrencyService,
    /** F11 (ADR-044 D9) — additive, optional (P1/P2-compatible: unbound resolver = always entitled, same convention `RequireFeatureGuard` already uses). */
    @Optional() @Inject(ENTITLEMENT_RESOLVER) private readonly entitlement?: EntitlementResolver,
  ) {}

  /** F11 (ADR-044 D9) — dimension-rule enforcement (this file) and posting-time resolution are both gated by this. Never gates reading already-persisted `JournalLineDimension` data (no read path calls this). */
  private dimensionsEntitled(): boolean {
    return this.entitlement?.isFeatureEntitled(DIMENSIONS_FEATURE_CODE) ?? true;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * `search` (Smart Lookup UX initiative — same canonical `?search=`
   * contract as `CustomersController`/`TreasuryController`): matches
   * code, name, OR nameAr, case-insensitive/partial. Expressed as an
   * array of `where` objects (each an OR branch, all sharing every other
   * AND-ed filter) since TypeORM's plain object `where` has no OR of its
   * own. Omitted, behaviour is unchanged.
   */
  async listAccounts(filter?: {
    accountType?: GLAccountType;
    postableOnly?: boolean;
    includeInactive?: boolean;
    parentAccountId?: string | null;
    search?: string;
  }): Promise<GLAccount[]> {
    const base: FindOptionsWhere<GLAccount> = {};
    if (filter?.accountType) base.accountType = filter.accountType;
    if (filter?.postableOnly) base.isPostable = true;
    if (!filter?.includeInactive) base.isActive = true;
    if (filter?.parentAccountId === null) base.parentAccountId = IsNull();
    else if (filter?.parentAccountId) base.parentAccountId = filter.parentAccountId;

    const search = filter?.search?.trim();
    const where: FindOptionsWhere<GLAccount> | FindOptionsWhere<GLAccount>[] = search
      ? [
          { ...base, code: ILike(`%${search}%`) },
          { ...base, name: ILike(`%${search}%`) },
          { ...base, nameAr: ILike(`%${search}%`) },
        ]
      : base;
    return this.dataSource.getRepository(GLAccount).find({ where, order: { code: 'ASC' } });
  }

  async getAccount(id: string): Promise<GLAccount> {
    const account = await this.dataSource.getRepository(GLAccount).findOne({ where: { id } });
    if (!account) throw new NotFoundException(`GL account "${id}" not found.`);
    return account;
  }

  async getAccountByCode(code: string): Promise<GLAccount> {
    const account = await this.dataSource.getRepository(GLAccount).findOne({ where: { code } });
    if (!account) throw new NotFoundException(`GL account with code "${code}" not found.`);
    return account;
  }

  async getTree(includeInactive = false): Promise<GLAccountTreeNode[]> {
    const all = await this.dataSource.getRepository(GLAccount).find({ order: { code: 'ASC' } });
    const visible = includeInactive ? all : all.filter((a) => a.isActive);
    const byId = new Map<string, GLAccountTreeNode>(visible.map((a) => [a.id, { ...a, children: [] }]));
    const roots: GLAccountTreeNode[] = [];
    for (const node of byId.values()) {
      if (node.parentAccountId && byId.has(node.parentAccountId)) {
        byId.get(node.parentAccountId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  listTemplates(): Array<{ key: string; titleEn: string; titleAr: string; description: string; accountCount: number }> {
    return ACCOUNT_TEMPLATES.map((t) => ({
      key: t.key,
      titleEn: t.titleEn,
      titleAr: t.titleAr,
      description: t.description,
      accountCount: t.accounts.length,
    }));
  }

  async getDimensionRules(accountId: string): Promise<GLAccountDimensionRule[]> {
    await this.getAccount(accountId);
    return this.dataSource.getRepository(GLAccountDimensionRule).find({ where: { accountId }, order: { createdAt: 'ASC' } });
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async createAccount(input: CreateGLAccountInput, actorUserId: string): Promise<GLAccount> {
    this.validateAccountType(input.accountType);
    const isContra = input.isContra ?? false;
    const currencyMode = input.currencyMode ?? 'functional_only';
    this.validateCurrencyMode(currencyMode);
    const restrictCurrencyCode = await this.resolveRestrictCurrency(currencyMode, input.restrictCurrencyCode ?? null);

    const isPostable = input.isPostable ?? true;
    const controlFunction = input.controlFunction ?? null;
    if (controlFunction !== null) {
      if (!isControlFunction(controlFunction)) throw new BadRequestException(`Unknown control function "${controlFunction}".`);
      if (!isPostable) throw new ConflictException('A control account must be postable — it cannot be a header/summary account.');
    }
    if (input.orgUnitId) await this.assertOrgUnitExists(input.orgUnitId);

    const gate = await this.limits.check(MAX_GL_ACCOUNTS_LIMIT_KEY);
    if (!gate.allowed) {
      throw new ConflictException(`GL account limit reached (${gate.max}) — cannot create another account.`);
    }

    const account = await this.dataSource.transaction(async (manager) => {
      if (input.parentAccountId) {
        const parent = await this.lockAccount(manager, input.parentAccountId);
        if (!parent) throw new NotFoundException(`Parent GL account "${input.parentAccountId}" not found.`);
        if (!parent.isActive) throw new ConflictException(`Parent GL account "${parent.code}" is inactive.`);
        if (parent.accountType !== input.accountType) {
          throw new ConflictException(
            `A child account's type ("${input.accountType}") must match its parent's type ("${parent.accountType}") — ADR-034 D5.`,
          );
        }
        if (parent.isPostable) {
          parent.isPostable = false;
          await manager.getRepository(GLAccount).save(parent);
          await this.audit.record(
            {
              actorUserId,
              organizationId: null,
              action: 'accounting.gl_account.auto_non_postable',
              resource: 'gl_account',
              resourceId: parent.id,
              result: 'success',
              correlationId: null,
              before: { isPostable: true },
              after: { isPostable: false, reason: 'child_account_added' },
            },
            manager,
          );
        }
      }

      if (controlFunction !== null && SINGLETON_CONTROL_FUNCTIONS.has(controlFunction)) {
        await this.assertSingletonControlFunctionFree(manager, controlFunction, null);
      }

      const repo = manager.getRepository(GLAccount);
      const entity = repo.create({
        code: input.code,
        name: input.name,
        nameAr: input.nameAr ?? null,
        accountType: input.accountType,
        normalBalance: deriveNormalBalance(input.accountType, isContra),
        isContra,
        parentAccountId: input.parentAccountId ?? null,
        isPostable,
        controlFunction,
        currencyMode,
        restrictCurrencyCode,
        allowManualJournal: controlFunction !== null ? false : (input.allowManualJournal ?? true),
        orgUnitId: input.orgUnitId ?? null,
        isActive: true,
        description: input.description ?? null,
      });

      let saved: GLAccount;
      try {
        saved = await repo.save(entity);
      } catch (err) {
        throw this.translateDbError(err, input.code);
      }

      const consumed = await this.limits.consume(MAX_GL_ACCOUNTS_LIMIT_KEY, 1, manager);
      if (!consumed.allowed) {
        throw new ConflictException(`GL account limit reached (${consumed.max}) — cannot create another account.`);
      }

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.gl_account.created',
          resource: 'gl_account',
          resourceId: saved.id,
          result: 'success',
          correlationId: null,
          after: { code: saved.code, accountType: saved.accountType, isPostable: saved.isPostable, controlFunction: saved.controlFunction },
        },
        manager,
      );
      await this.events.publish(manager, 'accounting.gl_account.created', {
        accountId: saved.id,
        code: saved.code,
        accountType: saved.accountType,
        isPostable: saved.isPostable,
        controlFunction: saved.controlFunction,
        actorUserId,
      });
      return saved;
    });

    return account;
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  async updateAccount(id: string, input: UpdateGLAccountInput, actorUserId: string): Promise<GLAccount> {
    return this.dataSource.transaction(async (manager) => {
      const account = await this.lockAccount(manager, id);
      if (!account) throw new NotFoundException(`GL account "${id}" not found.`);
      const before = { ...account };
      const changedFields: string[] = [];

      if (input.name !== undefined && input.name !== account.name) {
        account.name = input.name;
        changedFields.push('name');
      }
      if (input.nameAr !== undefined && (input.nameAr ?? null) !== account.nameAr) {
        account.nameAr = input.nameAr ?? null;
        changedFields.push('nameAr');
      }
      if (input.description !== undefined && (input.description ?? null) !== account.description) {
        account.description = input.description ?? null;
        changedFields.push('description');
      }

      if (input.isContra !== undefined && input.isContra !== account.isContra) {
        account.isContra = input.isContra;
        account.normalBalance = deriveNormalBalance(account.accountType, account.isContra);
        changedFields.push('isContra', 'normalBalance');
      }

      if (input.currencyMode !== undefined || input.restrictCurrencyCode !== undefined) {
        const nextMode = input.currencyMode ?? account.currencyMode;
        this.validateCurrencyMode(nextMode);
        const nextRestrict = await this.resolveRestrictCurrency(
          nextMode,
          input.restrictCurrencyCode !== undefined ? input.restrictCurrencyCode : account.restrictCurrencyCode,
        );
        if (nextMode !== account.currencyMode) changedFields.push('currencyMode');
        if (nextRestrict !== account.restrictCurrencyCode) changedFields.push('restrictCurrencyCode');
        account.currencyMode = nextMode;
        account.restrictCurrencyCode = nextRestrict;
      }

      if (input.allowManualJournal !== undefined && input.allowManualJournal !== account.allowManualJournal) {
        if (input.allowManualJournal && account.controlFunction !== null) {
          throw new ConflictException(
            `Account "${account.code}" is a control account (${account.controlFunction}) — manual journals cannot be enabled. Clear the control function first.`,
          );
        }
        account.allowManualJournal = input.allowManualJournal;
        changedFields.push('allowManualJournal');
      }

      let deactivated = false;
      let reactivated = false;
      if (input.isActive !== undefined && input.isActive !== account.isActive) {
        if (!input.isActive) {
          if (account.controlFunction !== null) {
            throw new ConflictException(
              `Account "${account.code}" is a control account (${account.controlFunction}) — clear the control function before deactivating.`,
            );
          }
          const activeChildren = await manager
            .getRepository(GLAccount)
            .count({ where: { parentAccountId: account.id, isActive: true } });
          if (activeChildren > 0) {
            throw new ConflictException(`Account "${account.code}" has ${activeChildren} active child account(s) — deactivate them first.`);
          }
          deactivated = true;
        } else {
          if (account.parentAccountId) {
            const parent = await manager.getRepository(GLAccount).findOne({ where: { id: account.parentAccountId } });
            if (parent && !parent.isActive) {
              throw new ConflictException(`Cannot activate "${account.code}" — its parent "${parent.code}" is inactive.`);
            }
          }
          reactivated = true;
        }
        account.isActive = input.isActive;
        changedFields.push('isActive');
      }

      if (changedFields.length === 0) return account;

      const saved = await manager.getRepository(GLAccount).save(account);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.gl_account.updated',
          resource: 'gl_account',
          resourceId: id,
          result: 'success',
          correlationId: null,
          before: { name: before.name, isActive: before.isActive, isContra: before.isContra, currencyMode: before.currencyMode },
          after: { name: saved.name, isActive: saved.isActive, isContra: saved.isContra, currencyMode: saved.currencyMode, changedFields },
        },
        manager,
      );
      await this.events.publish(manager, 'accounting.gl_account.updated', {
        accountId: id,
        code: saved.code,
        changedFields,
        actorUserId,
      });
      if (deactivated) {
        await this.events.publish(manager, 'accounting.gl_account.deactivated', { accountId: id, code: saved.code, actorUserId });
      }
      void reactivated;
      return saved;
    });
  }

  // ---------------------------------------------------------------------------
  // Reparent
  // ---------------------------------------------------------------------------

  async reparentAccount(id: string, newParentId: string | null, actorUserId: string): Promise<GLAccount> {
    return this.dataSource.transaction(async (manager) => {
      const account = await this.lockAccount(manager, id);
      if (!account) throw new NotFoundException(`GL account "${id}" not found.`);
      if (newParentId === id) throw new ConflictException('An account cannot be its own parent.');
      if ((account.parentAccountId ?? null) === (newParentId ?? null)) return account;

      if (newParentId) {
        const parent = await this.lockAccount(manager, newParentId);
        if (!parent) throw new NotFoundException(`New parent GL account "${newParentId}" not found.`);
        if (!parent.isActive) throw new ConflictException(`New parent GL account "${parent.code}" is inactive.`);
        if (parent.accountType !== account.accountType) {
          throw new ConflictException(
            `A child account's type ("${account.accountType}") must match its parent's type ("${parent.accountType}") — ADR-034 D5.`,
          );
        }
        await this.assertNoCycle(manager, id, newParentId);
        if (parent.isPostable) {
          parent.isPostable = false;
          await manager.getRepository(GLAccount).save(parent);
          await this.audit.record(
            {
              actorUserId,
              organizationId: null,
              action: 'accounting.gl_account.auto_non_postable',
              resource: 'gl_account',
              resourceId: parent.id,
              result: 'success',
              correlationId: null,
              before: { isPostable: true },
              after: { isPostable: false, reason: 'child_account_reparented_in' },
            },
            manager,
          );
        }
      }

      const before = account.parentAccountId;
      account.parentAccountId = newParentId;
      const saved = await manager.getRepository(GLAccount).save(account);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.gl_account.reparented',
          resource: 'gl_account',
          resourceId: id,
          result: 'success',
          correlationId: null,
          before: { parentAccountId: before },
          after: { parentAccountId: newParentId },
        },
        manager,
      );
      await this.events.publish(manager, 'accounting.gl_account.updated', {
        accountId: id,
        code: saved.code,
        changedFields: ['parentAccountId'],
        actorUserId,
      });
      return saved;
    });
  }

  // ---------------------------------------------------------------------------
  // Control function
  // ---------------------------------------------------------------------------

  async assignControlFunction(id: string, controlFunction: ControlFunction | null, actorUserId: string): Promise<GLAccount> {
    return this.dataSource.transaction(async (manager) => {
      const account = await this.lockAccount(manager, id);
      if (!account) throw new NotFoundException(`GL account "${id}" not found.`);
      const before = { controlFunction: account.controlFunction, allowManualJournal: account.allowManualJournal };

      if (controlFunction !== null) {
        if (!isControlFunction(controlFunction)) throw new BadRequestException(`Unknown control function "${controlFunction}".`);
        if (!account.isPostable) throw new ConflictException(`Account "${account.code}" is not postable — it cannot be a control account.`);
        if (!account.isActive) throw new ConflictException(`Account "${account.code}" is inactive — it cannot be a control account.`);
        if (SINGLETON_CONTROL_FUNCTIONS.has(controlFunction)) {
          await this.assertSingletonControlFunctionFree(manager, controlFunction, id);
        }
        account.controlFunction = controlFunction;
        account.allowManualJournal = false;
      } else {
        account.controlFunction = null;
        account.allowManualJournal = true;
      }

      let saved: GLAccount;
      try {
        saved = await manager.getRepository(GLAccount).save(account);
      } catch (err) {
        throw this.translateDbError(err, account.code);
      }
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.gl_account.control_function_assigned',
          resource: 'gl_account',
          resourceId: id,
          result: 'success',
          correlationId: null,
          before,
          after: { controlFunction: saved.controlFunction, allowManualJournal: saved.allowManualJournal },
        },
        manager,
      );
      await this.events.publish(manager, 'accounting.gl_account.updated', {
        accountId: id,
        code: saved.code,
        changedFields: ['controlFunction', 'allowManualJournal'],
        actorUserId,
      });
      return saved;
    });
  }

  // ---------------------------------------------------------------------------
  // Dimension rules (replace-set)
  // ---------------------------------------------------------------------------

  async replaceDimensionRules(accountId: string, rules: DimensionRuleInput[], actorUserId: string): Promise<GLAccountDimensionRule[]> {
    const account = await this.getAccount(accountId);

    const seenTypes = new Set<string>();
    for (const rule of rules) {
      if (!isDimensionRuleMode(rule.mode)) throw new BadRequestException(`Unknown dimension rule mode "${rule.mode}".`);
      if (seenTypes.has(rule.dimensionTypeId)) {
        throw new ConflictException(`Duplicate dimension rule for type "${rule.dimensionTypeId}".`);
      }
      seenTypes.add(rule.dimensionTypeId);

      const type = await this.dataSource.getRepository(FinancialDimensionType).findOne({ where: { id: rule.dimensionTypeId } });
      if (!type) throw new NotFoundException(`Financial dimension type "${rule.dimensionTypeId}" not found.`);
      if (!type.isActive) throw new ConflictException(`Financial dimension type "${type.code}" is inactive.`);

      if (rule.defaultValueId) {
        if (rule.mode === 'blocked') {
          throw new ConflictException(`A "blocked" dimension rule cannot carry a default value (type "${type.code}").`);
        }
        const value = await this.dataSource.getRepository(FinancialDimensionValue).findOne({ where: { id: rule.defaultValueId } });
        if (!value) throw new NotFoundException(`Financial dimension value "${rule.defaultValueId}" not found.`);
        if (value.dimensionTypeId !== rule.dimensionTypeId) {
          throw new ConflictException(`Dimension value "${value.code}" does not belong to type "${type.code}".`);
        }
        if (!value.isActive) throw new ConflictException(`Dimension value "${value.code}" is inactive.`);
      }
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(GLAccountDimensionRule);
      await repo.delete({ accountId });
      const created: GLAccountDimensionRule[] = [];
      for (const rule of rules) {
        created.push(
          await repo.save(
            repo.create({
              accountId,
              dimensionTypeId: rule.dimensionTypeId,
              mode: rule.mode,
              defaultValueId: rule.mode === 'blocked' ? null : (rule.defaultValueId ?? null),
            }),
          ),
        );
      }
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.gl_account.dimension_rules_replaced',
          resource: 'gl_account',
          resourceId: accountId,
          result: 'success',
          correlationId: null,
          after: { ruleCount: created.length, rules: created.map((r) => ({ dimensionTypeId: r.dimensionTypeId, mode: r.mode })) },
        },
        manager,
      );
      await this.events.publish(manager, 'accounting.gl_account.updated', {
        accountId,
        code: account.code,
        changedFields: ['dimensionRules'],
        actorUserId,
      });
      return created;
    });
  }

  // ---------------------------------------------------------------------------
  // Template import (opt-in, empty chart only)
  // ---------------------------------------------------------------------------

  async importTemplate(templateKey: string, dryRun: boolean, actorUserId: string): Promise<ImportTemplateResult> {
    const template = getAccountTemplate(templateKey);
    if (!template) throw new NotFoundException(`Account template "${templateKey}" not found.`);

    const existing = await this.dataSource.getRepository(GLAccount).count();
    if (existing > 0) {
      throw new ConflictException(`The chart of accounts is not empty (${existing} account(s)) — a template can only be imported into an empty chart.`);
    }

    const plan = template.accounts.map((a) => ({
      code: a.code,
      name: a.nameEn,
      nameAr: a.nameAr,
      accountType: a.accountType,
      isPostable: a.isPostable ?? true,
      parentCode: a.parentCode ?? null,
    }));

    if (dryRun) {
      return { templateKey, dryRun: true, created: 0, accounts: plan };
    }

    const gate = await this.limits.check(MAX_GL_ACCOUNTS_LIMIT_KEY, template.accounts.length);
    if (!gate.allowed) {
      throw new ConflictException(
        `Importing "${templateKey}" needs ${template.accounts.length} accounts but the GL account limit (${gate.max}) would be exceeded.`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(GLAccount);
      const codeToId = new Map<string, string>();
      for (const entry of template.accounts) {
        const parentAccountId = entry.parentCode ? codeToId.get(entry.parentCode) ?? null : null;
        if (entry.parentCode && !parentAccountId) {
          throw new BadRequestException(`Template "${templateKey}" is malformed: "${entry.code}" references unknown parent "${entry.parentCode}".`);
        }
        const isContra = entry.isContra ?? false;
        const controlFunction = entry.controlFunction ?? null;
        const isPostable = entry.isPostable ?? true;
        const saved = await repo.save(
          repo.create({
            code: entry.code,
            name: entry.nameEn,
            nameAr: entry.nameAr,
            accountType: entry.accountType,
            normalBalance: deriveNormalBalance(entry.accountType, isContra),
            isContra,
            parentAccountId,
            isPostable,
            controlFunction,
            currencyMode: 'functional_only',
            restrictCurrencyCode: null,
            allowManualJournal: controlFunction !== null ? false : true,
            orgUnitId: null,
            isActive: true,
            description: null,
          }),
        );
        codeToId.set(entry.code, saved.id);
        await this.events.publish(manager, 'accounting.gl_account.created', {
          accountId: saved.id,
          code: saved.code,
          accountType: saved.accountType,
          isPostable: saved.isPostable,
          controlFunction: saved.controlFunction,
          actorUserId,
        });
      }
      await this.limits.consume(MAX_GL_ACCOUNTS_LIMIT_KEY, template.accounts.length, manager);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.gl_account.template_imported',
          resource: 'chart_of_accounts',
          resourceId: templateKey,
          result: 'success',
          correlationId: null,
          after: { templateKey, accountCount: template.accounts.length },
        },
        manager,
      );
    });

    return { templateKey, dryRun: false, created: template.accounts.length, accounts: plan };
  }

  // ---------------------------------------------------------------------------
  // F03-facing precondition contract (Blueprint §5)
  // ---------------------------------------------------------------------------

  /**
   * The account half of "may a journal line be posted here?". F03 calls
   * this (and `FiscalPeriodService.assertOpenForPosting` for the period
   * half) before every write, instead of re-deriving account eligibility.
   * Every check fails closed — throws, never silently proceeds.
   */
  async assertPostable(accountId: string, opts: AssertPostableOptions): Promise<GLAccount> {
    const account = await this.dataSource.getRepository(GLAccount).findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException(`GL account "${accountId}" not found.`);
    if (!account.isActive) throw new ConflictException(`GL account "${account.code}" is inactive — posting is not possible.`);
    if (!account.isPostable) throw new ConflictException(`GL account "${account.code}" is a header/summary account — posting is not possible.`);
    if (!account.allowManualJournal && !opts.systemPosting) {
      throw new ConflictException(`GL account "${account.code}" does not accept manual journals (control account: ${account.controlFunction}).`);
    }

    // Currency mode
    if (account.currencyMode === 'functional_only') {
      const base = await this.currencies.getBaseCurrency();
      if (!base) throw new ConflictException('No base/functional currency is configured — posting is not possible.');
      if (opts.currencyCode !== base.code) {
        throw new ConflictException(`GL account "${account.code}" posts only in the functional currency (${base.code}), not "${opts.currencyCode}".`);
      }
    } else if (account.currencyMode === 'single_foreign') {
      if (opts.currencyCode !== account.restrictCurrencyCode) {
        throw new ConflictException(
          `GL account "${account.code}" is restricted to currency "${account.restrictCurrencyCode}", not "${opts.currencyCode}".`,
        );
      }
    }

    // Scope (ADR-031): global account, exact-scope match, or account scope is an ancestor of the posting scope.
    if (account.orgUnitId !== null) {
      let compatible = account.orgUnitId === opts.orgUnitId;
      if (!compatible && opts.orgUnitId) {
        const ancestors = await this.organization.getAncestorIds(opts.orgUnitId);
        compatible = ancestors.includes(account.orgUnitId);
      }
      if (!compatible) {
        throw new ConflictException(`GL account "${account.code}" is scoped to a different org unit than the posting — posting is not possible.`);
      }
    }

    // Dimension rules (F11, ADR-044 D9) — the ENTIRE block is skipped when the feature is not
    // entitled: no required/blocked enforcement, no value-existence/active/type-match validation.
    // This never touches reading already-persisted JournalLineDimension data on historical
    // entries — nothing here executes on any read path, only on this write-time gate.
    if (this.dimensionsEntitled()) {
      const rules = await this.dataSource.getRepository(GLAccountDimensionRule).find({ where: { accountId } });
      const provided = new Map<string, string | null>((opts.dimensions ?? []).map((d) => [d.typeId, d.valueId]));
      for (const rule of rules) {
        const hasValue = provided.has(rule.dimensionTypeId) && provided.get(rule.dimensionTypeId) != null;
        if (rule.mode === 'required' && !hasValue) {
          throw new ConflictException(`GL account "${account.code}" requires a value for dimension type "${rule.dimensionTypeId}".`);
        }
        if (rule.mode === 'blocked' && provided.has(rule.dimensionTypeId)) {
          throw new ConflictException(`GL account "${account.code}" does not allow dimension type "${rule.dimensionTypeId}".`);
        }
      }
      for (const [typeId, valueId] of provided) {
        if (valueId == null) continue;
        const value = await this.dataSource.getRepository(FinancialDimensionValue).findOne({ where: { id: valueId } });
        if (!value || value.dimensionTypeId !== typeId) {
          throw new ConflictException(`Dimension value "${valueId}" is not a valid value of type "${typeId}".`);
        }
        if (!value.isActive) throw new ConflictException(`Dimension value "${value.code}" is inactive.`);
      }
    }

    return account;
  }

  /**
   * F11 (ADR-044 D3/Mandatory Correction 1) — resolves the dimension set a line should carry:
   * every explicitly PROVIDED value, plus (for a `required` rule with no provided value) the
   * rule's own `defaultValueId` if one is configured. This does NOT persist anything and does NOT
   * validate — it only computes what `assertPostable` should then be asked to validate, and what
   * the caller (`JournalEntryService.postEntry`) should then persist if it wasn't already. Reusing
   * `assertPostable`'s existing required/blocked/value-validity logic for validation (unchanged)
   * is the whole point: this method's only job is building the correct input for it.
   *
   * When the feature is not entitled (D9), returns the provided values unchanged (no default
   * resolution) — matches `assertPostable`'s own "no enforcement at all" posture for the same case.
   */
  async resolveDimensions(
    accountId: string,
    provided: Array<{ typeId: string; valueId: string | null }>,
  ): Promise<Array<{ typeId: string; valueId: string }>> {
    const explicit = provided.filter((d): d is { typeId: string; valueId: string } => d.valueId != null);
    if (!this.dimensionsEntitled()) return explicit;

    const rules = await this.dataSource.getRepository(GLAccountDimensionRule).find({ where: { accountId } });
    const resolved = [...explicit];
    const providedTypeIds = new Set(explicit.map((d) => d.typeId));
    for (const rule of rules) {
      if (rule.mode === 'required' && !providedTypeIds.has(rule.dimensionTypeId) && rule.defaultValueId) {
        resolved.push({ typeId: rule.dimensionTypeId, valueId: rule.defaultValueId });
      }
    }
    return resolved;
  }

  /** F11 (ADR-044 D10) — used by the P&L implicit-policy check: an account's own explicit rule for a dimension type, whatever its mode, always takes precedence over the implicit policy. */
  async hasDimensionRule(accountId: string, dimensionTypeId: string): Promise<boolean> {
    const rule = await this.dataSource.getRepository(GLAccountDimensionRule).findOne({ where: { accountId, dimensionTypeId } });
    return !!rule;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private validateAccountType(accountType: string): void {
    if (!isGLAccountType(accountType)) throw new BadRequestException(`Unknown account type "${accountType}".`);
  }

  private validateCurrencyMode(mode: string): void {
    if (!isAccountCurrencyMode(mode)) throw new BadRequestException(`Unknown currency mode "${mode}".`);
  }

  private async resolveRestrictCurrency(mode: AccountCurrencyMode, restrictCurrencyCode: string | null): Promise<string | null> {
    if (mode === 'single_foreign') {
      if (!restrictCurrencyCode) throw new BadRequestException('currencyMode "single_foreign" requires a restrictCurrencyCode.');
      const currency = await this.currencies.getCurrency(restrictCurrencyCode); // throws NotFound if unknown
      if (currency.isBaseCurrency) {
        throw new ConflictException('restrictCurrencyCode cannot be the base/functional currency — use currencyMode "functional_only".');
      }
      return restrictCurrencyCode;
    }
    return null;
  }

  private async assertOrgUnitExists(orgUnitId: string): Promise<void> {
    const units = await this.organization.listUnits();
    if (!units.some((u) => u.id === orgUnitId)) {
      throw new NotFoundException(`Org unit "${orgUnitId}" not found.`);
    }
  }

  private async lockAccount(manager: EntityManager, id: string): Promise<GLAccount | null> {
    const rows = await manager.getRepository(GLAccount).find({ where: { id }, lock: { mode: 'pessimistic_write' } });
    return rows[0] ?? null;
  }

  private async assertNoCycle(manager: EntityManager, movingId: string, newParentId: string): Promise<void> {
    const repo = manager.getRepository(GLAccount);
    let cursor: string | null = newParentId;
    const guard = new Set<string>();
    while (cursor) {
      if (cursor === movingId) {
        throw new ConflictException('Reparenting would create a cycle in the account hierarchy.');
      }
      if (guard.has(cursor)) break; // pre-existing cycle safety — should never happen
      guard.add(cursor);
      const parent: GLAccount | null = await repo.findOne({ where: { id: cursor } });
      cursor = parent?.parentAccountId ?? null;
    }
  }

  private async assertSingletonControlFunctionFree(
    manager: EntityManager,
    controlFunction: ControlFunction,
    exceptAccountId: string | null,
  ): Promise<void> {
    const existing = await manager.getRepository(GLAccount).find({ where: { controlFunction } });
    const clash = existing.find((a) => a.id !== exceptAccountId);
    if (clash) {
      throw new ConflictException(`A "${controlFunction}" control account already exists ("${clash.code}") — only one is allowed per chart (ADR-034 D4).`);
    }
  }

  private translateDbError(err: unknown, code: string): Error {
    const message = err instanceof Error ? err.message : String(err);
    if (/IDX_accounting_gl_accounts_one_retained_earnings/i.test(message)) {
      return new ConflictException('A retained-earnings control account already exists — only one is allowed per chart (ADR-034 D4).');
    }
    if (/duplicate key value violates unique constraint/i.test(message) || /IDX_accounting_gl_accounts_code/i.test(message)) {
      return new ConflictException(`A GL account with code "${code}" already exists.`);
    }
    return err instanceof Error ? err : new Error(message);
  }
}
