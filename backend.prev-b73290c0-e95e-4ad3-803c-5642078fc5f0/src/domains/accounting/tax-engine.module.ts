import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaxCode } from './infrastructure/tax-code.entity';
import { TaxEngineService } from './application/tax-engine.service';
import { TAX_ENGINE_CONTRACT } from '../../foundation/module-registry/contracts/tax-engine.contract';

/**
 * F10 (ADR-043 D1). A deliberately SEPARATE, minimal module from
 * `AccountingModule` — NOT because `TaxEngineService` isn't owned by
 * `accounting` (it is, per D1's ownership split; it lives in this same
 * domain folder), but to avoid a real NestJS module import cycle:
 * `AccountingModule` already imports `CustomerFinanceModule` (for
 * `FINANCE_CUSTOMER_LEDGER_CONTRACT`, ADR-036), so `CustomerFinanceModule`
 * importing `AccountingModule` back — which it would need to do to reach
 * `TAX_ENGINE_CONTRACT` if that token lived in `AccountingModule` — would
 * cycle. `TaxEngineModule` imports neither `AccountingModule` nor
 * `CustomerFinanceModule`, so `CustomerFinanceModule` can depend on it
 * directly with zero cycle.
 *
 * `TypeOrmModule.forFeature([TaxCode])` here is a SECOND registration of
 * the same entity already registered in `AccountingModule` — safe and
 * normal in NestJS/TypeORM (both resolve against the same `DataSource`;
 * each module simply gets its own locally-scoped repository provider for
 * an entity it needs direct access to). `ConfigurationEngineService`
 * needs no import — `ConfigurationEngineModule` is `@Global()`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TaxCode])],
  providers: [TaxEngineService, { provide: TAX_ENGINE_CONTRACT, useExisting: TaxEngineService }],
  exports: [TaxEngineService, TAX_ENGINE_CONTRACT],
})
export class TaxEngineModule {}
