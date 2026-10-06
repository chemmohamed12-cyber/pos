import { useLanguage } from '../context/LanguageContext';
import { describeError } from '../lib/errors';

/**
 * The standard way a screen renders a failed request — every page's catch
 * branch should render this instead of a bespoke "Something went wrong"
 * string, so error presentation is consistent across the whole app
 * (Foundation directive: standardize auth/401/403/validation/conflict/
 * network/server representation).
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { lang } = useLanguage();
  const display = describeError(error, lang);

  return (
    <div className={`error-state error-state-${display.kind}`} role="alert">
      <div className="error-state-title">{display.title}</div>
      <div className="error-state-message">{display.message}</div>
      {display.retryable && onRetry && (
        <button className="btn btn-secondary" onClick={onRetry} type="button">
          {lang === 'ar' ? 'إعادة المحاولة' : 'Retry'}
        </button>
      )}
    </div>
  );
}
