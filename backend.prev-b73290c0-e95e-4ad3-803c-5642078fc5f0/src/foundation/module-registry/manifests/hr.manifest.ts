import { ModuleManifest } from '../module-manifest.type';

/**
 * ERP Foundation — P9 (ADR-029). `hr` module manifest — the first module
 * promoted from reserved to built purely to prove the foundation is
 * genuinely extensible (`P9_BLUEPRINT.md`).
 *
 * `depends_on: []` — deliberately zero. Unlike every other built module
 * (each of which reaches into at least one sibling's concrete service —
 * see `reportingManifest`'s own doc comment), `hr.service.ts` imports
 * nothing from `src/domains/{commerce,crm,sales,sales-orders,inventory-warehouse,
 * fulfillment,shipment,delivery,returns,treasury,customer-finance}`. This is
 * the strongest available proof that a new Module needs no other Module's
 * internals.
 */
export const hrManifest: ModuleManifest = {
  module_code: 'hr',
  manifest_version: '1.0.0',
  title_code: 'module.hr',
  business_domains: ['hr'],
  depends_on: [],

  permission_nodes: [
    { node: 'hr', title_code: 'perm.hr' },

    { node: 'hr.employee', title_code: 'perm.hr.employee', parent: 'hr' },
    { node: 'hr.employee.view', title_code: 'perm.hr.employee.view', parent: 'hr.employee' },
    { node: 'hr.employee.create', title_code: 'perm.hr.employee.create', parent: 'hr.employee' },
    { node: 'hr.employee.edit', title_code: 'perm.hr.employee.edit', parent: 'hr.employee' },

    { node: 'hr.department', title_code: 'perm.hr.department', parent: 'hr' },
    { node: 'hr.department.view', title_code: 'perm.hr.department.view', parent: 'hr.department' },
    { node: 'hr.department.create', title_code: 'perm.hr.department.create', parent: 'hr.department' },
    { node: 'hr.department.edit', title_code: 'perm.hr.department.edit', parent: 'hr.department' },
  ],

  feature_codes: [
    { code: 'hr.employee_directory', title_code: 'feat.hr.employee_directory', default: true, toggleable: false },
  ],

  limit_keys: [{ key: 'hr.max_employees', title_code: 'limit.hr.max_employees', unit: 'count', default: null }],

  config_keys: [
    {
      key: 'hr.default_employee_status',
      type: 'enum',
      allowed: ['active', 'on_leave', 'terminated'],
      default: 'active',
      scope_levels: ['platform', 'edition', 'installation'],
    },
  ],

  migration_tag: 'hr',

  public_contract: {
    commands: ['CreateEmployee', 'CreateDepartment'],
    queries: ['GetEmployee', 'ListEmployees', 'ListDepartments'],
    events: ['employee.created'],
  },
};
