import { ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';

/** What a screen keeps for a failed request: the stable code + parameters the server sent (rendered through the Terminology Registry) and the server's own message as the fallback. */
export interface UiError {
  code?: string;
  message: string;
  params?: Record<string, unknown>;
}

export function toUiError(err: unknown, t: (code: string) => string, fallbackCode: string): UiError {
  if (err instanceof ApiError) return { code: err.code, message: err.message, params: err.details };
  return { message: t(fallbackCode) };
}

/** Shows `error.<code>` (with `{name}` placeholders filled from the server's parameters) when that label is registered; otherwise the server's message. Re-renders when the label arrives. */
export function ErrorText({ error }: { error: UiError }) {
  const { t, preload } = useLanguage();
  const key = error.code ? `error.${error.code.toLowerCase()}` : null;
  if (key) preload([key]);
  const label = key ? t(key) : null;
  const text = label && label !== key ? label : error.message;
  return <>{String(text).replace(/\{(\w+)\}/g, (m, name) => (error.params && name in error.params ? String(error.params[name]) : m))}</>;
}

/** Failure reasons stored as the English text of the refusal that caused them; known ones are shown through their registered label with the figures parsed out of the text. */
const KNOWN_REASONS: Array<{ pattern: RegExp; key: string; names: string[] }> = [
  { pattern: /Insufficient treasury balance: requested (\d+(?:\.\d+)?), available (\d+(?:\.\d+)?), short by (\d+(?:\.\d+)?)/, key: 'error.payout_insufficient_balance', names: ['requested', 'available', 'short'] },
];

export function FailureReason({ reason }: { reason: string | null }) {
  const { t, preload } = useLanguage();
  preload(KNOWN_REASONS.map((k) => k.key));
  if (!reason) return <>—</>;
  for (const k of KNOWN_REASONS) {
    const m = reason.match(k.pattern);
    const label = t(k.key);
    if (m && label !== k.key) return <>{label.replace(/\{(\w+)\}/g, (x, name) => (k.names.includes(name) ? m[k.names.indexOf(name) + 1] : x))}</>;
  }
  return <>{reason}</>;
}
