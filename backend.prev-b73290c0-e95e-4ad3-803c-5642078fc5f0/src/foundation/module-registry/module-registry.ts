/**
 * ERP Foundation — P1. The read-only Module / Node Registry.
 * Blueprint: planning/erp-foundation/P1_BLUEPRINT.md §3.3.
 *
 * `buildModuleRegistry` is PURE — it takes the manifest array and returns a
 * deep-frozen lookup index. No NestJS, no DI, no I/O, no resolution policy.
 * It is NOT a Nest provider in P1: `MODULE_REGISTRY` below is a plain
 * module-level const, consumed only by CI (validate-module-manifests.js) and
 * unit tests. It becomes a Nest provider in P3, when the Entitlement Engine
 * first needs it at request time.
 */
import {
  AuthoredModuleCode,
  ModuleCode,
  ModuleManifest,
  V1_MODULE_CODES,
} from './module-manifest.type';
import { ALL_MODULE_MANIFESTS } from './manifests';

export interface ModuleRegistry {
  /** All V1 codes incl. `core`. */
  allModuleCodes(): readonly ModuleCode[];
  /** Codes that have an authored manifest (everything except `core`). */
  authoredModuleCodes(): readonly AuthoredModuleCode[];
  manifest(code: ModuleCode): ModuleManifest | null;

  hasNode(node: string): boolean;
  /** `'sales.order.approve'` -> `'sales'`; grandfathered `'system.*'`/`'core.*'` -> `'core'`. */
  moduleOf(node: string): ModuleCode | null;
  nodesForModule(code: ModuleCode): readonly string[];

  hasFeature(code: string): boolean;
  featureCodesForModule(code: ModuleCode): readonly string[];

  limitKeysForModule(code: ModuleCode): readonly string[];
  configKeysForModule(code: ModuleCode): readonly string[];

  /** Direct declared dependencies. */
  dependenciesOf(code: ModuleCode): readonly AuthoredModuleCode[];
  /**
   * The full transitive `depends_on` closure of `code` (NOT including `code`
   * itself, NOT including `core`). Cycle-safe: the graph is cyclic today
   * (F-MOD-2) so a naive walk would not terminate.
   */
  dependencyClosureOf(code: ModuleCode): readonly AuthoredModuleCode[];
  /** The 2-cycles present in the current `depends_on` graph (F-MOD-2 evidence). */
  dependencyCycles(): readonly (readonly [AuthoredModuleCode, AuthoredModuleCode])[];
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
  }
  return obj;
}

/** All ancestor keys of a dotted node, most-specific first (mirrors PermissionService). */
function ancestorChain(node: string): string[] {
  const parts = node.split('.');
  const chain: string[] = [];
  for (let i = parts.length; i > 0; i--) chain.push(parts.slice(0, i).join('.'));
  return chain;
}

/**
 * PURE. Builds a frozen registry from the given manifests. Throws only on a
 * structurally impossible input (duplicate module_code) — all softer rules
 * (grammar, prefixes, completeness) are the CI check's job, not this
 * function's, so the registry stays usable in tests that deliberately feed it
 * odd data.
 */
export function buildModuleRegistry(manifests: readonly ModuleManifest[]): ModuleRegistry {
  const byCode = new Map<ModuleCode, ModuleManifest>();
  for (const m of manifests) {
    if (byCode.has(m.module_code)) {
      throw new Error(`buildModuleRegistry: duplicate module_code "${m.module_code}"`);
    }
    byCode.set(m.module_code, deepFreeze({ ...m }));
  }

  const nodeToModule = new Map<string, ModuleCode>();
  const featureToModule = new Map<string, ModuleCode>();
  for (const m of manifests) {
    for (const n of m.permission_nodes) nodeToModule.set(n.node, m.module_code);
    for (const f of m.feature_codes) featureToModule.set(f.code, m.module_code);
  }

  const authored = (): AuthoredModuleCode[] =>
    [...byCode.keys()].filter((c): c is AuthoredModuleCode => c !== 'core');

  const dependenciesOf = (code: ModuleCode): readonly AuthoredModuleCode[] =>
    byCode.get(code)?.depends_on ?? [];

  const dependencyClosureOf = (code: ModuleCode): readonly AuthoredModuleCode[] => {
    const seen = new Set<AuthoredModuleCode>();
    const stack = [...dependenciesOf(code)];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next) || next === code) continue;
      seen.add(next);
      stack.push(...dependenciesOf(next));
    }
    seen.delete(code as AuthoredModuleCode);
    return [...seen].sort();
  };

  const dependencyCycles = (): readonly (readonly [AuthoredModuleCode, AuthoredModuleCode])[] => {
    const out = new Set<string>();
    const pairs: [AuthoredModuleCode, AuthoredModuleCode][] = [];
    for (const a of authored()) {
      for (const b of dependenciesOf(a)) {
        if (dependenciesOf(b).includes(a)) {
          const key = [a, b].sort().join('<->');
          if (!out.has(key)) {
            out.add(key);
            pairs.push([...([a, b].sort() as [AuthoredModuleCode, AuthoredModuleCode])]);
          }
        }
      }
    }
    return pairs;
  };

  const registry: ModuleRegistry = {
    allModuleCodes: () => V1_MODULE_CODES,
    authoredModuleCodes: () => authored().sort(),
    manifest: (code) => byCode.get(code) ?? null,

    hasNode: (node) => nodeToModule.has(node),
    moduleOf: (node) => {
      for (const key of ancestorChain(node)) {
        const direct = nodeToModule.get(key);
        if (direct) return direct;
      }
      const root = node.split('.')[0];
      if (root === 'system' || root === 'core') return 'core';
      return null;
    },
    nodesForModule: (code) => (byCode.get(code)?.permission_nodes ?? []).map((n) => n.node),

    hasFeature: (code) => featureToModule.has(code),
    featureCodesForModule: (code) => (byCode.get(code)?.feature_codes ?? []).map((f) => f.code),

    limitKeysForModule: (code) => (byCode.get(code)?.limit_keys ?? []).map((l) => l.key),
    configKeysForModule: (code) => (byCode.get(code)?.config_keys ?? []).map((c) => c.key),

    dependenciesOf,
    dependencyClosureOf,
    dependencyCycles,
  };

  return Object.freeze(registry);
}

/**
 * The registry built from the 5 V1 manifests. Plain const — NOT a Nest
 * provider in P1 (see file header). Do not import this from `src/domains/*`
 * or from any `foundation/*` engine before P3.
 */
export const MODULE_REGISTRY: ModuleRegistry = buildModuleRegistry(ALL_MODULE_MANIFESTS);
