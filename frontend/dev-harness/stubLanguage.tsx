import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Lang = 'ar' | 'en';
interface Value { lang: Lang; setLang: (l: Lang) => void; t: (code: string) => string; preload: (codes: string[]) => Promise<void> }
const Ctx = createContext<Value | null>(null);

/** Harness stub: terminology codes render as themselves (the Treasury pages are inline-bilingual and do not depend on the registry). */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>((localStorage.getItem('daii_lang') as Lang) || 'ar');
  useEffect(() => {
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);
  const value: Value = {
    lang,
    setLang: (l) => { localStorage.setItem('daii_lang', l); setLangState(l); },
    t: (c) => c,
    preload: async () => undefined,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useLanguage() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLanguage outside provider');
  return v;
}
