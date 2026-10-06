// Standardized API error presentation — the ONE place that turns an ApiError
// (backend contract: `{success:false, error:{code,message,details}}`, see
// `all-exceptions.filter.ts` / `http-status-to-code.ts`) into what a screen
// shows. Never invents a code the backend doesn't send; unknown codes fall
// back to the server's own `message` rather than a guessed translation.
import { ApiError } from './api';
import type { Lang } from '../context/LanguageContext';

export type ErrorKind = 'auth' | 'forbidden' | 'validation' | 'conflict' | 'not_found' | 'network' | 'server' | 'unknown';

export interface ErrorDisplay {
  kind: ErrorKind;
  title: string;
  message: string;
  /** True when retrying the same request is likely to help (network/server) vs. not (validation/auth/forbidden). */
  retryable: boolean;
}

const TITLES: Record<ErrorKind, { ar: string; en: string }> = {
  auth: { ar: 'يجب تسجيل الدخول', en: 'Sign-in required' },
  forbidden: { ar: 'غير مصرح لك بهذا الإجراء', en: 'Not authorized' },
  validation: { ar: 'بيانات غير صحيحة', en: 'Invalid data' },
  conflict: { ar: 'تعارض في العملية', en: 'Operation conflict' },
  not_found: { ar: 'العنصر غير موجود', en: 'Not found' },
  network: { ar: 'تعذر الاتصال بالخادم', en: 'Could not reach the server' },
  server: { ar: 'حدث خطأ في الخادم', en: 'Server error' },
  unknown: { ar: 'حدث خطأ غير متوقع', en: 'Something went wrong' },
};

function codeToKind(code: string, status: number): ErrorKind {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'auth';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'VALIDATION_ERROR':
    case 'UNPROCESSABLE_ENTITY':
      return 'validation';
    case 'CONFLICT':
      return 'conflict';
    case 'NOT_FOUND':
      return 'not_found';
    case 'INTERNAL_ERROR':
      return 'server';
    default:
      if (status === 0) return 'network';
      if (status >= 500) return 'server';
      return 'unknown';
  }
}

/** Central classifier — every screen's catch block should go through this instead of inspecting `ApiError` fields itself. */
export function describeError(err: unknown, lang: Lang): ErrorDisplay {
  if (err instanceof ApiError) {
    const kind = codeToKind(err.code, err.status);
    return {
      kind,
      title: TITLES[kind][lang],
      // The backend's own message is already user-safe (AllExceptionsFilter never leaks internals) —
      // prefer it over a generic string so validation/conflict errors stay specific and actionable.
      message: err.message || TITLES[kind][lang],
      retryable: kind === 'network' || kind === 'server',
    };
  }
  // A thrown non-ApiError at this layer means `fetch` itself failed (offline, DNS, CORS) — network kind.
  return {
    kind: 'network',
    title: TITLES.network[lang],
    message: lang === 'ar' ? 'تحقق من اتصالك بالشبكة وحاول مرة أخرى.' : 'Check your connection and try again.',
    retryable: true,
  };
}
