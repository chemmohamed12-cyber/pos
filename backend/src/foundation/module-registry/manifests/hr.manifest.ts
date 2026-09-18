import { ModuleManifest } from '../module-manifest.type';

/**
 * ERP Foundation — P9 (ADR-029), expanded under ADR-059 (HR Phase 1, Wave
 * 2 of the ADR-053 Long-Term Completion Charter).
 *
 * `depends_on` is no longer empty — ADR-059 D1 (ratified) retired
 * `hr_departments` in favor of `OrgUnit(type='department')` as the single
 * source of truth for departments, the one disclosed, deliberate tradeoff
 * P9's original zero-dependency proof made room for. `hr.service.ts`
 * still imports nothing from any business domain in
 * `src/domains/{commerce,crm,sales,sales-orders,inventory-warehouse,
 * fulfillment,shipment,delivery,returns,treasury,customer-finance}` — only
 * Platform-Core foundation modules (Organization, Numbering,
 * ApprovalEngine, Identity).
 */
export const hrManifest: ModuleManifest = {
  module_code: 'hr',
  manifest_version: '1.1.0',
  title_code: 'module.hr',
  business_domains: ['hr'],
  depends_on: [],

  permission_nodes: [
    { node: 'hr', title_code: 'perm.hr' },

    { node: 'hr.employee', title_code: 'perm.hr.employee', parent: 'hr' },
    { node: 'hr.employee.view', title_code: 'perm.hr.employee.view', parent: 'hr.employee' },
    { node: 'hr.employee.create', title_code: 'perm.hr.employee.create', parent: 'hr.employee' },
    { node: 'hr.employee.edit', title_code: 'perm.hr.employee.edit', parent: 'hr.employee' },
    {
      node: 'hr.employee.terminate',
      title_code: 'perm.hr.employee.terminate',
      parent: 'hr.employee',
    },
    {
      node: 'hr.employee.link_user',
      title_code: 'perm.hr.employee.link_user',
      parent: 'hr.employee',
    },

    { node: 'hr.department', title_code: 'perm.hr.department', parent: 'hr' },
    { node: 'hr.department.view', title_code: 'perm.hr.department.view', parent: 'hr.department' },
    { node: 'hr.department.create', title_code: 'perm.hr.department.create', parent: 'hr.department' },
    { node: 'hr.department.edit', title_code: 'perm.hr.department.edit', parent: 'hr.department' },

    { node: 'hr.leave_request', title_code: 'perm.hr.leave_request', parent: 'hr' },
    { node: 'hr.leave_request.view', title_code: 'perm.hr.leave_request.view', parent: 'hr.leave_request' },
    { node: 'hr.leave_request.create', title_code: 'perm.hr.leave_request.create', parent: 'hr.leave_request' },
    {
      node: 'hr.leave_request.approve',
      title_code: 'perm.hr.leave_request.approve',
      parent: 'hr.leave_request',
    },
  ],

  feature_codes: [
    { code: 'hr.employee_directory', title_code: 'feat.hr.employee_directory', default: true, toggleable: false },
    { code: 'hr.leave_management', title_code: 'feat.hr.leave_management', default: true, toggleable: false },
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
    commands: ['CreateEmployee', 'CreateDepartment', 'EditDepartment', 'TerminateEmployee', 'LinkEmployeeUser', 'SubmitLeaveRequest'],
    queries: ['GetEmployee', 'ListEmployees', 'ListDepartments', 'ListEmployeeStatusHistory', 'ListLeaveRequests'],
    events: ['employee.created'],
  },
};
