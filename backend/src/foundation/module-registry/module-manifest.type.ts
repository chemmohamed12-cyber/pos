/**
 * ERP Foundation — P1 (Module / Feature Metadata).
 * Contract: architecture/decisions/ADR-024 + architecture/MODULE_METADATA_AND_NODE_NAMESPACE.md
 *           architecture/decisions/ADR-027 (`depends_on`)
 *           architecture/decisions/ADR-028 (`manifest_version`)
 * Blueprint: planning/erp-foundation/P1_BLUEPRINT.md §2.
 *
 * A ModuleManifest is INERT, DECLARATIVE DATA. It has no behavioural fields,
 * no functions, no DB access, and imports nothing from `src/domains/*`. Each
 * V1 module ships exactly one manifest as a single exported `const` object.
 * The registry (module-registry.ts) aggregates and validates them; the CI
 * check (tools/validation/validate-module-manifests.js) enforces the rules.
 *
 * NOTHING here is wired into the running application in P1. The registry is
 * consumed only by CI; the guards (require-module/require-feature) are
 * always-allow no-ops. Runtime behaviour is unchanged by P1.
 */

/**
 * The V1 module_code allowlist — the ONLY legal values for a manifest
 * (ADR-024 §2). `hr` added by ADR-029 (P9 — promoted from reserved to
 * built). `accounting` added by ADR-032 (F01 — Financial Core, promoted
 * from reserved to built; see `ReservedModuleCode` below). `procurement`
 * added by ADR-048 (Purchasing/Supplier/Supplier-Finance, promoted from
 * reserved to built; see docs/decisions/ADR-048-procurement-promotion.md).
 */
export type ModuleCode = 'core' | 'sales' | 'inventory' | 'logistics' | 'finance' | 'reporting' | 'hr' | 'accounting' | 'procurement';

/** A module_code a manifest may actually declare (`core` has no authored manifest — §3.2). */
export type AuthoredModuleCode = Exclude<ModuleCode, 'core'>;

/**
 * Reserved-but-unbuilt, unbuilt-by-design codes (ADR-024 §2.1 + MODULE_REGISTRY.md §3).
 * Not usable in a manifest — here so the CI check can reject them with a clear message.
 * `hr` promoted out of this list by ADR-029 (P9). `accounting` promoted out
 * by ADR-032 (F01). `procurement` promoted out by ADR-048.
 */
export type ReservedModuleCode =
  | 'manufacturing'
  | 'pos'
  | 'projects'
  | 'assets'
  | 'operations'
  | 'payroll';

/** The curated, closed list of permission-node action verbs (ADR-024 §3.1, D-P1-3). */
export type PermissionActionVerb =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'approve'
  | 'reject'
  | 'submit'
  | 'post'
  | 'release'
  | 'assign'
  | 'export'
  | 'reopen'
  | 'cancel'
  | 'adjust'
  | 'transfer'
  | 'reverse';

/** Precedence levels a config key may be set at (CUSTOMER_CONFIGURATION_ARCHITECTURE.md §3). */
export type ConfigScopeLevel = 'platform' | 'edition' | 'installation' | 'org' | 'user';

export interface PermissionNodeMeta {
  /** ADR-024 §3.1 grammar: 1–3 dot-separated segments; segment[0] === the manifest's module_code. */
  readonly node: string;
  /** Terminology key for display (Terminology Registry is not touched by P1). */
  readonly title_code: string;
  /** Optional explicit parent for a tree view; must itself be a node in the same manifest. */
  readonly parent?: string;
}

export interface FeatureCodeMeta {
  /** `<module_code>.<feature>` */
  readonly code: string;
  readonly title_code: string;
  /** Shipped ON in a fresh Edition of this module? */
  readonly default: boolean;
  /**
   * `false` => a structural grouping, not a real toggle; `@RequireFeature` on it
   * is a documented no-op. `true` => a genuine capability toggle.
   */
  readonly toggleable: boolean;
}

