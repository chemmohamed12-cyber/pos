import { ModuleManifest } from '../module-manifest.type';

/**
 * ADR-071 §4 — `targets` module manifest. A genuinely new module code
 * (never previously reserved, confirmed `module-manifest.type.ts`), the
 * same situation `attendance` was in per `ADR-065 §2` — not a promotion.
 * `depends_on: ['hr']` — Employee identity, read-only.
 */
export const targetsManifest: ModuleManifest = {
  module_code: 'targets',
  manifest_version: '1.0.0',
  title_code: 'module.targets',
  business_domains: ['targets'],
  depends_on: ['hr'],

  permission_nodes: [
    { node: 'targets', title_code: 'perm.targets' },
    { node: 'targets.target', title_code: 'perm.targets.target', parent: 'targets' },
    { node: 'targets.target.view', title_code: 'perm.targets.target.view', parent: 'targets.target' },
    { node: 'targets.target.create', title_code: 'perm.targets.target.create', parent: 'targets.target' },
    { node: 'targets.target.approve', title_code: 'perm.targets.target.approve', parent: 'targets.target' },
  ],

  feature_codes: [{ code: 'targets.core', title_code: 'feat.targets.core', default: false, toggleable: true }],

  limit_keys: [],

  config_keys: [],

  migration_tag: 'targets',

  public_contract: {
    commands: ['CreateTarget', 'SubmitTargetApproval', 'DecideTargetApproval'],
    queries: ['ListTargets', 'GetApprovedTargetForDate'],
    events: [],
  },
};
