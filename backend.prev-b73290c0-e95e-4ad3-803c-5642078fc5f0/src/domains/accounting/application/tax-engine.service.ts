import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TaxCode } from '../infrastructure/tax-code.entity';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { TaxCalculationResult, TaxEngineContract } from '../../../foundation/module-registry/contracts/tax-engine.contract';

/**
 * F10 (ADR-043 D1/D3/D5). Tax Definition + Calculation, owned by
 * `accounting`. Bound to `TAX_ENGINE_CONTRACT` in `tax-engine.module.ts` —
 * see that file's own doc comment for why this is a SEPARATE small module
 * rather than living inside `AccountingModule` (avoids a real NestJS
 * import cycle with `CustomerFinanceModule`).
 *
 * Pure calculation service: reads `accounting_tax_codes` and the
 * `accounting.default_tax_code` config key, writes nothing, never touches
 * the GL/Financial Event Engine (D1 — "the Tax Engine never posts to the
 * GL directly"). `FinancialEventService`'s handlers (`handleInvoicePosted`
 * etc.) must NEVER inject or call this service — recognition reads only
 * the already-stored payload amount (D3).
 */
@Injectable()
export class TaxEngineService implements TaxEngineContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigurationEngineService,
  ) {}

  private isEffective(taxCode: TaxCode, today: string): boolean {
    if (!taxCode.isActive) return false;
    if (taxCode.effectiveFrom && taxCode.effectiveFrom > today) return false;
    if (taxCode.effectiveTo && taxCode.effectiveTo < today) return false;
    return true;
  }

  private async resolveTaxCode(explicitTaxCodeId: string | null | undefined): Promise<TaxCode | null> {
    const repo = this.dataSource.getRepository(TaxCode);
    const today = new Date().toISOString().slice(0, 10);

    if (explicitTaxCodeId) {
      const explicit = await repo.findOne({ where: { id: explicitTaxCodeId } });
      if (explicit && this.isEffective(explicit, today)) return explicit;
      return null; // an explicit-but-unresolvable code is treated as "no tax", never a hard failure (Blueprint §3 D3)
    }

    const defaultCode = this.config.get<string>('accounting.default_tax_code');
    if (!defaultCode) return null;
    const byCode = await repo.findOne({ where: { code: defaultCode } });
    if (byCode && this.isEffective(byCode, today)) return byCode;
    return null;
  }

  async calculateForInvoice(baseAmount: string, explicitTaxCodeId?: string | null): Promise<TaxCalculationResult> {
    const taxCode = await this.resolveTaxCode(explicitTaxCodeId ?? null);
    if (!taxCode) return { taxCodeId: null, taxAmount: '0.00' };

    const base = Number(baseAmount);
    const rate = Number(taxCode.rate) / 100;
    let taxAmount: number;
    if (taxCode.isInclusive) {
      // baseAmount is GROSS (already contains tax): net = gross / (1 + rate), tax = gross - net.
      const net = base / (1 + rate);
      taxAmount = base - net;
    } else {
      // baseAmount is NET (tax-exclusive): tax = net * rate.
      taxAmount = base * rate;
    }
    return { taxCodeId: taxCode.id, taxAmount: taxAmount.toFixed(2) };
  }

  async resolveTaxAccountCode(taxCodeId: string | null): Promise<string | null> {
    if (!taxCodeId) return null;
    const taxCode = await this.dataSource.getRepository(TaxCode).findOne({ where: { id: taxCodeId } });
    return taxCode?.accountMappingRef ?? null;
  }
}
