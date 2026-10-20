import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

interface CodeState {
  value: string;
  defaultCode: string;
  /** true once the user has typed something other than the default */
  custom: boolean;
}

/**
 * The code field of a "new item / customer / supplier" form (owner request 2026-10-20): it starts with the next sequential code of its own kind
 * (`GET <path>` → `{ code }`, a preview — nothing is issued yet) and the user may type another one. Left unchanged, nothing is sent and the server issues
 * the real serial (so two people can never end up with the same one); a typed code is sent as it is and the server refuses a duplicate.
 */
export function useDefaultCode(path: string, enabled = true) {
  const [state, setState] = useState<CodeState>({ value: '', defaultCode: '', custom: false });

  /** A fresh preview arrived: always remember it; show it unless the user has typed their own code (or `force`). */
  const apply = useCallback((code: string, force: boolean) => {
    setState((prev) => (force || !prev.custom ? { value: code, defaultCode: code, custom: false } : { ...prev, defaultCode: code }));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api
      .get<{ code: string }>(path)
      .then(({ code }) => live && apply(code, true))
      .catch(() => undefined); // no permission or an older server: the field stays empty and the server issues the code
    return () => {
      live = false;
    };
  }, [enabled, path, apply]);

  const typed = state.value.trim();
  return {
    value: state.value,
    setValue: (v: string) => setState((prev) => ({ ...prev, value: v, custom: v.trim() !== '' && v.trim() !== prev.defaultCode })),
    defaultCode: state.defaultCode,
    /** `undefined` (= "issue the next serial") while the field still holds the default or is empty; otherwise the typed code, trimmed. */
    payloadCode: (): string | undefined => (!typed || typed === state.defaultCode ? undefined : typed),
    /** After a successful save: show the new next serial. */
    reset: () => {
      api
        .get<{ code: string }>(path)
        .then(({ code }) => apply(code, true))
        .catch(() => undefined);
    },
    restoreDefault: () => setState((prev) => ({ ...prev, value: prev.defaultCode, custom: false })),
    isCustom: state.custom,
  };
}
