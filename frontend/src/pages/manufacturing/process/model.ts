/**
 * Process definition model helpers (UX redesign stage 3). Pure functions: the screen's structure/graph/check logic lives here so it is testable and the components stay presentational.
 * The checks MIRROR the server's rules for early feedback only - the server (`ProcessDefinitionService`) stays the authority on save and activation and re-validates everything.
 */
export interface Op {
  code: string;
  name: string;
  operationTypeCode: string;
  sequenceNo: number;
  optional: boolean;
  maxRuns: number;
  workCenterId?: string | null;
}
export interface Edge {
  from: string;
  to: string;
}
export interface Inp {
  operationCode: string;
  componentProductId: string;
  quantityPerUnit: number;
  alternateGroup: string;
}
export interface Out {
  operationCode: string;
  productId: string;
  quantityPerUnit: number;
  role: 'good' | 'co_product' | 'by_product';
  intermediate: boolean;
  allocationWeight: number;
}
export interface Body {
  name: string;
  note: string;
  operations: Op[];
  edges: Edge[];
  inputs: Inp[];
  outputs: Out[];
}

export const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Longest-path level of every operation (0 = no predecessor). Operations in a cycle (invalid) are left out of `levels` and listed in `cyclic`. */
export function layout(ops: Op[], edges: Edge[]): { levels: string[][]; level: Map<string, number>; cyclic: string[] } {
  const codes = ops.map((o) => o.code).filter(Boolean);
  const valid = new Set(codes);
  const preds = new Map<string, string[]>(codes.map((c) => [c, []]));
  for (const e of edges) if (valid.has(e.from) && valid.has(e.to) && e.from !== e.to) preds.get(e.to)!.push(e.from);
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const cyclic = new Set<string>();
  const depth = (c: string): number => {
    if (level.has(c)) return level.get(c)!;
    if (visiting.has(c)) {
      cyclic.add(c);
      return 0;
    }
    visiting.add(c);
    const d = Math.max(-1, ...preds.get(c)!.map(depth)) + 1;
    visiting.delete(c);
    level.set(c, d);
    return d;
  };
  for (const c of codes) depth(c);
  const seq = new Map(ops.map((o) => [o.code, o.sequenceNo]));
  const levels: string[][] = [];
  for (const [c, l] of level) (levels[l] ??= []).push(c);
  return { levels: levels.map((l) => (l ?? []).sort((a, b) => (seq.get(a) ?? 0) - (seq.get(b) ?? 0) || a.localeCompare(b))), level, cyclic: [...cyclic] };
}

export type Severity = 'error' | 'warning';
export interface Finding {
  severity: Severity;
  /** terminology code of the message; `params` fills {0},{1}... */
  code: string;
  params: string[];
  /** operation the finding belongs to (so the screen can point at it) */
  op?: string;
}
const f = (severity: Severity, code: string, params: string[] = [], op?: string): Finding => ({ severity, code, params, op });

