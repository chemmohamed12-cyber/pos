import { compareVersions, isVersionAtLeast } from './version-compare';
import { ReleasePackageType } from './release-status';

/**
 * Release Engine overhaul, stage 3 (CTO Directive, Production Incident
 * 2026-09-15 post-mortem — see `MigrationPreflight`'s own doc comment for
 * stage 1/2). A `'delta'` release's `baseVersion` must EXACTLY match the
 * currently installed version (`manifest-validation.ts`, `MigrationPreflight`'s
 * compatibility check) — that already blocks applying a single delta whose
 * base doesn't match. What neither of those answers is the PLANNING
 * question an operator (or the future Release Center UI) needs before ever
 * attempting a deploy: "can I get from what's installed NOW to this
 * specific release AT ALL, and if so, through which intermediate releases,
 * in what order?" A delta chain with a missing link must be reported as
 * exactly that — which version is missing — never a bare "no" and never a
 * silently-empty result (CTO Directive: "must explain WHY").
 */
export interface UpgradeCandidateRelease {
  id: string;
  version: string;
  packageType: ReleasePackageType;
  /** Required and meaningful only for `packageType === 'delta'`. */
  baseVersion: string | null;
}

export interface UpgradeChainStep {
  fromVersion: string;
  toVersion: string;
  /** The release that performs this step, when it's a known registered release (absent for the trivial "direct full install" step, which needs no bridge). */
  releaseId?: string;
}

export interface UpgradeResolution {
  valid: boolean;
  /** Always populated — never a silent empty result, whether valid or not. */
  reason: string;
  /** The ordered steps from the currently installed version to the target, empty when `valid` is false. */
  chain: UpgradeChainStep[];
}

function invalid(reason: string): UpgradeResolution {
  return { valid: false, reason, chain: [] };
}

/**
 * Breadth-first search over the graph of KNOWN delta releases (edge:
 * `baseVersion -> version`) for the shortest chain from `from` to `to`.
 * Guards against cycles (a malformed/duplicate delta declaring its own
 * `baseVersion` as its `version`, or two deltas forming a loop) with a
 * visited-set — this is a planning aid, not a trusted deploy-time
 * computation, but it must still terminate on bad data rather than hang.
 */
function findDeltaChain(from: string, to: string, deltas: readonly UpgradeCandidateRelease[]): UpgradeChainStep[] | null {
  if (from === to) return [];

  const byBaseVersion = new Map<string, UpgradeCandidateRelease[]>();
  for (const d of deltas) {
    if (!d.baseVersion) continue;
    const list = byBaseVersion.get(d.baseVersion) ?? [];
    list.push(d);
    byBaseVersion.set(d.baseVersion, list);
  }

  const visited = new Set<string>([from]);
  const queue: Array<{ version: string; path: UpgradeChainStep[] }> = [{ version: from, path: [] }];

  while (queue.length > 0) {
    const { version, path } = queue.shift()!;
    for (const candidate of byBaseVersion.get(version) ?? []) {
      if (visited.has(candidate.version)) continue;
      const nextPath = [...path, { fromVersion: version, toVersion: candidate.version, releaseId: candidate.id }];
      if (candidate.version === to) return nextPath;
      visited.add(candidate.version);
      queue.push({ version: candidate.version, path: nextPath });
    }
  }
  return null;
}

/**
 * Resolves whether `target` can be reached from `currentInstalledVersion`,
 * and how. `availableDeltas` should be every OTHER known delta release this
 * installation could legitimately use as a bridge (any manifest-valid
 * status is acceptable — this answers "does a package exist that bridges
 * this gap", not "was it ever actually deployed"); `target` itself is
 * excluded automatically by the caller passing it separately.
 */
export function resolveUpgradePath(
  currentInstalledVersion: string,
  target: UpgradeCandidateRelease,
  availableDeltas: readonly UpgradeCandidateRelease[],
  minimumCompatibleVersion?: string | null,
): UpgradeResolution {
  if (minimumCompatibleVersion && !isVersionAtLeast(currentInstalledVersion, minimumCompatibleVersion)) {
    return invalid(
      `Target release "${target.version}" requires a minimum compatible version of "${minimumCompatibleVersion}", but the currently installed version is "${currentInstalledVersion}".`,
    );
  }

  if (target.packageType === 'full') {
    const cmp = compareVersions(target.version, currentInstalledVersion);
    if (cmp > 0) {
      return { valid: true, reason: `Full package "${target.version}" installs directly over "${currentInstalledVersion}" — no intermediate releases required.`, chain: [{ fromVersion: currentInstalledVersion, toVersion: target.version, releaseId: target.id }] };
    }
    if (cmp === 0) {
      return invalid(`Target version "${target.version}" is the currently installed version — there is nothing to upgrade.`);
    }
    return invalid(
      `Target version "${target.version}" is older than the currently installed version "${currentInstalledVersion}" — this would be a downgrade, which the Upgrade Resolver does not authorize.`,
    );
  }

  // packageType === 'delta'
  if (!target.baseVersion) {
    return invalid(`Delta release "${target.version}" has no declared baseVersion — it cannot be resolved as an upgrade step.`);
  }

  if (target.baseVersion === currentInstalledVersion) {
    return {
      valid: true,
      reason: `Delta "${target.version}" applies directly — its baseVersion ("${target.baseVersion}") matches the currently installed version.`,
      chain: [{ fromVersion: currentInstalledVersion, toVersion: target.version, releaseId: target.id }],
    };
  }

  const bridge = findDeltaChain(currentInstalledVersion, target.baseVersion, availableDeltas);
  if (!bridge) {
    const reachable = reachableVersions(currentInstalledVersion, availableDeltas);
    const furthest = [...reachable].sort(compareVersions).pop() ?? currentInstalledVersion;
    const gapDetail =
      furthest === currentInstalledVersion
        ? `no delta release with baseVersion "${currentInstalledVersion}" is registered at all`
        : `the furthest reachable version via known deltas is "${furthest}"; no registered delta has baseVersion "${furthest}" leading further toward "${target.baseVersion}"`;
    return invalid(
      `Delta "${target.version}" requires baseVersion "${target.baseVersion}", but the currently installed version is "${currentInstalledVersion}". ` +
        `No chain of known delta releases bridges this gap — ${gapDetail}.`,
    );
  }

  const fullChain = [...bridge, { fromVersion: target.baseVersion, toVersion: target.version, releaseId: target.id }];
  return {
    valid: true,
    reason:
      bridge.length === 0
        ? `Delta "${target.version}" applies directly.`
        : `Delta "${target.version}" is reachable via ${bridge.length} intermediate delta release(s): ${bridge.map((s) => s.toVersion).join(' -> ')} -> "${target.baseVersion}".`,
    chain: fullChain,
  };
}

/** Every version reachable from `from` by following known delta edges — used only to explain WHERE a broken chain stops. */
function reachableVersions(from: string, deltas: readonly UpgradeCandidateRelease[]): Set<string> {
  const byBaseVersion = new Map<string, UpgradeCandidateRelease[]>();
  for (const d of deltas) {
    if (!d.baseVersion) continue;
    const list = byBaseVersion.get(d.baseVersion) ?? [];
    list.push(d);
    byBaseVersion.set(d.baseVersion, list);
  }
  const visited = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const version = queue.shift()!;
    for (const candidate of byBaseVersion.get(version) ?? []) {
      if (visited.has(candidate.version)) continue;
      visited.add(candidate.version);
      queue.push(candidate.version);
    }
  }
  return visited;
}
