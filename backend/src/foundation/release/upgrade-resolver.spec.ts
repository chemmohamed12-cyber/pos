import { resolveUpgradePath, UpgradeCandidateRelease } from './upgrade-resolver';

function delta(id: string, version: string, baseVersion: string): UpgradeCandidateRelease {
  return { id, version, packageType: 'delta', baseVersion };
}
function full(id: string, version: string): UpgradeCandidateRelease {
  return { id, version, packageType: 'full', baseVersion: null };
}

describe('resolveUpgradePath', () => {
  describe('full packages', () => {
    it('a newer full package installs directly, no intermediate releases', () => {
      const result = resolveUpgradePath('1.0.8', full('r1', '1.0.10'), []);
      expect(result.valid).toBe(true);
      expect(result.chain).toEqual([{ fromVersion: '1.0.8', toVersion: '1.0.10', releaseId: 'r1' }]);
      expect(result.reason).toMatch(/installs directly/);
    });

    it('rejects a full package at the currently installed version — nothing to upgrade', () => {
      const result = resolveUpgradePath('1.0.10', full('r1', '1.0.10'), []);
      expect(result.valid).toBe(false);
      expect(result.chain).toEqual([]);
      expect(result.reason).toMatch(/nothing to upgrade/);
    });

    it('rejects a full package OLDER than the currently installed version — never authorizes a downgrade', () => {
      const result = resolveUpgradePath('1.0.10', full('r1', '1.0.8'), []);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/downgrade/);
    });
  });

  describe('delta packages — direct application', () => {
    it('applies directly when baseVersion matches the currently installed version', () => {
      const result = resolveUpgradePath('1.0.9', delta('d1', '1.0.10', '1.0.9'), []);
      expect(result.valid).toBe(true);
      expect(result.chain).toEqual([{ fromVersion: '1.0.9', toVersion: '1.0.10', releaseId: 'd1' }]);
    });

    it('rejects a delta with no declared baseVersion', () => {
      const malformed: UpgradeCandidateRelease = { id: 'd1', version: '1.0.10', packageType: 'delta', baseVersion: null };
      const result = resolveUpgradePath('1.0.9', malformed, []);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/no declared baseVersion/);
    });
  });

  describe('delta packages — chained resolution', () => {
    it('resolves a two-hop chain via one intermediate delta', () => {
      const bridge = delta('d-mid', '1.0.9', '1.0.8');
      const target = delta('d-target', '1.0.10', '1.0.9');
      const result = resolveUpgradePath('1.0.8', target, [bridge]);
      expect(result.valid).toBe(true);
      expect(result.chain).toEqual([
        { fromVersion: '1.0.8', toVersion: '1.0.9', releaseId: 'd-mid' },
        { fromVersion: '1.0.9', toVersion: '1.0.10', releaseId: 'd-target' },
      ]);
    });

    it('resolves a three-hop chain, picking the shortest path (BFS)', () => {
      const hop1 = delta('h1', '1.0.6', '1.0.5');
      const hop2 = delta('h2', '1.0.7', '1.0.6');
      const target = delta('t', '1.0.8', '1.0.7');
      const result = resolveUpgradePath('1.0.5', target, [hop1, hop2]);
      expect(result.valid).toBe(true);
      expect(result.chain.map((s) => s.toVersion)).toEqual(['1.0.6', '1.0.7', '1.0.8']);
    });

    it('reports the exact missing link when a chain is broken', () => {
      const target = delta('t', '1.0.10', '1.0.9');
      // No delta anywhere bridges 1.0.8 -> 1.0.9.
      const result = resolveUpgradePath('1.0.8', target, []);
      expect(result.valid).toBe(false);
      expect(result.chain).toEqual([]);
      expect(result.reason).toMatch(/no delta release with baseVersion "1\.0\.8" is registered at all/);
    });

    it('reports the furthest reachable version when a partial chain exists but does not reach the target', () => {
      const hop1 = delta('h1', '1.0.6', '1.0.5');
      const target = delta('t', '1.0.10', '1.0.9'); // needs 1.0.9, but the graph only reaches 1.0.6
      const result = resolveUpgradePath('1.0.5', target, [hop1]);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/furthest reachable version via known deltas is "1\.0\.6"/);
    });

    it('is cycle-safe — a malformed delta graph with a loop still terminates and reports correctly', () => {
      // d1: 1.0.1 -> base 1.0.1 (self-loop, malformed data), d2: normal edge.
      const selfLoop: UpgradeCandidateRelease = { id: 'loop', version: '1.0.1', packageType: 'delta', baseVersion: '1.0.1' };
      const normal = delta('d2', '1.0.2', '1.0.1');
      const target = delta('t', '1.0.3', '1.0.2');
      const result = resolveUpgradePath('1.0.1', target, [selfLoop, normal]);
      expect(result.valid).toBe(true);
      expect(result.chain.map((s) => s.toVersion)).toEqual(['1.0.2', '1.0.3']);
    });

    it('is cycle-safe against a two-node cycle (A bases on B, B bases on A) and does not hang', () => {
      const a: UpgradeCandidateRelease = { id: 'a', version: '2.0.0', packageType: 'delta', baseVersion: '3.0.0' };
      const b: UpgradeCandidateRelease = { id: 'b', version: '3.0.0', packageType: 'delta', baseVersion: '2.0.0' };
      const target = delta('t', '9.9.9', '8.8.8'); // unreachable from 1.0.0 regardless
      const result = resolveUpgradePath('1.0.0', target, [a, b]);
      expect(result.valid).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  });

  describe('minimumCompatibleVersion floor', () => {
    it('rejects when the installed version is below the floor, even for a direct full install', () => {
      const result = resolveUpgradePath('1.0.4', full('r1', '1.0.10'), [], '1.0.5');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/minimum compatible version of "1\.0\.5"/);
    });

    it('rejects when the installed version is below the floor, even for a directly-applicable delta', () => {
      const result = resolveUpgradePath('1.0.4', delta('d1', '1.0.10', '1.0.4'), [], '1.0.5');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/minimum compatible version/);
    });

    it('allows when the installed version meets the floor exactly', () => {
      const result = resolveUpgradePath('1.0.5', full('r1', '1.0.10'), [], '1.0.5');
      expect(result.valid).toBe(true);
    });

    it('is a no-op when omitted — no floor enforced', () => {
      const result = resolveUpgradePath('0.0.1', full('r1', '1.0.10'), []);
      expect(result.valid).toBe(true);
    });
  });

  describe('never a silent empty result', () => {
    it('every invalid resolution carries a non-empty, human-readable reason', () => {
      const cases: UpgradeResolutionCase[] = [
        ['same version', () => resolveUpgradePath('1.0.10', full('r1', '1.0.10'), [])],
        ['downgrade', () => resolveUpgradePath('1.0.10', full('r1', '1.0.8'), [])],
        ['missing baseVersion', () => resolveUpgradePath('1.0.9', { id: 'd1', version: '1.0.10', packageType: 'delta', baseVersion: null }, [])],
        ['broken chain', () => resolveUpgradePath('1.0.8', delta('t', '1.0.10', '1.0.9'), [])],
        ['below floor', () => resolveUpgradePath('1.0.0', full('r1', '1.0.10'), [], '1.0.5')],
      ];
      for (const [, run] of cases) {
        const result = run();
        expect(result.valid).toBe(false);
        expect(result.reason.length).toBeGreaterThan(0);
        expect(result.chain).toEqual([]);
      }
    });
  });
});

type UpgradeResolutionCase = [string, () => ReturnType<typeof resolveUpgradePath>];
