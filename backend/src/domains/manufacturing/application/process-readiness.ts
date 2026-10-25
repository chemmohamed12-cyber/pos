/**
 * Readiness of an operation in a process graph (UX redesign stage 4) - ONE rule shared by the execution view and the start gate, so what the screen shows is exactly what the server enforces.
 * A predecessor is satisfied when it has a completed run. An OPTIONAL predecessor that is not running (skipped or simply not started) is transparent: it does not block, but whatever it was itself
 * waiting for still does (A -> optional B -> C keeps C behind A). A running predecessor always blocks. Returns the operations that actually still block, in discovery order, without duplicates.
 */
export interface ReadinessRun {
  operationCode: string;
  status: string;
}

export function unmetPredecessors(code: string, preds: Map<string, string[]>, optional: Map<string, boolean>, runs: ReadinessRun[]): string[] {
  const runsOf = (c: string) => runs.filter((r) => r.operationCode === c);
  const seen = new Set<string>();
  const walk = (c: string): string[] => {
    const out: string[] = [];
    for (const p of preds.get(c) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      const rs = runsOf(p);
      if (rs.some((r) => r.status === 'running')) out.push(p);
      else if (rs.some((r) => r.status === 'completed')) continue;
      else if (optional.get(p)) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  return [...new Set(walk(code))];
}
