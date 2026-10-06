import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { JournalEntry } from '../infrastructure/journal-entry.entity';
import { JournalLine } from '../infrastructure/journal-line.entity';
import { JournalLineDimension } from '../infrastructure/journal-line-dimension.entity';
import { GLAccount } from '../infrastructure/gl-account.entity';
import {
  JOURNAL_ENTRY_ENTITY_TYPE,
  JOURNAL_ENTRY_PROCESS,
  JournalEntryStatus,
  JournalSourceType,
  USER_CREATABLE_SOURCE_TYPES,
  isJournalSourceType,
} from '../domain/journal';
import { computeFunctionalAmount, isPositiveAmount, normaliseAmount } from '../domain/money';
import { GLAccountService } from './gl-account.service';
import { FiscalPeriodService } from './fiscal-period.service';
import { CurrencyService } from './currency.service';
import { FinancialDimensionService } from './financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { ENTITLEMENT_RESOLVER, EntitlementResolver } from '../../../foundation/module-registry/entitlement-resolver.token';

export const JOURNAL_ENTRY_DOCUMENT_TYPE = 'accounting_journal_entry';
const DEFAULT_JOURNAL_NUMBER_PREFIX = 'JV';
const DEFAULT_ALLOW_BACKDATED_MANUAL_JOURNAL_DAYS = 0;

export interface JournalLineInput {
  accountId: string;
  description?: string | null;
  /** transaction-currency amount; exactly one of `debit` / `credit` must be > 0 */
  debit?: string;
  credit?: string;
  orgUnitId?: string | null;
  dimensions?: Array<{ dimensionTypeId: string; dimensionValueId: string }>;
}

export interface CreateJournalEntryInput {
  sourceType: JournalSourceType; // only MANUAL / OPENING via the public route; FINANCIAL_EVENT / REVERSAL are internal
  businessDate: string;
  description?: string | null;
  transactionCurrencyCode: string;
  orgUnitId?: string | null;
  lines: JournalLineInput[];
  /** internal — set by the Financial Event Engine */
  financialEventId?: string | null;
}

export interface UpdateJournalEntryInput {
  businessDate?: string;
  description?: string | null;
  transactionCurrencyCode?: string;
  orgUnitId?: string | null;
  lines?: JournalLineInput[];
}

export interface JournalEntryView extends JournalEntry {
  status: JournalEntryStatus;
  lines: Array<JournalLine & { dimensions: JournalLineDimension[] }>;
}

interface ResolvedRate {
  rate: string;
  rateDate: string;
}

/**
 * F03 — General Ledger (Blueprint §3–§10, ADR-035). Journal Entry
 * lifecycle + **the posting gate** (§5) — an ordered, fail-closed
 * pipeline that CALLS F01's `assertOpenForPosting` and F02's
 * `assertPostable`, never re-implements them (ADR-035 D2/D3). Every
 * summation / equality is done in PostgreSQL `NUMERIC` (ADR-035 D4);
 * `decimal.js` (via `domain/money.ts`) is used ONLY for
 * `functionalAmount = transaction × rate`.
 */
