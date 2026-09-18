import { useLanguage } from '../context/LanguageContext';

const NEGATIVE_HINTS = ['reject', 'fail', 'cancel', 'return'];
const POSITIVE_HINTS = ['approve', 'released', 'delivered', 'closed', 'restock', 'authorized'];

function toneFor(code: string): 'positive' | 'warning' | 'negative' | '' {
  const lower = code.toLowerCase();
  if (NEGATIVE_HINTS.some((h) => lower.includes(h))) return 'negative';
  if (POSITIVE_HINTS.some((h) => lower.includes(h))) return 'positive';
  if (lower.includes('pending') || lower.includes('review') || lower.includes('progress')) return 'warning';
  return '';
}

/** Resolves a Terminology Registry code (state/action) and colors the badge by simple keyword heuristics on the code itself — not a second parallel vocabulary to keep in sync. */
export function StatusBadge({ code }: { code: string }) {
  const { t, preload } = useLanguage();
  preload([code]);
  const tone = toneFor(code);
  return <span className={`status-badge ${tone}`}>{t(code)}</span>;
}
