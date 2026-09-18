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
 * returns blank; falls back English if Arabic is missing, and — unlike
 * every audited source — logs a warning (not silence) when a code has
 * no registry entry at all, so an unregistered code is a visible gap,
 * not a permanent silent one.
 */
@Injectable()
export class TerminologyService {
  private readonly logger = new Logger(TerminologyService.name);

  constructor(@InjectRepository(TerminologyEntry) private readonly entries: Repository<TerminologyEntry>) {}

  async resolve(code: string, lang: SupportedLang): Promise<string> {
    const entry = await this.entries.findOne({ where: { code } });
    if (!entry) {
      this.logger.warn(`Terminology code "${code}" has no registry entry — falling back to raw code.`);
      return code;
    }
    const value = lang === 'ar' ? entry.ar : entry.en;
    return value || entry.en || code;
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
      result[code] = (lang === 'ar' ? entry.ar : entry.en) || entry.en || code;
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