export function check(body: Body, productId: string, productLabel: (id: string) => string): Finding[] {
  const out: Finding[] = [];
  const codes = new Set<string>();
  if (body.operations.length === 0) out.push(f('error', 'mfg2.pe.chk.no_ops'));
  for (const o of body.operations) {
    if (!CODE_RE.test(o.code ?? '')) out.push(f('error', 'mfg2.pe.chk.bad_code', [o.code || '—'], o.code));
    else if (codes.has(o.code)) out.push(f('error', 'mfg2.pe.chk.dup_code', [o.code], o.code));
    codes.add(o.code);
    if (!(o.name ?? '').trim()) out.push(f('error', 'mfg2.pe.chk.no_name', [o.code || '—'], o.code));
    if (!Number.isInteger(o.maxRuns) || o.maxRuns < 1 || o.maxRuns > 50) out.push(f('error', 'mfg2.pe.chk.bad_runs', [o.code], o.code));
  }
  const seen = new Set<string>();
  for (const e of body.edges) {
    if (!codes.has(e.from) || !codes.has(e.to)) out.push(f('error', 'mfg2.pe.chk.edge_unknown', [e.from || '—', e.to || '—']));
    else if (e.from === e.to) out.push(f('error', 'mfg2.pe.chk.edge_self', [e.from], e.from));
    else if (seen.has(`${e.from}>${e.to}`)) out.push(f('error', 'mfg2.pe.chk.edge_dup', [e.from, e.to]));
    seen.add(`${e.from}>${e.to}`);
  }
  const lay = layout(body.operations, body.edges);
  if (lay.cyclic.length > 0) out.push(f('error', 'mfg2.pe.chk.cycle', [lay.cyclic.join(', ')]));

  const groups = new Map<string, number>();
  for (const i of body.inputs) {
    if (!codes.has(i.operationCode)) out.push(f('error', 'mfg2.pe.chk.input_op', [i.operationCode || '—']));
    if (!i.componentProductId) out.push(f('error', 'mfg2.pe.chk.input_product', [i.operationCode || '—'], i.operationCode));
    if (!Number.isInteger(i.quantityPerUnit) || i.quantityPerUnit < 1) out.push(f('error', 'mfg2.pe.chk.input_qty', [i.operationCode || '—'], i.operationCode));
    const g = i.alternateGroup.trim();
    if (g) groups.set(`${i.operationCode}|${g}`, (groups.get(`${i.operationCode}|${g}`) ?? 0) + 1);
  }
  for (const [k, n] of groups) if (n < 2) out.push(f('error', 'mfg2.pe.chk.alt_group', [k.split('|')[1], k.split('|')[0]], k.split('|')[0]));

  for (const o of body.outputs) {
    if (!codes.has(o.operationCode)) out.push(f('error', 'mfg2.pe.chk.output_op', [o.operationCode || '—']));
    if (!o.productId) out.push(f('error', 'mfg2.pe.chk.output_product', [o.operationCode || '—'], o.operationCode));
    if (!Number.isInteger(o.quantityPerUnit) || o.quantityPerUnit < 1) out.push(f('error', 'mfg2.pe.chk.output_qty', [o.operationCode || '—'], o.operationCode));
    if (!Number.isInteger(o.allocationWeight) || o.allocationWeight < 0) out.push(f('error', 'mfg2.pe.chk.output_weight', [o.operationCode || '—'], o.operationCode));
  }
  const finals = body.outputs.filter((o) => !o.intermediate);
  if (body.operations.length > 0) {
    if (!finals.some((o) => o.role === 'good' && o.productId === productId)) out.push(f('error', 'mfg2.pe.chk.own_product', [productLabel(productId)]));
    if (!finals.some((o) => o.allocationWeight > 0)) out.push(f('error', 'mfg2.pe.chk.final_weight'));
  }
  // an intermediate must be consumed by an operation that comes AFTER the one producing it
  const reach = (from: string): Set<string> => {
    const seenOps = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const c = stack.pop()!;
      for (const e of body.edges) if (e.from === c && !seenOps.has(e.to)) {
        seenOps.add(e.to);
        stack.push(e.to);
      }
    }
    return seenOps;
  };
  for (const o of body.outputs.filter((x) => x.intermediate)) {
    const consumers = body.inputs.filter((i) => i.componentProductId === o.productId && i.operationCode !== o.operationCode).map((i) => i.operationCode);
    if (consumers.length === 0) out.push(f('error', 'mfg2.pe.chk.inter_unused', [productLabel(o.productId), o.operationCode], o.operationCode));
    else if (!consumers.some((c) => reach(o.operationCode).has(c))) out.push(f('error', 'mfg2.pe.chk.inter_order', [productLabel(o.productId), o.operationCode], o.operationCode));
  }
  // advisory only
  for (const o of body.operations) {
    const hasIn = body.inputs.some((i) => i.operationCode === o.code);
    const hasPred = body.edges.some((e) => e.to === o.code);
    const hasOut = body.outputs.some((x) => x.operationCode === o.code);
    const hasSucc = body.edges.some((e) => e.from === o.code);
    if (o.code && !hasIn && !hasPred) out.push(f('warning', 'mfg2.pe.chk.warn_no_inputs', [o.code], o.code));
    if (o.code && !hasOut && !hasSucc) out.push(f('warning', 'mfg2.pe.chk.warn_no_outputs', [o.code], o.code));
  }
  return out;
}

export const fill = (text: string, params: string[]) => params.reduce((s, p, i) => s.split(`{${i}}`).join(p), text);
