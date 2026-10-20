import { currentLang } from './displayNames';

/**
 * Dates and times in the language the user chose. The browser's default locale made an Arabic screen show «AM 2:39:58»; here the
 * Arabic locale is used with Latin digits (the rest of the application shows Latin digits), so the day period reads ص / م.
 */
function locale(): string {
  return currentLang() === 'ar' ? 'ar-u-nu-latn' : 'en-GB';
}

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDateTime(value: DateInput): string {
  const d = toDate(value);
  return d ? d.toLocaleString(locale()) : '—';
}

export function fmtDate(value: DateInput): string {
  const d = toDate(value);
  return d ? d.toLocaleDateString(locale()) : '—';
}

export function fmtTime(value: DateInput): string {
  const d = toDate(value);
  return d ? d.toLocaleTimeString(locale()) : '—';
}