@Injectable()
export class JournalEntryService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly glAccounts: GLAccountService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly currencies: CurrencyService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly numbering: NumberingService,
    private readonly processEngine: ProcessEngineService,
    /** F11 (ADR-044 D10) — the first real `accounting` consumer of the live Configuration Engine. */
    private readonly config: ConfigurationEngineService,
    /** F11 (ADR-044 D10) — resolves the P&L policy's configured dimension-type code. */
    private readonly dimensions: FinancialDimensionService,
    /** F11 (ADR-044 D9) — additive, optional, same P1/P2-compatible convention as `GLAccountService`'s own. */
    @Optional() @Inject(ENTITLEMENT_RESOLVER) private readonly entitlement?: EntitlementResolver,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureNumberingRegistered();
  }

  /** Registered once on module init — the JV numbering sequence (`accounting.journal_number_prefix`, default 'JV'). */
  async ensureNumberingRegistered(): Promise<void> {
    await this.numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, DEFAULT_JOURNAL_NUMBER_PREFIX, true);
  }

  /**
   * Company-scoped numbering (2026-10-06, CTO-authorised fix; found by Browser Verification #1). `ensureNumberingRegistered` above registers the
   * JV sequence only on the AMBIENT database at boot, so a Company database — which owns its own `numbering_sequences` table under Model B — had
   * no `accounting_journal_entry` sequence and the first post failed with "No numbering sequence registered". Every other numbered document
   * registers its sequence on the manager it is about to draw from; this does the same for journals: the sequence is created, per Company and
   * lazily, on the manager the number is drawn from, BEFORE the draw. No fallback to the ambient database, no shared/global sequence, the
   * numbering architecture is unchanged. First-ever concurrent posts in one Company are serialised by a transaction-scoped advisory lock (the
   * draw itself already serialises posting per Company via the sequence row's FOR UPDATE), so two simultaneous first posts cannot both insert.
   */
  private async ensureCompanyNumbering(m: EntityManager): Promise<void> {
    const existing = await m.query('SELECT 1 FROM numbering_sequences WHERE "documentType" = $1', [JOURNAL_ENTRY_DOCUMENT_TYPE]);
    if (existing.length > 0) return;
    await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`numbering:register:${JOURNAL_ENTRY_DOCUMENT_TYPE}`]);
    await this.numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, DEFAULT_JOURNAL_NUMBER_PREFIX, true, m); // idempotent: re-checks under the lock
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async listEntries(filter?: {
    sourceType?: JournalSourceType;
    from?: string;
    to?: string;
    accountId?: string;
    status?: JournalEntryStatus;
  }, manager?: EntityManager): Promise<JournalEntryView[]> {
    const qb = (manager ?? this.dataSource).getRepository(JournalEntry).createQueryBuilder('e');
    if (filter?.sourceType) qb.andWhere('e."sourceType" = :st', { st: filter.sourceType });
    if (filter?.from) qb.andWhere('e."businessDate" >= :from', { from: filter.from });
    if (filter?.to) qb.andWhere('e."businessDate" <= :to', { to: filter.to });
    if (filter?.accountId) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM accounting_journal_lines l WHERE l."journalEntryId" = e.id AND l."accountId" = :acc)',
        { acc: filter.accountId },
      );
    }
    const entries = await qb.orderBy('e."createdAt"', 'DESC').getMany();
    const views = await Promise.all(entries.map((e) => this.toView(e, manager)));
    return filter?.status ? views.filter((v) => v.status === filter.status) : views;
  }

  /**
   * F08 (ADR-041 D18a) — the additive optional trailing `manager` lets a caller that already owns
   * a transaction (e.g. `FinancialEventService.ingest`'s shared handler-through-posting span) read
   * back a row it just wrote, inside that SAME transaction, before it commits — a plain
   * `this.dataSource` read would not see it yet (read-committed isolation). Omit it and this method
   * behaves exactly as before.
   */
  async getEntry(id: string, manager?: EntityManager): Promise<JournalEntryView> {
    const entry = await (manager ?? this.dataSource).getRepository(JournalEntry).findOne({ where: { id } });
    if (!entry) throw new NotFoundException(`Journal entry "${id}" not found.`);
    return this.toView(entry, manager);
  }

  private async toView(entry: JournalEntry, manager?: EntityManager): Promise<JournalEntryView> {
    const source = manager ?? this.dataSource;
    const status = (await this.processEngine.getState(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, entry.id, manager)) as JournalEntryStatus;
    const lines = await source.getRepository(JournalLine).find({ where: { journalEntryId: entry.id }, order: { lineNumber: 'ASC' } });
    const dims = await source.getRepository(JournalLineDimension).find({ where: lines.map((l) => ({ journalLineId: l.id })) });
    return {
      ...entry,
      status,
      lines: lines.map((l) => ({ ...l, dimensions: dims.filter((d) => d.journalLineId === l.id) })),
    };
  }

  // ---------------------------------------------------------------------------
  // Create (draft)
  // ---------------------------------------------------------------------------

  /**
   * F08 (ADR-041 D18a) — additive optional trailing `manager`: when supplied, this method runs
   * inside the CALLER's own transaction (no new `BEGIN`/`COMMIT` of its own) instead of opening one
   * of its own. Every existing caller (nothing before F08 passes one) observes identical behavior.
   * The posting-gate validation logic below is byte-for-byte unchanged either way.
   */
  async createEntry(input: CreateJournalEntryInput, actorUserId: string, manager?: EntityManager): Promise<JournalEntryView> {
    if (!isJournalSourceType(input.sourceType)) throw new BadRequestException(`Unknown journal source type "${input.sourceType}".`);
    if (input.financialEventId == null && !USER_CREATABLE_SOURCE_TYPES.has(input.sourceType)) {
      throw new BadRequestException(`Source type "${input.sourceType}" cannot be created directly.`);
    }
    if (input.financialEventId != null && input.sourceType !== 'FINANCIAL_EVENT') {
      throw new BadRequestException('A financialEventId is only valid on a FINANCIAL_EVENT entry.');
    }
    this.assertBackdatingAllowed(input.sourceType, input.businessDate);

    const run = <T,>(fn: (m: EntityManager) => Promise<T>): Promise<T> =>
      manager?.queryRunner?.isTransactionActive ? fn(manager) : (manager ?? this.dataSource).transaction(fn);

    const created = await run(async (txManager) => {
      const base = await this.currencies.getBaseCurrency(txManager);
      if (!base) throw new ConflictException('No base/functional currency is configured — a journal entry cannot be created.');
      const txnCurrency = await this.currencies.getCurrency(input.transactionCurrencyCode, txManager); // throws NotFound
      if (!txnCurrency.isActive) throw new ConflictException(`Currency "${txnCurrency.code}" is inactive.`);

      const entryRepo = txManager.getRepository(JournalEntry);
      const entry = await entryRepo.save(
        entryRepo.create({
          entryNumber: null,
          businessDate: input.businessDate,
          postingDate: null,
          description: input.description ?? null,
          sourceType: input.sourceType,
          financialEventId: input.financialEventId ?? null,
          reversalOfEntryId: null,
          transactionCurrencyCode: input.transactionCurrencyCode,
          functionalCurrencyCode: base.code,
          orgUnitId: input.orgUnitId ?? null,
          createdBy: actorUserId,
          postedBy: null,
        }),
      );
      await this.processEngine.start(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, entry.id, txManager);

      await this.writeLines(txManager, entry, input.lines, base.code, base.decimalPlaces, base.roundingMode);
      await this.refreshTransactionTotals(txManager, entry.id);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.journal.created',
          resource: 'journal_entry',
          resourceId: entry.id,
          result: 'success',
          correlationId: null,
          after: { sourceType: entry.sourceType, businessDate: entry.businessDate, lineCount: input.lines.length },
        },
        txManager,
      );
      return entry;
    });

    return this.getEntry(created.id, manager);
  }

  // ---------------------------------------------------------------------------
  // Edit (DRAFT / VALIDATED -> lines replaced, VALIDATED drops to DRAFT)
  // ---------------------------------------------------------------------------

  async updateEntry(id: string, input: UpdateJournalEntryInput, actorUserId: string, manager?: EntityManager): Promise<JournalEntryView> {
    return (manager ?? this.dataSource)
      .transaction(async (txManager) => {
        const entry = await this.lockEntry(txManager, id);
        if (!entry) throw new NotFoundException(`Journal entry "${id}" not found.`);
        const state = await this.processEngine.getState(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, id, txManager);
        if (state !== 'DRAFT' && state !== 'VALIDATED') {
          throw new ConflictException(`Journal entry "${id}" is "${state}" — only a DRAFT or VALIDATED entry can be edited.`);
        }
        if (entry.sourceType === 'REVERSAL' || entry.sourceType === 'FINANCIAL_EVENT') {
          throw new ConflictException(`A ${entry.sourceType} journal entry cannot be hand-edited.`);
        }
        if (state === 'VALIDATED') {
          await this.processEngine.transition(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, id, 'revise', actorUserId, txManager);
        }

        if (input.businessDate !== undefined) {
          this.assertBackdatingAllowed(entry.sourceType, input.businessDate);
          entry.businessDate = input.businessDate;
        }
        if (input.description !== undefined) entry.description = input.description ?? null;
        if (input.orgUnitId !== undefined) entry.orgUnitId = input.orgUnitId ?? null;
        if (input.transactionCurrencyCode !== undefined) {
          const c = await this.currencies.getCurrency(input.transactionCurrencyCode, txManager);
          if (!c.isActive) throw new ConflictException(`Currency "${c.code}" is inactive.`);
          entry.transactionCurrencyCode = input.transactionCurrencyCode;
        }
        await txManager.getRepository(JournalEntry).save(entry);

        if (input.lines !== undefined) {
          const base = await this.currencies.getBaseCurrency(txManager);
          if (!base) throw new ConflictException('No base/functional currency is configured.');
          await this.deleteLines(txManager, id);
          await this.writeLines(txManager, entry, input.lines, base.code, base.decimalPlaces, base.roundingMode);
        }
        await this.refreshTransactionTotals(txManager, id);

        await this.audit.record(
          {
            actorUserId,
            organizationId: null,
            action: 'accounting.journal.updated',
            resource: 'journal_entry',
            resourceId: id,
            result: 'success',
            correlationId: null,
          },
          txManager,
        );
        return id;
      })
      .then((entryId) => this.getEntry(entryId, manager));
  }

  // ---------------------------------------------------------------------------
  // Submit (DRAFT -> VALIDATED)
  // ---------------------------------------------------------------------------

  async submitEntry(id: string, actorUserId: string, manager?: EntityManager): Promise<JournalEntryView> {
    await (manager ?? this.dataSource).transaction(async (txManager) => {
      const entry = await this.lockEntry(txManager, id);
      if (!entry) throw new NotFoundException(`Journal entry "${id}" not found.`);
      const state = await this.processEngine.getState(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, id, txManager);
      if (state !== 'DRAFT') throw new ConflictException(`Journal entry "${id}" is "${state}" — only a DRAFT can be submitted.`);
      await this.assertStructurallyValid(txManager, id);
      await this.processEngine.transition(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, id, 'submit', actorUserId, txManager);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'accounting.journal.submitted', resource: 'journal_entry', resourceId: id, result: 'success', correlationId: null },
        txManager,
      );
    });
    return this.getEntry(id, manager);
  }

  // ---------------------------------------------------------------------------
  // Post — THE GATE (Blueprint §5, ADR-035 D5)
  // ---------------------------------------------------------------------------

  /**
   * F08 (ADR-041 D18a) — additive optional trailing `manager`, same contract as `createEntry`
   * above: supply one to run inside the caller's own transaction (e.g. atomically with a
   * `FinancialEvent`'s handler-resolved valuation mutation); omit it for today's behavior
   * unchanged. The gate's checks (fiscal period, account postability, double-entry balance,
   * numbering) below are untouched either way.
   */
  async postEntry(id: string, actorUserId: string, opts: { systemPosting?: boolean } = {}, manager?: EntityManager): Promise<JournalEntryView> {
    const run = <T,>(fn: (m: EntityManager) => Promise<T>): Promise<T> =>
      manager?.queryRunner?.isTransactionActive ? fn(manager) : (manager ?? this.dataSource).transaction(fn);
    await run(async (txManager) => {
      // 1. load + state
      const entry = await this.lockEntry(txManager, id);
      if (!entry) throw new NotFoundException(`Journal entry "${id}" not found.`);
      // F08 (ADR-041 D18a): pass `txManager` — when this runs inside a shared transaction whose
      // `createEntry` call (same transaction) just started this entry's process instance, a
      // txManager-less read here would not see that still-uncommitted row (read-committed isolation).
      const state = await this.processEngine.getState(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, id, txManager);
      if (state !== 'DRAFT' && state !== 'VALIDATED') {
        throw new ConflictException(`Journal entry "${id}" is "${state}" — only a DRAFT or VALIDATED entry can be posted.`);
      }

      // 2. structural
      const lines = await this.assertStructurallyValid(txManager, id);

      // 3. fiscal period (F01 — CALL, don't copy)
      await this.fiscalPeriods.assertOpenForPosting(entry.orgUnitId, entry.businessDate, txManager);

      // 4/5. currency: resolve rate + (re)compute base amounts per line
      const base = await this.currencies.getBaseCurrency(txManager);
      if (!base) throw new ConflictException('No base/functional currency is configured — posting is not possible.');
      const txnCurrency = await this.currencies.getCurrency(entry.transactionCurrencyCode, txManager);
      if (!txnCurrency.isActive) throw new ConflictException(`Currency "${entry.transactionCurrencyCode}" is inactive.`);
      if (entry.functionalCurrencyCode !== base.code) {
        // base currency changed since draft creation — lock it in now (historical accuracy, F01 §3.7)
        entry.functionalCurrencyCode = base.code;
      }
      const rate = await this.resolveRate(entry.transactionCurrencyCode, base.code, entry.businessDate, txManager);
      for (const line of lines) {
        line.exchangeRateUsed = rate.rate;
        line.exchangeRateDate = rate.rateDate;
        line.debitBase =
          Number(line.debitTransaction) > 0
            ? computeFunctionalAmount(line.debitTransaction, rate.rate, base.decimalPlaces, base.roundingMode)
            : '0';
        line.creditBase =
          Number(line.creditTransaction) > 0
            ? computeFunctionalAmount(line.creditTransaction, rate.rate, base.decimalPlaces, base.roundingMode)
            : '0';
        await txManager.getRepository(JournalLine).save(line);
      }

      // 6. account eligibility (F02 — CALL, don't copy) + dimension resolve→validate→persist
      // (F11, ADR-044 Mandatory Correction 1) + P&L implicit-dimension policy (ADR-044 D10)
      for (const line of lines) {
        const persistedDims = await txManager.getRepository(JournalLineDimension).find({ where: { journalLineId: line.id } });
        const providedDims = persistedDims.map((d) => ({ typeId: d.dimensionTypeId, valueId: d.dimensionValueId as string | null }));

        // resolve: every explicitly-persisted value, plus (for a `required` rule with no
        // persisted value) the rule's own `defaultValueId`, if one is configured.
        const resolvedDims = await this.glAccounts.resolveDimensions(line.accountId, providedDims, txManager);

        // validate: GLAccountService.assertPostable's existing required/blocked/value-validity
        // logic, UNCHANGED, now operating on the RESOLVED set — a required-with-default case is
        // therefore genuinely satisfied, not merely "considered" satisfied.
        const account = await this.glAccounts.assertPostable(line.accountId, {
          businessDate: entry.businessDate,
          orgUnitId: line.orgUnitId ?? entry.orgUnitId,
          currencyCode: entry.transactionCurrencyCode,
          dimensions: resolvedDims,
          systemPosting: opts.systemPosting,
        }, txManager);

        // persist: any resolved entry not already in JournalLineDimension (a default that was
        // just applied) is inserted NOW, in this SAME transaction, strictly BEFORE this entry can
        // ever reach POSTED — this is what makes the default a real row, not merely a validation
        // side-effect (ADR-044 Mandatory Correction 1: acceptance ≠ persistence).
        const persistedTypeIds = new Set(persistedDims.map((d) => d.dimensionTypeId));
        const dimRepo = txManager.getRepository(JournalLineDimension);
        for (const d of resolvedDims) {
          if (!persistedTypeIds.has(d.typeId)) {
            await dimRepo.save(dimRepo.create({ journalLineId: line.id, dimensionTypeId: d.typeId, dimensionValueId: d.valueId }));
          }
        }

        await this.enforcePlAccountDimensionPolicy(account, resolvedDims, txManager);
      }

      // 7. DOUBLE ENTRY — computed in SQL NUMERIC (ADR-035 D4)
      const [bal] = (await txManager.query(
        `SELECT
           (SUM("debitTransaction") = SUM("creditTransaction")) AS bal_txn,
           (SUM("debitBase")        = SUM("creditBase"))        AS bal_base,
           SUM("debitTransaction")  AS tdt, SUM("creditTransaction") AS tct,
           SUM("debitBase")         AS tdb, SUM("creditBase")        AS tcb
         FROM accounting_journal_lines WHERE "journalEntryId" = $1`,
        [id],
      )) as Array<{ bal_txn: boolean; bal_base: boolean; tdt: string; tct: string; tdb: string; tcb: string }>;
      if (!bal.bal_txn || !bal.bal_base) {
        throw new ConflictException(
          `Journal entry is not balanced — debit ${bal.tdt}/${bal.tdb} vs credit ${bal.tct}/${bal.tcb} (transaction/base).`,
        );
      }

      // 8. idempotency: FINANCIAL_EVENT entries are single-processed at ingest via
      //    FinancialEvent.UNIQUE(idempotencyKey); nothing further needed here.

      // 9. numbering — INSIDE this transaction (ADR-035 D8, NumberingService extended with `txManager`)
      await this.ensureCompanyNumbering(txManager); // the Company's own sequence must exist on THIS manager before the draw
      const entryNumber = await this.numbering.getNextNumber(JOURNAL_ENTRY_DOCUMENT_TYPE, txManager);

      // 10. commit the post
      entry.entryNumber = entryNumber;
      entry.postingDate = new Date().toISOString().slice(0, 10);
      entry.postedAt = new Date();
      entry.postedBy = actorUserId;
      entry.totalDebitTransaction = normaliseAmount(bal.tdt, 4);
      entry.totalCreditTransaction = normaliseAmount(bal.tct, 4);
      entry.totalDebitBase = normaliseAmount(bal.tdb, 4);
      entry.totalCreditBase = normaliseAmount(bal.tcb, 4);
      await txManager.getRepository(JournalEntry).save(entry);
      await this.processEngine.transition(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, id, 'post', actorUserId, txManager);

      // 11. audit + event — same transaction
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.journal.posted',
          resource: 'journal_entry',
          resourceId: id,
          result: 'success',
          correlationId: entry.financialEventId,
          after: { entryNumber, totalBase: entry.totalDebitBase, sourceType: entry.sourceType },
        },
        txManager,
      );
      await this.events.publish(txManager, 'accounting.journal.posted', {
        journalEntryId: id,
        entryNumber,
        sourceType: entry.sourceType,
        businessDate: entry.businessDate,
        totalBase: entry.totalDebitBase,
        actorUserId,
      });
    });

    return this.getEntry(id, manager);
  }

  // ---------------------------------------------------------------------------
  // Reverse (Blueprint §9, ADR-035 D3)
  // ---------------------------------------------------------------------------

  async reverseEntry(
    id: string,
    actorUserId: string,
    opts: { businessDate?: string; description?: string } = {},
    manager?: EntityManager,
  ): Promise<{ original: JournalEntryView; reversal: JournalEntryView }> {
    const reversalId = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const original = await this.lockEntry(txManager, id);
      if (!original) throw new NotFoundException(`Journal entry "${id}" not found.`);
      const state = await this.processEngine.getState(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, id, txManager);
      if (state !== 'POSTED') throw new ConflictException(`Only a POSTED journal entry can be reversed (this one is "${state}").`);
      if (original.sourceType === 'REVERSAL') throw new ConflictException('A reversal entry cannot itself be reversed.');
      const existing = await txManager.getRepository(JournalEntry).findOne({ where: { reversalOfEntryId: id } });
      if (existing) throw new ConflictException(`Journal entry "${original.entryNumber}" has already been reversed by "${existing.id}".`);

      const originalLines = await txManager.getRepository(JournalLine).find({ where: { journalEntryId: id }, order: { lineNumber: 'ASC' } });
      const base = await this.currencies.getBaseCurrency(txManager);
      if (!base) throw new ConflictException('No base/functional currency is configured.');

      const entryRepo = txManager.getRepository(JournalEntry);
      const reversal = await entryRepo.save(
        entryRepo.create({
          entryNumber: null,
          businessDate: opts.businessDate ?? original.businessDate,
          postingDate: null,
          description: opts.description ?? `Reversal of ${original.entryNumber ?? id}`,
          sourceType: 'REVERSAL',
          financialEventId: null,
          reversalOfEntryId: id,
          transactionCurrencyCode: original.transactionCurrencyCode,
          functionalCurrencyCode: base.code,
          orgUnitId: original.orgUnitId,
          createdBy: actorUserId,
          postedBy: null,
        }),
      );
      await this.processEngine.start(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, reversal.id, txManager);

      const lineRepo = txManager.getRepository(JournalLine);
      const dimRepo = txManager.getRepository(JournalLineDimension);
      for (const src of originalLines) {
        const swapped = await lineRepo.save(
          lineRepo.create({
            journalEntryId: reversal.id,
            lineNumber: src.lineNumber,
            accountId: src.accountId,
            description: src.description,
            // swap debit <-> credit
            debitTransaction: src.creditTransaction,
            creditTransaction: src.debitTransaction,
            debitBase: src.creditBase,
            creditBase: src.debitBase,
            exchangeRateUsed: src.exchangeRateUsed,
            exchangeRateDate: src.exchangeRateDate,
            orgUnitId: src.orgUnitId,
          }),
        );
        const srcDims = await dimRepo.find({ where: { journalLineId: src.id } });
        for (const d of srcDims) {
          await dimRepo.save(dimRepo.create({ journalLineId: swapped.id, dimensionTypeId: d.dimensionTypeId, dimensionValueId: d.dimensionValueId }));
        }
      }
      await this.refreshTransactionTotals(txManager, reversal.id);

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.journal.reversal_created',
          resource: 'journal_entry',
          resourceId: reversal.id,
          result: 'success',
          correlationId: id,
          after: { reversalOfEntryId: id },
        },
        txManager,
      );
      return reversal.id;
    });

    // post the reversal through the FULL gate (system posting — a reversal may need to hit control accounts)
    await this.postEntry(reversalId, actorUserId, { systemPosting: true }, manager);

    await (manager ?? this.dataSource).transaction(async (txManager) => {
      await this.processEngine.transition(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, id, 'reverse', actorUserId, txManager);
      await this.audit.record(
        { actorUserId, organizationId: null, action: 'accounting.journal.reversed', resource: 'journal_entry', resourceId: id, result: 'success', correlationId: reversalId },
        txManager,
      );
      await this.events.publish(txManager, 'accounting.journal.reversed', { journalEntryId: id, reversalEntryId: reversalId, actorUserId });
    });

    return { original: await this.getEntry(id, manager), reversal: await this.getEntry(reversalId, manager) };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async lockEntry(manager: EntityManager, id: string): Promise<JournalEntry | null> {
    const rows = await manager.getRepository(JournalEntry).find({ where: { id }, lock: { mode: 'pessimistic_write' } });
    return rows[0] ?? null;
  }

  private assertBackdatingAllowed(sourceType: JournalSourceType, businessDate: string): void {
    // Only MANUAL journals are constrained. OPENING entries are inherently backdated
    // (posted at go-live for the fiscal-year start) — they are still bounded by the
    // fiscal-period gate (§8), just not by this day-count rule.
    if (sourceType !== 'MANUAL') return;
    // `accounting.allow_backdated_manual_journal_days` — stated default used directly (0),
    // same disclosed pattern F01/F02 used for their config keys (no domain consumes the
    // Configuration Engine's live values yet). The fiscal-period gate applies regardless.
    const allowedDays = DEFAULT_ALLOW_BACKDATED_MANUAL_JOURNAL_DAYS;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const bd = new Date(businessDate + 'T00:00:00Z');
    const diffDays = Math.floor((today.getTime() - bd.getTime()) / 86_400_000);
    if (diffDays > allowedDays) {
      throw new ConflictException(
        `A ${sourceType} journal cannot be backdated more than ${allowedDays} day(s) (businessDate ${businessDate} is ${diffDays} day(s) ago).`,
      );
    }
  }

  private async resolveRate(txnCode: string, baseCode: string, businessDate: string, manager?: EntityManager): Promise<ResolvedRate> {
    if (txnCode === baseCode) return { rate: '1', rateDate: businessDate };
    const rate = await this.currencies.getRateOnOrBefore(txnCode, businessDate, manager); // fails closed (F01)
    return { rate: rate.rate, rateDate: rate.rateDate };
  }

  private async writeLines(
    manager: EntityManager,
    entry: JournalEntry,
    inputs: JournalLineInput[],
    baseCode: string,
    baseDecimalPlaces: number,
    baseRoundingMode: 'half_up' | 'half_even' | 'half_down',
  ): Promise<void> {
    if (!Array.isArray(inputs) || inputs.length < 2) {
      throw new BadRequestException('A journal entry must have at least 2 lines.');
    }
    const rate = await this.resolveRate(entry.transactionCurrencyCode, baseCode, entry.businessDate, manager);
    const lineRepo = manager.getRepository(JournalLine);
    const dimRepo = manager.getRepository(JournalLineDimension);

    let lineNumber = 1;
    for (const input of inputs) {
      const debit = input.debit ?? '0';
      const credit = input.credit ?? '0';
      const debitPos = isPositiveAmount(debit);
      const creditPos = isPositiveAmount(credit);
      if (debitPos === creditPos) {
        throw new BadRequestException(`Line ${lineNumber}: exactly one of debit / credit must be a positive amount.`);
      }
      if ((debitPos && !isNonNeg(credit)) || (creditPos && !isNonNeg(debit))) {
        throw new BadRequestException(`Line ${lineNumber}: amounts must be non-negative.`);
      }

      const debitTransaction = debitPos ? normaliseAmount(debit, 4) : '0';
      const creditTransaction = creditPos ? normaliseAmount(credit, 4) : '0';
      const debitBase = debitPos ? computeFunctionalAmount(debitTransaction, rate.rate, baseDecimalPlaces, baseRoundingMode) : '0';
      const creditBase = creditPos ? computeFunctionalAmount(creditTransaction, rate.rate, baseDecimalPlaces, baseRoundingMode) : '0';
      // computeFunctionalAmount can round a tiny amount to 0 — reject rather than violate the XOR CHECK
      if ((debitPos && Number(debitBase) <= 0) || (creditPos && Number(creditBase) <= 0)) {
        throw new BadRequestException(`Line ${lineNumber}: the functional-currency amount rounds to zero at the current rate.`);
      }

      const line = await lineRepo.save(
        lineRepo.create({
          journalEntryId: entry.id,
          lineNumber,
          accountId: input.accountId,
          description: input.description ?? null,
          debitTransaction,
          creditTransaction,
          debitBase,
          creditBase,
          exchangeRateUsed: rate.rate,
          exchangeRateDate: rate.rateDate,
          orgUnitId: input.orgUnitId ?? null,
        }),
      );

      const dims = input.dimensions ?? [];
      const seenTypes = new Set<string>();
      for (const d of dims) {
        if (seenTypes.has(d.dimensionTypeId)) throw new BadRequestException(`Line ${lineNumber}: duplicate dimension type.`);
        seenTypes.add(d.dimensionTypeId);
        await dimRepo.save(dimRepo.create({ journalLineId: line.id, dimensionTypeId: d.dimensionTypeId, dimensionValueId: d.dimensionValueId }));
      }
      lineNumber++;
    }
  }

  private async deleteLines(manager: EntityManager, entryId: string): Promise<void> {
    const lines = await manager.getRepository(JournalLine).find({ where: { journalEntryId: entryId } });
    for (const l of lines) await manager.getRepository(JournalLineDimension).delete({ journalLineId: l.id });
    await manager.getRepository(JournalLine).delete({ journalEntryId: entryId });
  }

  private async refreshTransactionTotals(manager: EntityManager, entryId: string): Promise<void> {
    const [t] = (await manager.query(
      `SELECT COALESCE(SUM("debitTransaction"),0) tdt, COALESCE(SUM("creditTransaction"),0) tct,
              COALESCE(SUM("debitBase"),0) tdb, COALESCE(SUM("creditBase"),0) tcb
       FROM accounting_journal_lines WHERE "journalEntryId" = $1`,
      [entryId],
    )) as Array<{ tdt: string; tct: string; tdb: string; tcb: string }>;
    await manager.query(
      `UPDATE accounting_journal_entries
       SET "totalDebitTransaction" = $1, "totalCreditTransaction" = $2, "totalDebitBase" = $3, "totalCreditBase" = $4
       WHERE id = $5`,
      [t.tdt, t.tct, t.tdb, t.tcb, entryId],
    );
  }

  private async assertStructurallyValid(manager: EntityManager, entryId: string): Promise<JournalLine[]> {
    const lines = await manager.getRepository(JournalLine).find({ where: { journalEntryId: entryId }, order: { lineNumber: 'ASC' } });
    if (lines.length < 2) throw new ConflictException('A journal entry must have at least 2 lines.');
    lines.forEach((l, i) => {
      if (l.lineNumber !== i + 1) throw new ConflictException('Journal line numbers must be contiguous starting at 1.');
      const debitPos = Number(l.debitTransaction) > 0;
      const creditPos = Number(l.creditTransaction) > 0;
      if (debitPos === creditPos) throw new ConflictException(`Line ${l.lineNumber}: exactly one of debit / credit must be positive.`);
    });
    return lines;
  }

  /**
   * `accounting.require_dimension_on_pl_accounts` + `accounting.default_pl_dimension_type_code`
   * (F11, ADR-044 D10) — the first real `accounting` consumer of the live Configuration Engine.
   * Posting-time policy ONLY: enabling it never inserts a `GLAccountDimensionRule` row for any
   * account (no mass Chart-of-Accounts mutation) and never invents a dimension VALUE — a
   * revenue/expense account subject to this policy with no value supplied by the poster is
   * REJECTED, exactly like any other missing-required-dimension case, never silently defaulted
   * (implicit policy carries no `defaultValueId`, since no real rule row is ever materialized for
   * it). An account's own EXPLICIT `GLAccountDimensionRule` for the same dimension type — whatever
   * its mode — always takes precedence; this only fills a genuine absence of configuration.
   */
  private async enforcePlAccountDimensionPolicy(account: GLAccount, resolvedDims: Array<{ typeId: string; valueId: string }>, manager?: EntityManager): Promise<void> {
    if (!(this.entitlement?.isFeatureEntitled('accounting.financial_dimensions') ?? true)) return; // F11 D9 — feature off, no enforcement
    const requireDimensionOnPlAccounts = this.config.get<boolean>('accounting.require_dimension_on_pl_accounts');
    if (!requireDimensionOnPlAccounts) return;
    if (account.accountType !== 'revenue' && account.accountType !== 'expense') return;

    const typeCode = (this.config.get<string>('accounting.default_pl_dimension_type_code') ?? '').trim();
    if (!typeCode) return; // policy "on" but names no type — nothing configured to enforce (disclosed, not a crash)
    const dimensionType = await this.dimensions.findTypeByCode(typeCode, manager);
    if (!dimensionType) return; // the configured code doesn't resolve — nothing to enforce (disclosed, not a crash)

    const hasExplicitRule = await this.glAccounts.hasDimensionRule(account.id, dimensionType.id, manager);
    if (hasExplicitRule) return; // an explicit rule (whatever its mode) always takes precedence over the implicit policy

    const hasValue = resolvedDims.some((d) => d.typeId === dimensionType.id);
    if (!hasValue) {
      throw new ConflictException(
        `GL account "${account.code}" requires a value for dimension type "${typeCode}" (P&L policy: accounting.require_dimension_on_pl_accounts) but none was supplied.`,
      );
    }
  }
}

function isNonNeg(s: string): boolean {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0;
}
