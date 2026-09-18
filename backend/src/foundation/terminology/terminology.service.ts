import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TerminologyEntry } from './terminology-entry.entity';

export type SupportedLang = 'ar' | 'en';

/**
 * Terminology Registry — Stage 2 build-order item 16.
 * Daii/architecture/DAII_I18N_TERMINOLOGY_ARCHITECTURE.md §3.
 *
 * Business logic uses `code` exclusively (blueprint §37) — this service
 * is the only place a canonical code becomes a localized label. Never
 * returns blank; **Arabic is the system default AND the fallback
 * language (CTO directive, 2026-09-12)** — requesting English for a code
 * whose English cell is blank now resolves to the Arabic value instead
 * of silently degrading to the raw code (the previous behavior, and the
 * actual bug the CTO's report traced back to: an `en`-requested,
 * `ar`-populated-but-`en`-blank entry fell straight past Arabic to the
 * raw code). A code with NO registry row at all still degrades to the
 * raw code as a last resort — that is a data-completeness gap to close
 * by seeding the missing entry, not a logic gap this service can paper
 * over — and, unlike every audited source before this one, this class
 * logs a warning (not silence) when that happens, so an unregistered
 * code is a visible gap, not a permanent silent one.
 */
@Injectable()
export class TerminologyService {
  private readonly logger = new Logger(TerminologyService.name);

  constructor(@InjectRepository(TerminologyEntry) private readonly entries: Repository<TerminologyEntry>) {}

  /** Arabic-first fallback (see class doc comment) — `lang === 'ar'` still degrades to English before a raw code, since Arabic itself has nothing lower to fall back to. */
  private pickValue(entry: TerminologyEntry, code: string, lang: SupportedLang): string {
    return lang === 'ar' ? entry.ar || entry.en || code : entry.en || entry.ar || code;
  }

  async resolve(code: string, lang: SupportedLang): Promise<string> {
    const entry = await this.entries.findOne({ where: { code } });
    if (!entry) {
      this.logger.warn(`Terminology code "${code}" has no registry entry — falling back to raw code.`);
      return code;
    }
    return this.pickValue(entry, code, lang);
  }

  async resolveMany(codes: string[], lang: SupportedLang): Promise<Record<string, string>> {
    const found = await this.entries.find({ where: { code: In(codes) } });
    const byCode = new Map(found.map((e) => [e.code, e]));
    const result: Record<string, string> = {};
    for (const code of codes) {
      const entry = byCode.get(code);
      if (!entry) {
        this.logger.warn(`Terminology code "${code}" has no registry entry — falling back to raw code.`);
        result[code] = code;
        continue;
      }
      result[code] = this.pickValue(entry, code, lang);
    }
    return result;
  }

  /** Admin write: revises wording without ever changing the canonical code, bumping version. */
  async upsert(code: string, category: string, ar: string, en: string): Promise<TerminologyEntry> {
    const existing = await this.entries.findOne({ where: { code } });
    if (existing) {
      existing.ar = ar;
      existing.en = en;
      existing.category = category;
      existing.version += 1;
      return this.entries.save(existing);
    }
    return this.entries.save(this.entries.create({ code, category, ar, en, version: 1 }));
  }
}
