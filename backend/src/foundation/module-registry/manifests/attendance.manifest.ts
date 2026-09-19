import { ModuleManifest } from '../module-manifest.type';

/**
 * ADR-065 — `attendance` module manifest. A genuinely new module code
 * (`D-ATT1: A`, ratified `ADR-063`) — `attendance` was never a
 * `ReservedModuleCode` (confirmed `ADR-062 §0`), so this is not a
 * promotion; it is this module's first entry into `V1_MODULE_CODES`.
 *
 * `depends_on: ['hr']` — the one real cross-module import this module
 * makes: `HrService.isApprovedLeaveDate` (ratified `ADR-063 §3: B`, day
 * classification reconciles against HR's approved `LeaveRequest`).
 * Nothing else in `domains/hr` is imported. `hr` itself has zero
 * dependency back on `attendance` — the same one-directional shape
 * `ADR-062 §2` established.
 */
export const attendanceManifest: ModuleManifest = {
  module_code: 'attendance',
  manifest_version: '1.0.0',
  title_code: 'module.attendance',
  business_domains: ['attendance'],
  depends_on: ['hr'],

  permission_nodes: [
    { node: 'attendance', title_code: 'perm.attendance' },

    { node: 'attendance.connector', title_code: 'perm.attendance.connector', parent: 'attendance' },
    { node: 'attendance.connector.view', title_code: 'perm.attendance.connector.view', parent: 'attendance.connector' },
    { node: 'attendance.connector.create', title_code: 'perm.attendance.connector.create', parent: 'attendance.connector' },
    { node: 'attendance.connector.edit', title_code: 'perm.attendance.connector.edit', parent: 'attendance.connector' },

    { node: 'attendance.mapping', title_code: 'perm.attendance.mapping', parent: 'attendance' },
    { node: 'attendance.mapping.view', title_code: 'perm.attendance.mapping.view', parent: 'attendance.mapping' },
    { node: 'attendance.mapping.create', title_code: 'perm.attendance.mapping.create', parent: 'attendance.mapping' },
    { node: 'attendance.mapping.edit', title_code: 'perm.attendance.mapping.edit', parent: 'attendance.mapping' },

    { node: 'attendance.raw_record', title_code: 'perm.attendance.raw_record', parent: 'attendance' },
    { node: 'attendance.raw_record.view', title_code: 'perm.attendance.raw_record.view', parent: 'attendance.raw_record' },

    { node: 'attendance.import', title_code: 'perm.attendance.import', parent: 'attendance' },
    { node: 'attendance.import.view', title_code: 'perm.attendance.import.view', parent: 'attendance.import' },
    { node: 'attendance.import.create', title_code: 'perm.attendance.import.create', parent: 'attendance.import' },

    { node: 'attendance.manual_entry', title_code: 'perm.attendance.manual_entry', parent: 'attendance' },
    { node: 'attendance.manual_entry.create', title_code: 'perm.attendance.manual_entry.create', parent: 'attendance.manual_entry' },

    { node: 'attendance.day', title_code: 'perm.attendance.day', parent: 'attendance' },
    { node: 'attendance.day.view', title_code: 'perm.attendance.day.view', parent: 'attendance.day' },

    {
      node: 'attendance.correction',
      title_code: 'perm.attendance.correction',
      parent: 'attendance',
    },
    { node: 'attendance.correction.create', title_code: 'perm.attendance.correction.create', parent: 'attendance.correction' },

    { node: 'attendance.approval', title_code: 'perm.attendance.approval', parent: 'attendance' },
    { node: 'attendance.approval.view', title_code: 'perm.attendance.approval.view', parent: 'attendance.approval' },
    { node: 'attendance.approval.create', title_code: 'perm.attendance.approval.create', parent: 'attendance.approval' },
    {
      node: 'attendance.approval.approve',
      title_code: 'perm.attendance.approval.approve',
      parent: 'attendance.approval',
    },
  ],

  feature_codes: [{ code: 'attendance.tracking', title_code: 'feat.attendance.tracking', default: true, toggleable: false }],

  limit_keys: [],

  config_keys: [],

  migration_tag: 'attendance',

  public_contract: {
    commands: [
      'RegisterAttendanceConnector',
      'CreateAttendanceMapping',
      'RecordManualAttendancePunch',
      'ImportAttendanceExcel',
      'SubmitAttendanceApprovalBatch',
      'DecideAttendanceApprovalBatch',
      'CorrectAttendanceDay',
    ],
    queries: ['ListAttendanceDays', 'ListUnmappedAttendanceRecords', 'ListAttendanceApprovalBatches'],
    events: ['attendance.period.approved'],
  },
};
