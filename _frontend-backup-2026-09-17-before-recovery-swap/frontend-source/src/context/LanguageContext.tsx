import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';

export type Lang = 'ar' | 'en';

interface LanguageContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Resolves a Terminology Registry code to its localized label — never blank, falls back to the raw code while loading/missing (ADR-011: business logic uses codes, never hardcoded per-domain strings). */
  t: (code: string) => string;
  /** Ensures a batch of codes is loaded before rendering a screen that needs them. */
  preload: (codes: string[]) => Promise<void>;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

const STORAGE_KEY = 'daii_lang';

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>((localStorage.getItem(STORAGE_KEY) as Lang) || 'ar');
  // Cache per-language so switching language doesn't lose previously loaded labels.
  const [cache, setCache] = useState<Record<Lang, Record<string, string>>>({ ar: {}, en: {} });

  // REAL BUG FOUND AND FIXED (Shipping Screen Redesign directive §15 —
  // "Avoid unnecessary repeated API calls"): `t()`'s fallback used to call
  // `preload([code])` directly, one HTTP request per missing code. A page
  // with many components each calling `t()` for dozens of not-yet-cached
  // codes during the same render pass fired dozens of individual
  // `/terminology` requests simultaneously — reproduced live: a normal
  // page load threw the backend's own rate limiter (429 ThrottlerException,
  // 300 req/60s) and every label on screen fell back to its raw code.
  // Fixed by coalescing every code requested within the same tick (both
  // from `t()`'s fallback AND from explicit `preload()` calls) into one
  // batched request via a microtask-scheduled flush, with an in-flight
  // guard so overlapping calls never re-request the same code twice.
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const pendingRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const flushScheduledRef = useRef(false);

  useEffect(() => {
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);

  function setLang(l: Lang) {
    localStorage.setItem(STORAGE_KEY, l);
    setLangState(l);
  }

  function scheduleFlush() {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    setTimeout(async () => {
      flushScheduledRef.current = false;
      const batch = [...pendingRef.current].filter((c) => !(c in cacheRef.current[lang]) && !inFlightRef.current.has(c));
      pendingRef.current.clear();
      if (batch.length === 0) return;
      batch.forEach((c) => inFlightRef.current.add(c));
      try {
        const resolved = await api.get<Record<string, string>>(`/terminology?codes=${encodeURIComponent(batch.join(','))}&lang=${lang}`);
        setCache((prev) => ({ ...prev, [lang]: { ...prev[lang], ...resolved } }));
      } finally {
        batch.forEach((c) => inFlightRef.current.delete(c));
      }
    }, 0);
  }

  async function preload(codes: string[]) {
    const missing = codes.filter((c) => !(c in cacheRef.current[lang]));
    if (missing.length === 0) return;
    missing.forEach((c) => pendingRef.current.add(c));
    scheduleFlush();
  }

  function t(code: string): string {
    const value = cache[lang][code];
    if (value !== undefined) return value;
    // Not loaded yet — queue it into the next batched fetch and show the
    // raw code meanwhile (never blank, per ADR-011/TerminologyService).
    pendingRef.current.add(code);
    scheduleFlush();
    return code;
  }

  return <LanguageContext.Provider value={{ lang, setLang, t, preload }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider');
  return ctx;
}
