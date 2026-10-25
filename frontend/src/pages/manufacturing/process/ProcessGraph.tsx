import { useLanguage } from '../../../context/LanguageContext';
import { layout, type Edge, type Op } from './model';

const W = 168;
const H = 56;
const COL = 64;
const ROW = 20;
const PAD = 12;

/**
 * The process as a left-to-right (right-to-left in Arabic) layered graph: one column per dependency level, arrows exactly the saved/edited predecessor links.
 * Optional operations have a dashed border, repeatable ones a ×N badge. It is a visual aid - the structured list beside it carries the same information for keyboard and screen-reader users.
 */
export function ProcessGraph({ ops, edges, selected, onSelect, typeLabel }: { ops: Op[]; edges: Edge[]; selected: string | null; onSelect: (code: string) => void; typeLabel: (code: string) => string }) {
  const { t, lang } = useLanguage();
  const rtl = lang === 'ar';
  const { levels, level } = layout(ops, edges);
  const tallest = Math.max(1, ...levels.map((l) => l.length));
  const width = PAD * 2 + levels.length * W + Math.max(0, levels.length - 1) * COL;
  const height = PAD * 2 + tallest * H + (tallest - 1) * ROW;
  const pos = new Map<string, { x: number; y: number }>();
  levels.forEach((col, ci) => {
    const colHeight = col.length * H + (col.length - 1) * ROW;
    col.forEach((code, ri) => {
      const xLtr = PAD + ci * (W + COL);
      pos.set(code, { x: rtl ? width - xLtr - W : xLtr, y: PAD + (height - PAD * 2 - colHeight) / 2 + ri * (H + ROW) });
    });
  });
  const byCode = new Map(ops.map((o) => [o.code, o]));
  const drawn = edges.filter((e) => pos.has(e.from) && pos.has(e.to) && e.from !== e.to && (level.get(e.to) ?? 0) > (level.get(e.from) ?? 0));
  if (levels.length === 0) return null;
  const label = t('mfg2.pe.graph.label').replace('{0}', String(ops.length)).replace('{1}', String(edges.length));
  return (
    <div className="mfg-graph-wrap" tabIndex={0} role="region" aria-label={t('mfg2.pe.graph.title')}>
      <svg role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="mfg-graph">
        <defs>
          <marker id="mfg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#6b7280" />
          </marker>
        </defs>
        {drawn.map((e) => {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          const x1 = rtl ? a.x : a.x + W;
          const x2 = rtl ? b.x + W : b.x;
          const y1 = a.y + H / 2;
          const y2 = b.y + H / 2;
          const mid = (x1 + x2) / 2;
          return <path key={`${e.from}>${e.to}`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} fill="none" stroke="#6b7280" strokeWidth={1.6} markerEnd="url(#mfg-arrow)" />;
        })}
        {levels.flat().map((code) => {
          const o = byCode.get(code)!;
          const p = pos.get(code)!;
          const sel = selected === code;
          return (
            <g
              key={code}
              transform={`translate(${p.x},${p.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${code} ${o.name}`}
              aria-pressed={sel}
              onClick={() => onSelect(code)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onSelect(code);
                }
              }}
              style={{ cursor: 'pointer' }}
            >
              <rect width={W} height={H} rx={10} fill={sel ? '#dbe7ff' : '#fff'} stroke={sel ? '#2f5fd7' : '#9aa3b2'} strokeWidth={sel ? 2.4 : 1.4} strokeDasharray={o.optional ? '5 4' : undefined} />
              <text x={W / 2} y={22} textAnchor="middle" fontSize={13} fontWeight={700} fill="#111827">
                {code.length > 20 ? `${code.slice(0, 19)}…` : code}
              </text>
              <text x={W / 2} y={40} textAnchor="middle" fontSize={11.5} fill="#4b5563">
                {(o.name || typeLabel(o.operationTypeCode)).slice(0, 24)}
              </text>
              {o.maxRuns > 1 && (
                <g transform={`translate(${rtl ? 4 : W - 34},-8)`}>
                  <rect width={30} height={17} rx={8} fill="#1e3a8a" />
                  <text x={15} y={12.5} textAnchor="middle" fontSize={10.5} fill="#fff">{`×${o.maxRuns}`}</text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
