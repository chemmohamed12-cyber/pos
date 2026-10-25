import { unmetPredecessors, ReadinessRun } from './process-readiness';

const graph = (edges: Array<[string, string]>) => {
  const preds = new Map<string, string[]>();
  for (const [from, to] of edges) (preds.get(to) ?? preds.set(to, []).get(to)!).push(from);
  return preds;
};
const run = (operationCode: string, status: string): ReadinessRun => ({ operationCode, status });

describe('process readiness - one rule for the execution view and the start gate', () => {
  const opt = new Map<string, boolean>([['A', false], ['B', true], ['C', false], ['D', false], ['E', true]]);

  it('a start operation has no blockers', () => {
    expect(unmetPredecessors('A', graph([['A', 'B']]), opt, [])).toEqual([]);
  });

  it('a mandatory predecessor blocks until it has a completed run; a running one blocks too', () => {
    const g = graph([['A', 'C']]);
    expect(unmetPredecessors('C', g, opt, [])).toEqual(['A']);
    expect(unmetPredecessors('C', g, opt, [run('A', 'running')])).toEqual(['A']);
    expect(unmetPredecessors('C', g, opt, [run('A', 'completed')])).toEqual([]);
  });

  it('A -> optional B -> C: C stays behind A even though B is optional (the branch bug)', () => {
    const g = graph([['A', 'B'], ['B', 'C']]);
    expect(unmetPredecessors('C', g, opt, [])).toEqual(['A']);
    expect(unmetPredecessors('C', g, opt, [run('A', 'running')])).toEqual(['A']);
    // once A is completed, C may start without B (B is optional and not running), whether B was skipped or never started
    expect(unmetPredecessors('C', g, opt, [run('A', 'completed')])).toEqual([]);
    expect(unmetPredecessors('C', g, opt, [run('A', 'completed'), run('B', 'skipped')])).toEqual([]);
  });

  it('a running optional predecessor blocks; once completed it no longer does', () => {
    const g = graph([['A', 'B'], ['B', 'C']]);
    expect(unmetPredecessors('C', g, opt, [run('A', 'completed'), run('B', 'running')])).toEqual(['B']);
    expect(unmetPredecessors('C', g, opt, [run('A', 'completed'), run('B', 'completed')])).toEqual([]);
  });

  it('a join waits for every branch, reports each blocker once, and parallel branches do not block each other', () => {
    const g = graph([['A', 'C'], ['B', 'C'], ['A', 'D'], ['E', 'D']]);
    expect(unmetPredecessors('C', g, opt, [run('A', 'completed')])).toEqual([]); // B is optional and untouched
    expect(unmetPredecessors('C', g, opt, [])).toEqual(['A']); // optional B is transparent but has no predecessors itself
    const diamond = graph([['A', 'B'], ['A', 'E'], ['B', 'D'], ['E', 'D']]);
    expect(unmetPredecessors('D', diamond, opt, [])).toEqual(['A']); // both optional branches lead back to A: reported once
    expect(unmetPredecessors('D', diamond, opt, [run('A', 'completed')])).toEqual([]);
  });
});
