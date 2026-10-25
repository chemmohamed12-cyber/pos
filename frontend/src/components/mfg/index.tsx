import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../context/LanguageContext';
import './mfg.css';

/** A labelled form control: persistent visible label, optional hint, required marker, accessible error. The child receives the ids/aria props to spread on its control. */
export function FormField({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: (p: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; 'aria-required'?: boolean }) => ReactNode;
}) {
  const { t } = useLanguage();
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="mfg-field">
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="mfg-required" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="mfg-sr-only"> ({t('mfg2.common.required')})</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined, 'aria-required': required || undefined })}
      {hint && (
        <div id={hintId} className="mfg-field-hint">
          {hint}
        </div>
      )}
      {error && (
        <div id={errId} className="mfg-field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  align?: 'start' | 'end' | 'center';
  render?: (row: T) => ReactNode;
}

/** A table with permanent column headings, a caption, a readable empty state and horizontal scroll on narrow screens (focusable so keyboard users can scroll). */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  warnRow,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  caption: string;
  empty?: ReactNode;
  warnRow?: (row: T) => boolean;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const cls = (a?: string) => (a === 'end' ? 'mfg-end' : a === 'center' ? 'mfg-center' : undefined);
  return (
    <div className="mfg-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="mfg-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cls(c.align)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={warnRow?.(r) ? 'mfg-row-warn' : undefined}>
              {columns.map((c) => (
                <td key={c.key} className={cls(c.align)}>
                  {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export function StatusChip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`mfg-chip ${tone === 'neutral' ? '' : tone}`}>{children}</span>;
}

/** An empty list is never silent: it says what is missing and offers the way forward. */
export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mfg-empty">
      <strong>{title}</strong>
      {description && <div>{description}</div>}
      {action && <div className="mfg-empty-action">{action}</div>}
    </div>
  );
}

export function StepIndicator({ steps, current, label }: { steps: string[]; current: number; label: string }) {
  return (
    <ol className="mfg-steps" aria-label={label}>
      {steps.map((s, i) => (
        <li key={s} aria-current={i === current ? 'step' : undefined} className={i < current ? 'mfg-done' : undefined}>
          <span className="mfg-step-num" aria-hidden="true">
            {i < current ? '✓' : i + 1}
          </span>
          {s}
        </li>
      ))}
    </ol>
  );
}

/** Why something is unavailable, and where to fix it (the link is shown only when the caller decided the user may follow it). */
export function BlockedReason({ children, to, linkText, danger }: { children: ReactNode; to?: string; linkText?: string; danger?: boolean }) {
  return (
    <div className={`mfg-blocked${danger ? ' mfg-danger' : ''}`} role="status">
      <div>
        {children}
        {to && linkText && (
          <>
            {' '}
            <Link to={to}>{linkText}</Link>
          </>
        )}
      </div>
    </div>
  );
}

export function LinkButton({ to, children, primary }: { to: string; children: ReactNode; primary?: boolean }) {
  return (
    <Link to={to} className={`btn ${primary ? 'btn-primary' : 'btn-secondary'} mfg-linkbtn mfg-btn-focus`}>
      {children}
    </Link>
  );
}
