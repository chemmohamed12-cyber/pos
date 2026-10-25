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