export interface LimitKeyMeta {
  /** `<module_code>.<thing>` */
  readonly key: string;
  readonly title_code: string;
  readonly unit: 'count' | 'per_month' | 'per_day' | 'bytes';
  /** `null` => unlimited by default (fail-open — LIMIT_INTEGRATION_CONTRACT.md). */
  readonly default: number | null;
}

export interface ConfigKeyMeta {
  /** `<module_code>.<setting>` */
  readonly key: string;
  readonly type: 'bool' | 'int' | 'decimal' | 'enum' | 'string' | 'json';
  /**
   * enum → an array of the allowed values; int/decimal → `{ min, max }`.
   * (F-P2-1: the numeric-range object shape was added in P2 for consistency
   * with the Configuration Engine's validator.)
   */
  readonly allowed?: readonly unknown[] | { readonly min: number; readonly max: number };
  readonly default: unknown;
  readonly scope_levels: readonly ConfigScopeLevel[];
  /**
   * `true` => cannot be overridden below the `edition` level. The definitive
   * list of keys that MUST be `platform_locked` is a Team B (Security) input
   * to P2 — Cross-Team Register D-10.
   */
  readonly platform_locked?: boolean;
}

export interface ModulePublicContract {
  /** Command names other modules may invoke (via the contract, not a raw import — target state, P4). */
  readonly commands: readonly string[];
  /** Query names other modules may call. */
  readonly queries: readonly string[];
  /** Event names other modules may subscribe to. */
  readonly events: readonly string[];
}

export interface ModuleManifest {
  readonly module_code: AuthoredModuleCode;
  /** Semver of this manifest's shape + content (ADR-028). Bumped when the manifest changes. */
  readonly manifest_version: string;
  readonly title_code: string;
  /** Folder names under `backend/src/domains/` grouped by this module (ADR-024 §2). */
  readonly business_domains: readonly string[];
  /**
   * This module's hard cross-module dependencies, derived from the ACTUAL
   * non-`.spec.ts` code graph (P1_BLUEPRINT.md §4.3). `core` is implicit and
   * never listed. C-8 mechanically proves every real cross-module import is
   * declared here. The graph is cyclic today (F-MOD-2) — decoupling is P4.
   */
  readonly depends_on: readonly AuthoredModuleCode[];
  readonly permission_nodes: readonly PermissionNodeMeta[];
  readonly feature_codes: readonly FeatureCodeMeta[];
  readonly limit_keys: readonly LimitKeyMeta[];
  readonly config_keys: readonly ConfigKeyMeta[];
  /** The ADR-025 migration-partition tag. MUST equal `module_code`. */
  readonly migration_tag: ModuleCode;
  readonly public_contract: ModulePublicContract;
}

/** The frozen V1 list (ADR-024 §2, + `hr` per ADR-029, + `accounting` per ADR-032, + `procurement` per ADR-048). */
export const V1_MODULE_CODES: readonly ModuleCode[] = [
  'core',
  'sales',
  'inventory',
  'logistics',
  'finance',
  'reporting',
  'hr',
  'accounting',
  'procurement',
] as const;

/** Reserved, not built, not designed (ADR-024 §2.1; 6 codes as of ADR-029/ADR-032/ADR-048 promoting `hr`/`accounting`/`procurement` out). */
export const RESERVED_MODULE_CODES: readonly ReservedModuleCode[] = [
  'manufacturing',
  'pos',
  'projects',
  'assets',
  'operations',
  'payroll',
] as const;

/** The closed action-verb list (D-P1-3). */
export const PERMISSION_ACTION_VERBS: readonly PermissionActionVerb[] = [
  'view',
  'create',
  'edit',
  'delete',
  'approve',
  'reject',
  'submit',
  'post',
  'release',
  'assign',
  'export',
  'reopen',
  'cancel',
  'adjust',
  'transfer',
  'reverse',
] as const;

/**
 * Node prefixes that are valid but have NO authored manifest — grandfathered
 * so the existing `system.release.*` permission rows (26, live in
 * `role_permissions`) stay valid without a data migration (ADR-024 §3.3).
 */
export const GRANDFATHERED_NODE_PREFIXES: readonly string[] = ['system', 'core'] as const;
