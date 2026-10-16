import { BadRequestException } from '@nestjs/common';

/**
 * Shared value rules for the customer and supplier profiles (master-data gap matrix §5). Kept in `foundation` so the two domains validate
 * identically without importing each other. Partial-update convention used by both: `undefined` = leave the field untouched, `null` or a
 * blank string = clear it, anything else is trimmed and checked. Every failure is a 400 raised BEFORE anything is written.
 */
export const PROFILE_LANGUAGES = ['ar', 'en'] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function profileText(field: string, value: string | null | undefined, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) throw new BadRequestException(`"${field}" is too long (max ${max} characters).`);
  return trimmed;
}

export function profileOneOf<T extends string>(field: string, value: string | null | undefined, allowed: readonly T[]): T | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  if (!(allowed as readonly string[]).includes(value)) throw new BadRequestException(`"${field}" must be one of: ${allowed.join(', ')}.`);
  return value as T;
}

export function profileEmail(value: string | null | undefined): string | null | undefined {
  const v = profileText('email', value, 255);
  if (v && !EMAIL.test(v)) throw new BadRequestException('"email" is not a valid e-mail address.');
  return v;
}

export function profileWebsite(value: string | null | undefined): string | null | undefined {
  const v = profileText('website', value, 255);
  if (v && /\s/.test(v)) throw new BadRequestException('"website" must not contain spaces.');
  return v;
}
