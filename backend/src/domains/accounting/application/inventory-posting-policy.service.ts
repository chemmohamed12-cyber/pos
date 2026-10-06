import { BadRequestException, ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { InventoryPostingPolicy, InventoryPostingPolicyRegistry, SaleReturnPostableInput, SupplierInvoicePostableInput } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { GLAccount } from '../infrastructure/gl-account.entity';

export const MANUAL_RECEIPT_REASON_ACCOUNTS_KEY = 'accounting.inventory_manual_receipt_reason_accounts';
const COGS_ACCOUNT_KEY = 'accounting.inventory_cogs_account_code';
const SALES_RETURNS_ACCOUNT_KEY = 'accounting.sales_returns_account_code';
const PPV_ACCOUNT_KEY = 'accounting.purchase_price_variance_account_code';

/**
 * D3-B (2026-10-04, CTO-approved) — the pre-mutation gate of a MANUAL receipt: the reason code must be a controlled
 * code that has a configured Offset GL account (`accounting.inventory_manual_receipt_reason_accounts`, a JSON map
 * `reasonCode → glAccountCode`), and that account must exist, be active, postable and carry no control function.
 * Anything else is rejected BEFORE stock/valuation is touched — no fallback account, no free-text reason, no guess.
 * The same validation is repeated at event time by the costing handler (config may change in between).
 */
@Injectable()
export class InventoryPostingPolicyService implements InventoryPostingPolicy, OnModuleInit {
  constructor(
    private readonly config: ConfigurationEngineService,
    private readonly registry: InventoryPostingPolicyRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.bind(this);
  }

  private reasonMap(): Record<string, string> {
    const raw = this.config.get<unknown>(MANUAL_RECEIPT_REASON_ACCOUNTS_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim();
    }
    return out;
  }

  listManualReceiptReasons(): string[] {
    return Object.keys(this.reasonMap()).sort();
  }

  /** Account fails the "exists / active / postable / non-control" test → the reason, else null. Same rule as `HandlerContext.resolveConfiguredPostableAccount`. */
  private accountProblem(acc: GLAccount | null): string | null {
    if (!acc) return 'does not exist in the chart of accounts';
    if (!acc.isActive) return 'is inactive';
    if (!acc.isPostable) return 'is not postable';
    if (acc.controlFunction) return 'is a control account';
    return null;
  }

  /**
   * D4 (2026-10-05) — pre-mutation gate of a financial sale return. Mirrors EXACTLY what the two journals will resolve at
   * event time (`InventoryCostingHandlerService` `return_in` and `handleSalesReturnCredited`), so a missing dependency is
   * rejected BEFORE any stock, valuation, ledger or outbox write — not discovered afterwards.
   */
  async assertSaleReturnPostable(input: SaleReturnPostableInput, manager?: EntityManager): Promise<void> {
    if (!manager) throw new Error('InventoryPostingPolicyService: a Company EntityManager is required to validate sale-return accounts');
    const accounts = manager.getRepository(GLAccount);

    const inventory = await accounts.findOne({ where: { controlFunction: 'inventory', isActive: true, isPostable: true } });
    if (!inventory) throw new ConflictException('A sale return cannot post: no active postable account has the "inventory" control function');

    const cogsCode = String(this.config.get<unknown>(COGS_ACCOUNT_KEY) ?? '').trim();
    if (!cogsCode) throw new ConflictException(`A sale return cannot post: the COGS account is not configured — set ${COGS_ACCOUNT_KEY}`);
    const cogsProblem = this.accountProblem(await accounts.findOne({ where: { code: cogsCode } }));
    if (cogsProblem) throw new ConflictException(`A sale return cannot post: the configured COGS account ${cogsCode} (${COGS_ACCOUNT_KEY}) ${cogsProblem}`);

    if (!input.invoiceId) return; // original sale created no Revenue/AR → inventory/COGS only

    const srCode = String(this.config.get<unknown>(SALES_RETURNS_ACCOUNT_KEY) ?? '').trim();
    if (!srCode) throw new ConflictException(`A sale return of an invoiced sale cannot post: the Sales Returns account is not configured — set ${SALES_RETURNS_ACCOUNT_KEY}`);
    const srProblem = this.accountProblem(await accounts.findOne({ where: { code: srCode } }));
    if (srProblem) throw new ConflictException(`A sale return of an invoiced sale cannot post: the configured Sales Returns account ${srCode} (${SALES_RETURNS_ACCOUNT_KEY}) ${srProblem}`);

    const originals: Array<{ payload: Record<string, unknown> }> = await manager.query(
      `SELECT "payload" FROM "accounting_financial_events"
        WHERE "eventType" = 'finance.invoice.posted' AND "sourceEntityId" = $1 AND "status" = 'POSTED'
        ORDER BY "receivedAt" DESC LIMIT 1`,
      [input.invoiceId],
    );
    if (originals.length === 0) {
      throw new ConflictException(`A sale return cannot post: the original invoice ${input.invoiceId} has no POSTED GL event — there is no Revenue/AR to reverse`);
    }
    const original = originals[0].payload ?? {};

    const resolveByHintOrControl = async (hint: unknown, fn: 'ar' | 'tax_payable') => {
      const code = typeof hint === 'string' ? hint.trim() : '';
      if (code) {
        const byCode = await accounts.findOne({ where: { code, isActive: true } });
        if (byCode) return byCode;
      }
      return accounts.findOne({ where: { controlFunction: fn, isActive: true, isPostable: true } });
    };
    if (!(await resolveByHintOrControl(original.arAccountCode, 'ar'))) {
      throw new ConflictException('A sale return of an invoiced sale cannot post: no AR account resolves (original hint or "ar" control account)');
    }
    if (Number(input.taxAmount) > 0 && !(await resolveByHintOrControl(original.taxAccountCode, 'tax_payable'))) {
      throw new ConflictException('A sale return with a tax part cannot post: no tax account resolves (original tax account or "tax_payable" control account)');
    }
  }

  /**
   * D5 (2026-10-05) — pre-flight of a supplier invoice posting. Mirrors EXACTLY what `handleSupplierInvoicePosted` resolves at
   * event time, so a missing dependency is rejected BEFORE the ledger credit / state change / outbox write.
   */
  async assertSupplierInvoicePostable(input: SupplierInvoicePostableInput, manager?: EntityManager): Promise<void> {
    if (!manager) throw new Error('InventoryPostingPolicyService: a Company EntityManager is required to validate supplier-invoice accounts');
    const accounts = manager.getRepository(GLAccount);

    if (!(await accounts.findOne({ where: { controlFunction: 'grni', isActive: true, isPostable: true } }))) {
      throw new ConflictException('A supplier invoice cannot post: no active postable account has the "grni" control function');
    }
    if (!(await accounts.findOne({ where: { controlFunction: 'ap', isActive: true, isPostable: true } }))) {
      throw new ConflictException('A supplier invoice cannot post: no active postable account has the "ap" control function');
    }

    if (Number(input.ppvBase) !== 0) {
      const code = String(this.config.get<unknown>(PPV_ACCOUNT_KEY) ?? '').trim();
      if (!code) throw new ConflictException(`A supplier invoice with a price variance cannot post: the PPV account is not configured — set ${PPV_ACCOUNT_KEY}`);
      const problem = this.accountProblem(await accounts.findOne({ where: { code } }));
      if (problem) throw new ConflictException(`A supplier invoice with a price variance cannot post: the configured PPV account ${code} (${PPV_ACCOUNT_KEY}) ${problem}`);
    }

    if (Number(input.taxAmount) > 0) {
      const vat = await accounts.find({ where: { controlFunction: 'tax_receivable', isActive: true, isPostable: true }, take: 2 });
      if (vat.length === 0) throw new ConflictException('A supplier invoice with VAT cannot post: no active postable account has the "tax_receivable" (Input VAT) control function');
      if (vat.length > 1) throw new ConflictException('A supplier invoice with VAT cannot post: more than one active postable "tax_receivable" account exists — Input VAT would be ambiguous');
    }
  }

  async assertManualReceiptReason(reasonCode: string, manager?: EntityManager): Promise<{ glAccountCode: string }> {
    const code = (reasonCode ?? '').trim();
    if (!code) throw new BadRequestException('A manual receipt requires a reason code');
    const glAccountCode = this.reasonMap()[code];
    if (!glAccountCode) {
      throw new ConflictException(
        `Manual-receipt reason "${code}" has no configured offset GL account — map it in ${MANUAL_RECEIPT_REASON_ACCOUNTS_KEY} first`,
      );
    }
    if (!manager) throw new Error('InventoryPostingPolicyService: a Company EntityManager is required to validate the offset account');
    const acc = await manager.getRepository(GLAccount).findOne({ where: { code: glAccountCode } });
    const problem = !acc
      ? 'does not exist in the chart of accounts'
      : !acc.isActive
        ? 'is inactive'
        : !acc.isPostable
          ? 'is not postable'
          : acc.controlFunction
            ? 'is a control account'
            : null;
    if (problem) {
      throw new ConflictException(`Manual-receipt reason "${code}" maps to GL account ${glAccountCode}, which ${problem}`);
    }
    return { glAccountCode };
  }
}
