import { BadRequestException, ConflictException, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { FinancialPostingSummary, InventoryPostingPolicy, InventoryPostingPolicyRegistry, SaleReturnPostableInput, SupplierInvoicePostableInput } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { FiscalPeriodService } from './fiscal-period.service';
import { PostingStatusService } from './posting-status.service';

export const MANUAL_RECEIPT_REASON_ACCOUNTS_KEY = 'accounting.inventory_manual_receipt_reason_accounts';
const COGS_ACCOUNT_KEY = 'accounting.inventory_cogs_account_code';
const OPENING_BALANCE_ACCOUNT_KEY = 'accounting.inventory_opening_balance_account_code';
const OPENING_CORRECTION_ACCOUNT_KEY = 'accounting.inventory_opening_correction_account_code';
const SALES_RETURNS_ACCOUNT_KEY = 'accounting.sales_returns_account_code';
const PPV_ACCOUNT_KEY = 'accounting.purchase_price_variance_account_code';
const COST_DIFFERENCE_AFTER_RECEIPT_KEY = 'accounting.purchase_cost_difference_after_receipt_account_code';
const OTHER_CHARGES_ACCOUNT_KEY = 'accounting.purchase_other_charges_account_code';
const RETURN_COST_DIFFERENCE_KEY = 'accounting.purchase_return_cost_difference_account_code';

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
    // C2: optional so a direct construction (older specs) keeps compiling; Nest always provides both.
    @Optional() private readonly fiscalPeriods?: FiscalPeriodService,
    @Optional() private readonly postingStatus?: PostingStatusService,
  ) {}

  /** C4 - see the registry: the accounts an opening batch of this kind will post to must resolve, fail-closed, before anything is written. */
  async assertOpeningBatchPostable(kind: 'opening' | 'reversal' | 'correction', manager?: EntityManager): Promise<void> {
    if (!manager) throw new Error('InventoryPostingPolicyService: a Company EntityManager is required to validate opening-batch accounts');
    const accounts = manager.getRepository(GLAccount);
    const inventory = await accounts.findOne({ where: { controlFunction: 'inventory', isActive: true, isPostable: true } });
    if (!inventory) throw new ConflictException('An opening batch cannot post: no active postable account has the "inventory" control function');
    const key = kind === 'correction' ? OPENING_CORRECTION_ACCOUNT_KEY : OPENING_BALANCE_ACCOUNT_KEY;
    const code = String(this.config.get<unknown>(key) ?? '').trim();
    if (!code) throw new ConflictException(`An opening batch (${kind}) cannot post: the account is not configured - set ${key}`);
    const acc = await accounts.findOne({ where: { code } });
    const problem = this.accountProblem(acc);
    if (problem) throw new ConflictException(`An opening batch (${kind}) cannot post: the configured account ${code} (${key}) ${problem}`);
    if (kind === 'correction' && acc!.accountType !== 'equity') {
      throw new ConflictException(`An opening correction cannot post: the configured account ${code} (${key}) is "${acc!.accountType}", not equity - a correction must never go through profit and loss`);
    }
  }

  /** C2 - the explicit business date must fall in an open fiscal period; same gate the journal posting itself applies later (org-unit-less, like the inventory events). */
  async assertPostingDateOpen(businessDate: string, manager?: EntityManager): Promise<void> {
    if (!this.fiscalPeriods) return;
    await this.fiscalPeriods.assertOpenForPosting(null, businessDate, manager);
  }

  async financialStatusByReference(referenceType: string, referenceId: string, manager?: EntityManager): Promise<FinancialPostingSummary> {
    if (!this.postingStatus) return 'none';
    return (await this.postingStatus.getFinancialStatusByReference(referenceType, referenceId, manager)).summary;
  }

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

    // Phase C-2 (owner decisions E1 / D3): a discount or capitalised freight needs the inventory account and the separate cost-difference account; expensed charges need their own expense account.
    if (Number(input.discountAmount ?? 0) > 0 || Number(input.capitalizedFreight ?? 0) > 0) {
      if (!(await accounts.findOne({ where: { controlFunction: 'inventory', isActive: true, isPostable: true } }))) {
        throw new ConflictException('A supplier invoice with a discount or capitalised freight cannot post: no active postable account has the "inventory" control function');
      }
      const code = String(this.config.get<unknown>(COST_DIFFERENCE_AFTER_RECEIPT_KEY) ?? '').trim();
      if (!code) throw new ConflictException(`A supplier invoice with a discount or capitalised freight cannot post: the purchase cost differences after receipt account is not configured — ask the finance owner to assign it (${COST_DIFFERENCE_AFTER_RECEIPT_KEY})`);
      const problem = this.accountProblem(await accounts.findOne({ where: { code } }));
      if (problem) throw new ConflictException(`A supplier invoice with a discount or capitalised freight cannot post: the configured account ${code} (${COST_DIFFERENCE_AFTER_RECEIPT_KEY}) ${problem}`);
    }
    if (Number(input.expensedCharges ?? 0) > 0) {
      const code = String(this.config.get<unknown>(OTHER_CHARGES_ACCOUNT_KEY) ?? '').trim();
      if (!code) throw new ConflictException(`A supplier invoice with non-capitalised charges cannot post: the purchase charges expense account is not configured — ask the finance owner to assign it (${OTHER_CHARGES_ACCOUNT_KEY})`);
      const problem = this.accountProblem(await accounts.findOne({ where: { code } }));
      if (problem) throw new ConflictException(`A supplier invoice with non-capitalised charges cannot post: the configured account ${code} (${OTHER_CHARGES_ACCOUNT_KEY}) ${problem}`);
    }

    if (Number(input.taxAmount) > 0) {
      const vat = await accounts.find({ where: { controlFunction: 'tax_receivable', isActive: true, isPostable: true }, take: 2 });
      if (vat.length === 0) throw new ConflictException('A supplier invoice with VAT cannot post: no active postable account has the "tax_receivable" (Input VAT) control function');
      if (vat.length > 1) throw new ConflictException('A supplier invoice with VAT cannot post: more than one active postable "tax_receivable" account exists — Input VAT would be ambiguous');
    }
  }

  /** Phase D-1 (D7 / E3): see the registry. */
  async assertPurchaseReturnPostable(input: { expectedDifference: string; creditNet?: string; creditTax?: string }, manager?: EntityManager): Promise<void> {
    if (!manager) throw new Error('InventoryPostingPolicyService: a Company EntityManager is required to validate purchase-return accounts');
    const accounts = manager.getRepository(GLAccount);
    if (!(await accounts.findOne({ where: { controlFunction: 'inventory', isActive: true, isPostable: true } }))) {
      throw new ConflictException('A purchase return cannot post: no active postable account has the "inventory" control function');
    }
    if (!(await accounts.findOne({ where: { controlFunction: 'grni', isActive: true, isPostable: true } }))) {
      throw new ConflictException('A purchase return cannot post: no active postable account has the "grni" control function');
    }
    // phase D-3: a return of INVOICED goods credits Accounts payable (and Input VAT)
    if (Number(input.creditNet ?? 0) > 0 && !(await accounts.findOne({ where: { controlFunction: 'ap', isActive: true, isPostable: true } }))) {
      throw new ConflictException('A return of invoiced goods cannot post: no active postable account has the "ap" control function');
    }
    if (Number(input.creditTax ?? 0) > 0) {
      const vat = await accounts.find({ where: { controlFunction: 'tax_receivable', isActive: true, isPostable: true }, take: 2 });
      if (vat.length !== 1) throw new ConflictException('A return of invoiced goods with VAT cannot post: exactly one active postable "tax_receivable" (Input VAT) account must exist');
    }
    if (Math.abs(Number(input.expectedDifference)) > 0.00005) {
      const code = String(this.config.get<unknown>(RETURN_COST_DIFFERENCE_KEY) ?? '').trim();
      if (!code) throw new ConflictException(`A purchase return whose book cost differs from the receipt cost cannot post: the supplier return cost differences account is not configured — ask the finance owner to assign it (${RETURN_COST_DIFFERENCE_KEY})`);
      const problem = this.accountProblem(await accounts.findOne({ where: { code } }));
      if (problem) throw new ConflictException(`A purchase return cannot post: the configured account ${code} (${RETURN_COST_DIFFERENCE_KEY}) ${problem}`);
    }
  }

  async assertManualReceiptReason(reasonCode: string, manager?: EntityManager): Promise<{ glAccountCode: string }> {
    const code = (reasonCode ?? '').trim();
    if (!code) throw new BadRequestException('A manual receipt requires a reason code');
    // C4 (ADR-INV-01 section 2.2.8): once the opening-batch cut-over flag is on, the reason `opening_balance` is RESERVED for an Opening Balance Batch.
    if (code.toLowerCase() === 'opening_balance' && this.config.get<unknown>('inventory.opening_batch_required') === true) {
      throw new ConflictException('The reason "opening_balance" is reserved for Opening Balance Batches; a manual receipt cannot use it.');
    }
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
