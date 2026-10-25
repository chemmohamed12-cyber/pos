import { useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../../../context/LanguageContext';
import { BlockedReason, EmptyState, FormField, StatusChip } from '../../../components/mfg';
import { ProcessGraph } from './ProcessGraph';
import { check, fill, layout, type Body, type Finding, type Inp, type Op, type Out } from './model';

export interface Product {
  id: string;
  sku: string;
  name: string;
}
export interface OpType {
  code: string;
  nameAr: string;
  nameEn: string;
  kind: string;
  active: boolean;
}

const GRAPH_DEFAULT_LIMIT = 12;

/** Findings as a list; an error blocks activation, a warning only informs. Each points at its operation. */
export function FindingsPanel({ findings, onGo }: { findings: Finding[]; onGo?: (op: string) => void }) {
  const { t } = useLanguage();
  const errors = findings.filter((x) => x.severity === 'error');
  const warnings = findings.filter((x) => x.severity === 'warning');
  if (findings.length === 0) {
    return (
      <div className="mfg-blocked" role="status" style={{ background: '#e7f6ec', borderColor: '#7bc596', color: '#1c7a3e' }}>
        {t('mfg2.pe.chk.all_ok')}
      </div>
    );
  }
  const render = (list: Finding[], tone: 'danger' | 'warning') => (
    <ul className="mfg-findings">
      {list.map((x, i) => (
        <li key={`${x.code}-${i}`}>
          <StatusChip tone={tone}>{tone === 'danger' ? t('mfg2.pe.chk.error') : t('mfg2.pe.chk.warning')}</StatusChip> {fill(t(x.code), x.params)}{' '}
          {x.op && onGo && (
            <button type="button" className="mfg-link" onClick={() => onGo(x.op!)}>
              {t('mfg2.pe.chk.go')} {x.op}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <div aria-live="polite">
      {errors.length > 0 && (
        <>
          <strong>{fill(t('mfg2.pe.chk.errors_title'), [String(errors.length)])}</strong>
          {render(errors, 'danger')}
        </>
      )}
      {warnings.length > 0 && (
        <>
          <strong>{fill(t('mfg2.pe.chk.warnings_title'), [String(warnings.length)])}</strong>
          {render(warnings, 'warning')}
        </>
      )}
    </div>
  );
}

/** The ordered structure of the process in words: stages, what runs in parallel, joins - the same facts as the graph, readable by anyone. */
export function StructureList({ body, label }: { body: Body; label: (code: string) => string }) {
  const { t } = useLanguage();
  const { levels } = layout(body.operations, body.edges);
  if (levels.length === 0) return null;
  return (
    <ol className="mfg-structure" aria-label={t('mfg2.pe.structure.title')}>
      {levels.map((codes, i) => (
        <li key={i}>
          <strong>{fill(t('mfg2.pe.structure.stage'), [String(i + 1)])}</strong>
          {codes.length > 1 && <StatusChip tone="info">{t('mfg2.pe.structure.parallel')}</StatusChip>}
          <ul>
            {codes.map((c) => {
              const o = body.operations.find((x) => x.code === c)!;
              const preds = body.edges.filter((e) => e.to === c).map((e) => e.from);
              return (
                <li key={c}>
                  <span>{label(c)}</span>
                  {o.optional && <StatusChip>{t('mfg2.pe.flag.optional')}</StatusChip>} {o.maxRuns > 1 && <StatusChip>{fill(t('mfg2.pe.flag.repeatable'), [String(o.maxRuns)])}</StatusChip>}{' '}
                  {preds.length > 1 && <StatusChip tone="warning">{fill(t('mfg2.pe.structure.join'), [preds.join(' + ')])}</StatusChip>}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/** Read-only summary of one operation: what it consumes and what it produces. Used by the review step and by non-draft versions. */
export function OperationSummary({ body, o, productLabel, typeLabel }: { body: Body; o: Op; productLabel: (id: string) => string; typeLabel: (c: string) => string }) {
  const { t } = useLanguage();
  const inputs = body.inputs.filter((i) => i.operationCode === o.code);
  const outputs = body.outputs.filter((x) => x.operationCode === o.code);
  const preds = body.edges.filter((e) => e.to === o.code).map((e) => e.from);
  return (
    <div className="mfg-op-card">
      <div className="mfg-op-head">
        <strong>
          {o.code} — {o.name}
        </strong>
        <StatusChip tone="info">{typeLabel(o.operationTypeCode)}</StatusChip>
        {o.optional && <StatusChip>{t('mfg2.pe.flag.optional')}</StatusChip>}
        {o.maxRuns > 1 && <StatusChip>{fill(t('mfg2.pe.flag.repeatable'), [String(o.maxRuns)])}</StatusChip>}
      </div>
      <dl className="mfg-dl">
        <dt>{t('mfg2.pe.op.after')}</dt>
        <dd>{preds.length ? preds.join(' , ') : t('mfg2.pe.op.start')}</dd>
        <dt>{t('mfg2.pe.inputs.title')}</dt>
        <dd>
          {inputs.length === 0
            ? '—'
            : inputs.map((i, k) => (
                <div key={k}>
                  {productLabel(i.componentProductId)} × {i.quantityPerUnit}
                  {i.alternateGroup && <small> ({t('mfg2.pe.inputs.alt')}: {i.alternateGroup})</small>}
                </div>
              ))}
        </dd>
        <dt>{t('mfg2.pe.outputs.title')}</dt>
        <dd>
          {outputs.length === 0
            ? '—'
            : outputs.map((x, k) => (
                <div key={k}>
                  {productLabel(x.productId)} × {x.quantityPerUnit} — {t(`mfg2.pe.role.${x.role}`)} · {x.intermediate ? t('mfg2.pe.out.intermediate') : t('mfg2.pe.out.final')} · {t('mfg2.pe.out.weight')} {x.allocationWeight}
                </div>
              ))}
        </dd>
      </dl>
    </div>
  );
}

interface EditorProps {
  body: Body;
  setBody: (fn: (b: Body) => Body) => void;
  products: Product[];
  types: OpType[];
  productId: string;
  focus: string | null;
  setFocus: (c: string | null) => void;
}

/** The editable body of a DRAFT: operation cards (identity, predecessors, inputs, outputs together), a live structure summary and live checks. */
export function ProcessBodyEditor({ body, setBody, products, types, productId, focus, setFocus }: EditorProps) {
  const { t, lang } = useLanguage();
  const ar = lang === 'ar';
  const [showGraph, setShowGraph] = useState(body.operations.length <= GRAPH_DEFAULT_LIMIT);
  const [open, setOpen] = useState<Set<string>>(() => new Set(body.operations.length <= 6 ? body.operations.map((o) => o.code) : []));
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const prod = (id: string) => products.find((p) => p.id === id);
  const productLabel = (id: string) => (prod(id) ? `${prod(id)!.sku} — ${prod(id)!.name}` : t('mfg2.pe.unset'));
  const typeLabel = (c: string) => {
    const x = types.find((tp) => tp.code === c);
    return x ? (ar ? x.nameAr : x.nameEn) : c;
  };
  const findings = useMemo(() => check(body, productId, productLabel), [body, productId, products]); // eslint-disable-line react-hooks/exhaustive-deps
  const errorsByOp = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of findings) if (x.severity === 'error' && x.op) m.set(x.op, (m.get(x.op) ?? 0) + 1);
    return m;
  }, [findings]);

  const go = (code: string) => {
    setFocus(code);
    setOpen((s) => new Set(s).add(code));
  };
  useEffect(() => {
    if (focus) cardRefs.current.get(focus)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus]);

  const nextCode = () => {
    let n = body.operations.length + 1;
    while (body.operations.some((o) => o.code === `OP-${n}`)) n++;
    return `OP-${n}`;
  };
  const addOp = () => {
    const code = nextCode();
    setBody((b) => ({ ...b, operations: [...b.operations, { code, name: '', operationTypeCode: types.find((x) => x.active)?.code ?? 'transform', sequenceNo: (b.operations.length + 1) * 10, optional: false, maxRuns: 1 }] }));
    go(code);
  };
  const patchOp = (code: string, patch: Partial<Op>) =>
    setBody((b) => {
      const renamed = patch.code !== undefined && patch.code !== code;
      const newCode = patch.code ?? code;
      return {
        ...b,
        operations: b.operations.map((o) => (o.code === code ? { ...o, ...patch } : o)),
        edges: renamed ? b.edges.map((e) => ({ from: e.from === code ? newCode : e.from, to: e.to === code ? newCode : e.to })) : b.edges,
        inputs: renamed ? b.inputs.map((i) => (i.operationCode === code ? { ...i, operationCode: newCode } : i)) : b.inputs,
        outputs: renamed ? b.outputs.map((x) => (x.operationCode === code ? { ...x, operationCode: newCode } : x)) : b.outputs,
      };
    });
  /** A rename keeps every reference (links, inputs, outputs) and the open/selected state pointing at the same operation. */
  const renameOp = (code: string, to: string) => {
    patchOp(code, { code: to });
    setOpen((s) => (s.has(code) ? new Set([...s].map((c) => (c === code ? to : c))) : s));
    if (focus === code) setFocus(to);
  };
  const removeOp = (code: string) =>
    setBody((b) => ({ ...b, operations: b.operations.filter((o) => o.code !== code), edges: b.edges.filter((e) => e.from !== code && e.to !== code), inputs: b.inputs.filter((i) => i.operationCode !== code), outputs: b.outputs.filter((x) => x.operationCode !== code) }));
  const togglePred = (code: string, pred: string, on: boolean) =>
    setBody((b) => ({ ...b, edges: on ? [...b.edges, { from: pred, to: code }] : b.edges.filter((e) => !(e.from === pred && e.to === code)) }));
  const patchInput = (idx: number, patch: Partial<Inp>) => setBody((b) => ({ ...b, inputs: b.inputs.map((x, j) => (j === idx ? { ...x, ...patch } : x)) }));
  const patchOutput = (idx: number, patch: Partial<Out>) => setBody((b) => ({ ...b, outputs: b.outputs.map((x, j) => (j === idx ? { ...x, ...patch } : x)) }));

  const productSelect = (p: Record<string, unknown>, value: string, onChange: (v: string) => void) => (
    <select {...p} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('mfg2.common.choose')}</option>
      {products.map((x) => (
        <option key={x.id} value={x.id}>
          {x.sku} — {x.name}
        </option>
      ))}
    </select>
  );

  return (
    <div>
      <section aria-labelledby="pe-flow-title" className="card">
        <div className="mfg-row-between">
          <h3 id="pe-flow-title" style={{ margin: 0 }}>
            {t('mfg2.pe.flow.title')}
          </h3>
          {body.operations.length > 0 && (
            <button type="button" className="btn btn-secondary" aria-pressed={showGraph} onClick={() => setShowGraph((v) => !v)}>
              {showGraph ? t('mfg2.pe.graph.hide') : t('mfg2.pe.graph.show')}
            </button>
          )}
        </div>
        <p className="mfg-note">{t('mfg2.pe.flow.help')}</p>
        {body.operations.length === 0 ? <EmptyState title={t('mfg2.pe.empty_title')} description={t('mfg2.pe.empty_desc')} /> : <StructureList body={body} label={(c) => `${c} — ${body.operations.find((o) => o.code === c)?.name || typeLabel(body.operations.find((o) => o.code === c)?.operationTypeCode ?? '')}`} />}
        {showGraph && body.operations.length > 0 && <ProcessGraph ops={body.operations} edges={body.edges} selected={focus} onSelect={go} typeLabel={typeLabel} />}
        {!showGraph && body.operations.length > GRAPH_DEFAULT_LIMIT && <p className="mfg-note">{t('mfg2.pe.graph.large_hint')}</p>}
      </section>

      <section aria-labelledby="pe-ops-title" style={{ marginBlockStart: 16 }}>
        <div className="mfg-row-between">
          <h3 id="pe-ops-title" style={{ margin: 0 }}>
            {t('mfg2.pe.ops.title')}
          </h3>
          <button type="button" className="btn btn-primary" onClick={addOp} data-testid="pe-add-op">
            + {t('mfg2.pe.ops.add')}
          </button>
        </div>
        {[...body.operations]
          .map((o, idx) => ({ o, idx }))
          .map(({ o, idx }) => {
            const isOpen = open.has(o.code);
            const others = body.operations.filter((x) => x.code !== o.code);
            const inputIdx = body.inputs.map((x, i) => [x, i] as const).filter(([x]) => x.operationCode === o.code);
            const outputIdx = body.outputs.map((x, i) => [x, i] as const).filter(([x]) => x.operationCode === o.code);
            const errs = errorsByOp.get(o.code) ?? 0;
            return (
              <article key={idx} className={`mfg-op-card${focus === o.code ? ' focus' : ''}`} ref={(el) => { if (el) cardRefs.current.set(o.code, el); }} aria-label={`${o.code} ${o.name}`}>
                <div className="mfg-op-head">
                  <button
                    type="button"
                    className="mfg-op-toggle"
                    aria-expanded={isOpen}
                    onClick={() =>
                      setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(o.code)) n.delete(o.code);
                        else n.add(o.code);
                        return n;
                      })
                    }
                  >
                    <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> <strong>{o.code}</strong> — {o.name || t('mfg2.pe.op.unnamed')}
                  </button>
                  <StatusChip tone="info">{typeLabel(o.operationTypeCode)}</StatusChip>
                  {o.optional && <StatusChip>{t('mfg2.pe.flag.optional')}</StatusChip>}
                  {o.maxRuns > 1 && <StatusChip>{fill(t('mfg2.pe.flag.repeatable'), [String(o.maxRuns)])}</StatusChip>}
                  {errs > 0 && <StatusChip tone="danger">{fill(t('mfg2.pe.op.errors'), [String(errs)])}</StatusChip>}
                </div>
                {isOpen && (
                  <div className="mfg-op-body">
                    <div className="mfg-grid cols-3">
                      <FormField label={t('mfg2.pe.op.code')} hint={t('mfg2.pe.op.code_hint')} required>
                        {(p) => <input {...p} value={o.code} maxLength={32} onChange={(e) => renameOp(o.code, e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} data-testid={`op-code-${o.code}`} />}
                      </FormField>
                      <FormField label={t('mfg2.pe.op.name')} required>
                        {(p) => <input {...p} value={o.name} onChange={(e) => patchOp(o.code, { name: e.target.value })} data-testid={`op-name-${o.code}`} />}
                      </FormField>
                      <FormField label={t('mfg2.pe.op.type')} hint={t('mfg2.pe.op.type_hint')} required>
                        {(p) => (
                          <select {...p} value={o.operationTypeCode} onChange={(e) => patchOp(o.code, { operationTypeCode: e.target.value })}>
                            {types
                              .filter((tp) => tp.active || tp.code === o.operationTypeCode)
                              .map((tp) => (
                                <option key={tp.code} value={tp.code}>
                                  {ar ? tp.nameAr : tp.nameEn}
                                </option>
                              ))}
                          </select>
                        )}
                      </FormField>
                      <FormField label={t('mfg2.pe.op.seq')} hint={t('mfg2.pe.op.seq_hint')}>
                        {(p) => <input {...p} type="number" step={1} value={o.sequenceNo} onChange={(e) => patchOp(o.code, { sequenceNo: Number(e.target.value) || 0 })} />}
                      </FormField>
                      <FormField label={t('mfg2.pe.op.max_runs')} hint={t('mfg2.pe.op.max_runs_hint')}>
                        {(p) => <input {...p} type="number" min={1} max={50} step={1} value={o.maxRuns} onChange={(e) => patchOp(o.code, { maxRuns: Number(e.target.value) || 1 })} />}
                      </FormField>
                      <div className="mfg-field">
                        <span className="mfg-check-label">{t('mfg2.pe.op.optional')}</span>
                        <label className="mfg-check">
                          <input type="checkbox" checked={o.optional} onChange={(e) => patchOp(o.code, { optional: e.target.checked })} /> {t('mfg2.pe.op.optional_hint')}
                        </label>
                      </div>
                    </div>

                    <fieldset className="mfg-fieldset">
                      <legend>{t('mfg2.pe.op.after')}</legend>
                      {others.length === 0 ? (
                        <span className="mfg-note">{t('mfg2.pe.op.no_others')}</span>
                      ) : (
                        <div className="mfg-checks">
                          {others.map((x) => (
                            <label key={x.code} className="mfg-check">
                              <input type="checkbox" checked={body.edges.some((e) => e.from === x.code && e.to === o.code)} onChange={(e) => togglePred(o.code, x.code, e.target.checked)} /> {x.code}
                            </label>
                          ))}
                        </div>
                      )}
                      <div className="mfg-note">{t('mfg2.pe.op.after_hint')}</div>
                    </fieldset>

                    <h4 className="mfg-h4">{t('mfg2.pe.inputs.title')}</h4>
                    <p className="mfg-note">{t('mfg2.pe.inputs.help')}</p>
                    {inputIdx.length === 0 && <div className="mfg-note">{t('mfg2.pe.inputs.none')}</div>}
                    {inputIdx.map(([x, i]) => (
                      <div key={i} className="mfg-subrow">
                        <FormField label={t('mfg2.pe.inputs.product')} required>
                          {(p) => productSelect(p, x.componentProductId, (v) => patchInput(i, { componentProductId: v }))}
                        </FormField>
                        <FormField label={t('mfg2.pe.inputs.qty')} hint={t('mfg2.pe.qty_hint')} required>
                          {(p) => <input {...p} type="number" min={1} step={1} value={x.quantityPerUnit} onChange={(e) => patchInput(i, { quantityPerUnit: Number(e.target.value) || 0 })} />}
                        </FormField>
                        <FormField label={t('mfg2.pe.inputs.alt')} hint={t('mfg2.pe.inputs.alt_hint')}>
                          {(p) => <input {...p} value={x.alternateGroup} onChange={(e) => patchInput(i, { alternateGroup: e.target.value })} />}
                        </FormField>
                        <button type="button" className="btn btn-secondary mfg-remove" aria-label={t('mfg2.pe.remove')} onClick={() => setBody((b) => ({ ...b, inputs: b.inputs.filter((_, j) => j !== i) }))}>
                          ×
                        </button>
                      </div>
                    ))}
                    <button type="button" className="btn btn-secondary" onClick={() => setBody((b) => ({ ...b, inputs: [...b.inputs, { operationCode: o.code, componentProductId: '', quantityPerUnit: 1, alternateGroup: '' }] }))}>
                      + {t('mfg2.pe.inputs.add')}
                    </button>

                    <h4 className="mfg-h4">{t('mfg2.pe.outputs.title')}</h4>
                    <p className="mfg-note">{t('mfg2.pe.outputs.help')}</p>
                    {outputIdx.length === 0 && <div className="mfg-note">{t('mfg2.pe.outputs.none')}</div>}
                    {outputIdx.map(([x, i]) => (
                      <div key={i} className="mfg-subrow outputs">
                        <FormField label={t('mfg2.pe.outputs.product')} required>
                          {(p) => productSelect(p, x.productId, (v) => patchOutput(i, { productId: v }))}
                        </FormField>
                        <FormField label={t('mfg2.pe.outputs.qty')} hint={t('mfg2.pe.qty_hint')} required>
                          {(p) => <input {...p} type="number" min={1} step={1} value={x.quantityPerUnit} onChange={(e) => patchOutput(i, { quantityPerUnit: Number(e.target.value) || 0 })} />}
                        </FormField>
                        <FormField label={t('mfg2.pe.out.role')}>
                          {(p) => (
                            <select {...p} value={x.role} onChange={(e) => patchOutput(i, { role: e.target.value as Out['role'] })}>
                              {(['good', 'co_product', 'by_product'] as const).map((r) => (
                                <option key={r} value={r}>
                                  {t(`mfg2.pe.role.${r}`)}
                                </option>
                              ))}
                            </select>
                          )}
                        </FormField>
                        <FormField label={t('mfg2.pe.out.kind')} hint={x.intermediate ? t('mfg2.pe.out.intermediate_hint') : t('mfg2.pe.out.final_hint')}>
                          {(p) => (
                            <select {...p} value={x.intermediate ? 'intermediate' : 'final'} onChange={(e) => patchOutput(i, { intermediate: e.target.value === 'intermediate' })}>
                              <option value="final">{t('mfg2.pe.out.final')}</option>
                              <option value="intermediate">{t('mfg2.pe.out.intermediate')}</option>
                            </select>
                          )}
                        </FormField>
                        <FormField label={t('mfg2.pe.out.weight')} hint={t('mfg2.pe.out.weight_hint')}>
                          {(p) => <input {...p} type="number" min={0} step={1} value={x.allocationWeight} onChange={(e) => patchOutput(i, { allocationWeight: Number(e.target.value) || 0 })} />}
                        </FormField>
                        <button type="button" className="btn btn-secondary mfg-remove" aria-label={t('mfg2.pe.remove')} onClick={() => setBody((b) => ({ ...b, outputs: b.outputs.filter((_, j) => j !== i) }))}>
                          ×
                        </button>
                      </div>
                    ))}
                    <button type="button" className="btn btn-secondary" onClick={() => setBody((b) => ({ ...b, outputs: [...b.outputs, { operationCode: o.code, productId: '', quantityPerUnit: 1, role: 'good', intermediate: false, allocationWeight: 1 }] }))}>
                      + {t('mfg2.pe.outputs.add')}
                    </button>

                    <div className="mfg-actions">
                      <button type="button" className="btn btn-danger" onClick={() => removeOp(o.code)}>
                        {t('mfg2.pe.op.remove')}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
      </section>

      <section aria-labelledby="pe-chk-title" className="card" style={{ marginBlockStart: 16 }}>
        <h3 id="pe-chk-title" style={{ marginBlockStart: 0 }}>
          {t('mfg2.pe.chk.title')}
        </h3>
        <p className="mfg-note">{t('mfg2.pe.chk.help')}</p>
        <FindingsPanel findings={findings} onGo={go} />
      </section>
      {findings.some((x) => x.severity === 'error') && <div style={{ marginBlockStart: 8 }}><BlockedReason>{t('mfg2.pe.chk.cannot_activate')}</BlockedReason></div>}
    </div>
  );
}
