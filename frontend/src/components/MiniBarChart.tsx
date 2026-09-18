/**
 * CTO directive ("Section Cover / Main Dashboard System") — a real,
 * data-driven horizontal bar breakdown with zero external dependency
 * (this codebase's own established precedent: no PDF library, no
 * WYSIWYG editor — reach for the platform first). Deliberately plain
 * CSS-width bars, not inline SVG: legible in both languages/directions
 * without any RTL math, and trivial to reuse for every section's own
 * "top N" breakdown (products, reps, accounts, custodians, ...).
 */
export function MiniBarChart({
  data,
  formatValue,
}: {
  data: Array<{ label: string; value: number }>;
  formatValue?: (value: number) => string;
}) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.value), 1);
  const format = formatValue ?? ((v: number) => String(v));

  return (
    <div>
      {data.map((d) => (
        <div key={d.label} className="mini-bar-chart-row">
          <div className="mini-bar-chart-label" title={d.label}>
            {d.label}
          </div>
          <div style={{ flex: 1, background: '#f2f3f5', borderRadius: 4, overflow: 'hidden', height: 14 }}>
            <div
              style={{
                width: `${Math.max((d.value / max) * 100, 2)}%`,
                background: '#2f5fd7',
                height: '100%',
                borderRadius: 4,
              }}
            />
          </div>
          <div className="mini-bar-chart-value">{format(d.value)}</div>
        </div>
      ))}
    </div>
  );
}
