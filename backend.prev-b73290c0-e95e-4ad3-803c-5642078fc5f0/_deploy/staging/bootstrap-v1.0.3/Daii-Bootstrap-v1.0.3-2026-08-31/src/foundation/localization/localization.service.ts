import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserLocalePreference } from './user-locale-preference.entity';

/**
 * Localization — Stage 2 build-order item 16 (paired with Terminology).
 * Daii/architecture/DAII_I18N_TERMINOLOGY_ARCHITECTURE.md §1, blueprint §34.
 *
 * Deliberately minimal per Foundation Contract §14 ("persistence
 * requirement: minimal — a preference flag") — RTL/LTR mechanics and
 * the default-to-Arabic-never-locale-derived rule are client-side
 * (adopted from xnexus-website's proven pattern, Class B). The only
 * server responsibility is remembering a user's explicit choice.
 * There is deliberately no `Accept-Language`/device-locale reading
 * anywhere in this class — the default is Arabic, full stop, never
 * inferred from a header.
 */
@Injectable()
export class LocalizationService {
  constructor(
    @InjectRepository(UserLocalePreference) private readonly preferences: Repository<UserLocalePreference>,
  ) {}

  async getPreferredLanguage(userId: string): Promise<'ar' | 'en'> {
    const pref = await this.preferences.findOne({ where: { userId } });
    return pref?.language ?? 'ar'; // blueprint §34: Arabic is the default, never derived from locale
  }

  async setPreferredLanguage(userId: string, language: 'ar' | 'en'): Promise<void> {
    const existing = await this.preferences.findOne({ where: { userId } });
    if (existing) {
      existing.language = language;
      await this.preferences.save(existing);
      return;
    }
    await this.preferences.save(this.preferences.create({ userId, language }));
  }
}
