import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, LessThanOrEqual } from 'typeorm';
import { Currency } from '../infrastructure/currency.entity';
import { ExchangeRate } from '../infrastructure/exchange-rate.entity';
import { FiscalYear } from '../infrastructure/fiscal-year.entity';
import { CurrencyRoundingMode } from '../domain/currency-rounding-mode';
import { AuditService } from '../../../foundation/audit/audit.service';

export interface CreateCurrencyInput {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces?: number;
  roundingMode?: CurrencyRoundingMode;
  roundingIncrement?: string | null;
  isBaseCurrency?: boolean;
}

/**
 * F01 — Financial Foundation (Blueprint §3.1/§3.2/§17). "Exactly one base
 * currency" is enforced by an atomic flip inside one transaction (clear
 * every other row, then set the target) — no separate lock needed since
 * both statements run inside the same transaction.
 */
@Injectable()
export class CurrencyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async createCurrency(input: CreateCurrencyInput, actorUserId: string): Promise<Currency> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Currency);
      if (input.isBaseCurrency) {
        await repo.update({ isBaseCurrency: true }, { isBaseCurrency: false });
      }
      const saved = await repo.save(
        repo.create({
          code: input.code,
          name: input.name,
          symbol: input.symbol,
          decimalPlaces: input.decimalPlaces ?? 2,
          roundingMode: input.roundingMode ?? 'half_up',
          roundingIncrement: input.roundingIncrement ?? null,
          isActive: true,
          isBaseCurrency: !!input.isBaseCurrency,
        }),
      );
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.currency.created',
          resource: 'currency',
          resourceId: saved.code,
          result: 'success',
          correlationId: null,
          after: { code: saved.code, isBaseCurrency: saved.isBaseCurrency },
        },
        manager,
      );
      return saved;
    });
  }

  async listCurrencies(): Promise<Currency[]> {
    return this.dataSource.getRepository(Currency).find({ order: { code: 'ASC' } });
  }

  async getCurrency(code: string): Promise<Currency> {
    const currency = await this.dataSource.getRepository(Currency).findOne({ where: { code } });
    if (!currency) throw new NotFoundException(`Currency "${code}" not found.`);
    return currency;
  }

  async getBaseCurrency(): Promise<Currency | null> {
    return this.dataSource.getRepository(Currency).findOne({ where: { isBaseCurrency: true } });
  }

  /**
   * `accounting.base_currency_locked_after_first_year` (config key,
   * default locked=true) — enforcement uses the config's own stated
   * default directly rather than a live `ConfigurationEngineService`
   * read: no Business Domain in this codebase consumes that engine's
   * values yet (verified before writing this), and wiring the first such
   * consumption deserves its own deliberate pass, not one folded into
   * F01. Disclosed simplification, not a silent shortcut.
   */
  async setBaseCurrency(code: string, actorUserId: string): Promise<Currency> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Currency);
      const target = await repo.findOne({ where: { code } });
      if (!target) throw new NotFoundException(`Currency "${code}" not found.`);

      // ADR-048 correctness fix (2026-09-17): the lock's own intent (its error message, its config
      // key name `base_currency_locked_after_first_year`) is "don't let anyone CHANGE the base
      // currency once real fiscal activity may exist under the OLD one" — it must not also block
      // designating the FIRST-EVER base currency, which invalidates nothing (there was no base
      // currency for anything to have posted against). The previous unconditional
      // `fiscalYearCount > 0` check conflated the two: an installation where a fiscal year was
      // created before Foundation currency setup ever completed (an environment/setup-ordering
      // mistake, not fiscal activity in a real base currency) could never configure one through any
      // legitimate application mechanism again — `createCurrency` has no update path for a
      // currency that already exists, and this was the only other one. Only a genuine
      // already-active base currency being REPLACED by a different one still requires zero
      // fiscal years to exist.
      const currentBase = await repo.findOne({ where: { isBaseCurrency: true } });
      const isRealChange = currentBase != null && currentBase.code !== code;
      if (isRealChange) {
        const fiscalYearCount = await manager.getRepository(FiscalYear).count();
        if (fiscalYearCount > 0) {
          throw new ConflictException(
            'The base/functional currency cannot be changed once a fiscal year exists (accounting.base_currency_locked_after_first_year).',
          );
        }
      }

      await repo.update({ isBaseCurrency: true }, { isBaseCurrency: false });
      target.isBaseCurrency = true;
      const saved = await repo.save(target);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.currency.base_changed',
          resource: 'currency',
          resourceId: code,
          result: 'success',
          correlationId: null,
          after: { code },
        },
        manager,
      );
      return saved;
    });
  }

  async deactivateCurrency(code: string, actorUserId: string): Promise<Currency> {
    const currency = await this.getCurrency(code);
    if (currency.isBaseCurrency) {
      throw new ConflictException('The base/functional currency cannot be deactivated.');
    }
    currency.isActive = false;
    const saved = await this.dataSource.getRepository(Currency).save(currency);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.currency.deactivated',
      resource: 'currency',
      resourceId: code,
      result: 'success',
      correlationId: null,
    });
    return saved;
  }

  async recordExchangeRate(
    currencyCode: string,
    rateDate: string,
    rate: string,
    rateSource: 'manual' | 'api',
    actorUserId: string,
  ): Promise<ExchangeRate> {
    const currency = await this.getCurrency(currencyCode);
    if (currency.isBaseCurrency) {
      throw new ConflictException('The base/functional currency has no exchange rate against itself.');
    }
    const repo = this.dataSource.getRepository(ExchangeRate);
    const saved = await repo.save(repo.create({ currencyCode, rateDate, rate, rateSource, createdByUserId: actorUserId }));
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.exchange_rate.recorded',
      resource: 'exchange_rate',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { currencyCode, rateDate, rate },
    });
    return saved;
  }

  async listExchangeRates(currencyCode: string): Promise<ExchangeRate[]> {
    return this.dataSource.getRepository(ExchangeRate).find({ where: { currencyCode }, order: { rateDate: 'DESC' } });
  }

  /**
   * Blueprint §3.2 — "most recent rate on or before the requested date."
   * Fails closed: no rate found is a thrown error, never a silent 1.0
   * fallback.
   */
  async getRateOnOrBefore(currencyCode: string, date: string): Promise<ExchangeRate> {
    const rows = await this.dataSource
      .getRepository(ExchangeRate)
      .find({ where: { currencyCode, rateDate: LessThanOrEqual(date) }, order: { rateDate: 'DESC' }, take: 1 });
    if (rows.length === 0) {
      throw new NotFoundException(`No exchange rate recorded for "${currencyCode}" on or before "${date}".`);
    }
    return rows[0];
  }
}
