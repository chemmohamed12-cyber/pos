import { PermissionAccess } from '../permission/role-permission.entity';

/**
 * Authorization Foundation F4 — the PLATFORM permission namespace (Blueprint §11). `platform.*` nodes are resolved ONLY against the control-plane (ambient)
 * `roles` / `role_permissions` tables; they never grant anything inside a Company, and a Company role never grants any of them (two planes, two authorities).
 * The existing platform nodes (`system.release.*`, `core.config.*`, `core.limit.*`, `core.entitlement.*`) are MAPPED to this namespace as legacy aliases and
 * stay accepted during the compatibility window (Map → Dual-check → Migrate → Retire); they are not duplicated or renamed.
 */
export type PlatformRisk = 'low' | 'sensitive' | 'platform-critical';

export interface PlatformNode {
  node: string;
  risk: PlatformRisk;
  titleEn: string;
  titleAr: string;
}

const n = (node: string, risk: PlatformRisk, titleEn: string, titleAr: string): PlatformNode => ({ node, risk, titleEn, titleAr });

export const PLATFORM_NODES: readonly PlatformNode[] = [
  n('platform.company.view', 'low', 'View Companies', 'عرض الشركات'),
  n('platform.company.create', 'sensitive', 'Create a Company', 'إنشاء شركة'),
  n('platform.company.update', 'sensitive', 'Update a Company', 'تعديل بيانات شركة'),
  n('platform.company.suspend', 'sensitive', 'Suspend a Company', 'إيقاف شركة'),
  n('platform.company.reactivate', 'sensitive', 'Reactivate a Company', 'إعادة تفعيل شركة'),
  n('platform.company.decommission', 'platform-critical', 'Decommission a Company', 'إنهاء شركة نهائيًا'),
  n('platform.user.view', 'low', 'View platform users', 'عرض مستخدمي المنصة'),
  n('platform.user.create', 'sensitive', 'Create a user', 'إنشاء مستخدم'),
  n('platform.user.update', 'sensitive', 'Edit a user profile', 'تعديل بيانات مستخدم'),
  n('platform.user.disable', 'sensitive', 'Disable / enable a user', 'إيقاف/تفعيل مستخدم'),
  n('platform.user.reset_password', 'platform-critical', 'Reset a user password', 'إعادة تعيين كلمة مرور'),
  n('platform.membership.view', 'low', 'View Company memberships', 'عرض عضويات الشركات'),
  n('platform.membership.grant', 'sensitive', 'Attach a user to a Company', 'إضافة مستخدم إلى شركة'),
  n('platform.membership.update', 'sensitive', 'Change a membership role', 'تغيير دور عضوية'),
  n('platform.membership.revoke', 'sensitive', 'Remove a Company membership', 'إزالة عضوية'),
  n('platform.entitlement.view', 'low', 'View entitlements and packages', 'عرض الاستحقاقات والباقات'),
  n('platform.entitlement.manage', 'platform-critical', 'Manage entitlements and packages', 'إدارة الاستحقاقات والباقات'),
  n('platform.plan.view', 'low', 'View plans', 'عرض الخطط'),
  n('platform.plan.manage', 'platform-critical', 'Manage plans', 'إدارة الخطط'),
  n('platform.role.view', 'low', 'View platform roles', 'عرض أدوار المنصة'),
  n('platform.role.assign', 'sensitive', 'Assign a non-platform role', 'إسناد دور عادي'),
  n('platform.role.manage', 'platform-critical', 'Assign / revoke platform roles', 'إدارة أدوار المنصة'),
  n('platform.audit.view', 'low', 'View platform and Company audit', 'عرض سجل التدقيق'),
  n('platform.release.view', 'low', 'View releases and backups', 'عرض الإصدارات والنسخ الاحتياطي'),
  n('platform.release.backup', 'sensitive', 'Create backups', 'إنشاء نسخ احتياطي'),
  n('platform.release.restore', 'platform-critical', 'Restore backups', 'استعادة نسخ احتياطي'),
  n('platform.release.deploy', 'platform-critical', 'Deploy releases', 'نشر الإصدارات'),
  n('platform.release.rollback', 'platform-critical', 'Roll back releases', 'التراجع عن إصدار'),
  n('platform.config.view', 'low', 'View configuration', 'عرض الإعدادات'),
  n('platform.config.edit', 'platform-critical', 'Edit configuration', 'تعديل الإعدادات'),
  n('platform.limit.view', 'low', 'View limits', 'عرض الحدود'),
  n('platform.limit.edit', 'sensitive', 'Edit limits', 'تعديل الحدود'),
  n('platform.support.view', 'low', 'View support access', 'عرض صلاحيات الدعم'),
  n('platform.support.grant', 'sensitive', 'Open time-boxed support access to a Company', 'فتح وصول دعم محدد المدة إلى شركة'),
  n('platform.support.revoke', 'sensitive', 'End support access', 'إنهاء وصول الدعم'),
  n('platform.integration.view', 'low', 'View the integration catalog', 'عرض كتالوج التكاملات'),
  n('platform.integration.manage', 'sensitive', 'Manage the integration catalog and availability', 'إدارة كتالوج التكاملات وإتاحتها'),
];

export const PLATFORM_NODE_KEYS: readonly string[] = PLATFORM_NODES.map((x) => x.node);
export const isPlatformNode = (node: string): boolean => node.startsWith('platform.');

/** Legacy platform nodes kept as aliases of the namespace (accepted by the platform guard during the compatibility window). */
export const PLATFORM_LEGACY_ALIASES: Readonly<Record<string, string>> = {
  'core.entitlement.view': 'platform.entitlement.view',
  'core.entitlement.apply': 'platform.entitlement.manage',
  'core.config.view': 'platform.config.view',
  'core.config.edit': 'platform.config.edit',
  'core.limit.view': 'platform.limit.view',
  'core.limit.edit': 'platform.limit.edit',
  'system.release.view': 'platform.release.view',
  'system.release.backup': 'platform.release.backup',
  'system.release.restore': 'platform.release.restore',
  'system.release.deploy': 'platform.release.deploy',
  'system.release.rollback': 'platform.release.rollback',
};

export interface PlatformRoleDef {
  key: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  grants: Array<{ node: string; access: PermissionAccess }>;
}

const view = (...nodes: string[]): PlatformRoleDef['grants'] => nodes.map((node) => ({ node, access: 'read-only' as const }));
const edit = (...nodes: string[]): PlatformRoleDef['grants'] => nodes.map((node) => ({ node, access: 'editable' as const }));
const ALL_VIEW = PLATFORM_NODES.filter((x) => x.node.endsWith('.view')).map((x) => x.node);

/** The four approved platform roles (CTO, 2026-10-07). The existing ambient `admin` is the legacy alias of the Super Admin (granted every platform node and also accepted by the guard). */
export const PLATFORM_ROLES: readonly PlatformRoleDef[] = [
  {
    key: 'platform_super_admin',
    nameEn: 'Platform Super Admin',
    nameAr: 'مدير المنصة الأعلى',
    descriptionEn: 'Every platform capability. Platform authority never implies ERP authority inside a Company.',
    descriptionAr: 'كل صلاحيات المنصة. صلاحية المنصة لا تعني أبدًا صلاحية تشغيلية داخل أي شركة.',
    grants: [...view(...ALL_VIEW), ...edit(...PLATFORM_NODE_KEYS.filter((k) => !k.endsWith('.view')))],
  },
  {
    key: 'company_manager',
    nameEn: 'Company Manager',
    nameAr: 'مدير الشركات',
    descriptionEn: 'Company lifecycle, memberships and packages. No release, configuration or platform-role management.',
    descriptionAr: 'إدارة دورة حياة الشركات وعضوياتها وباقاتها. بلا إدارة الإصدارات أو الإعدادات أو أدوار المنصة.',
    grants: [
      ...view('platform.company.view', 'platform.membership.view', 'platform.user.view', 'platform.plan.view', 'platform.entitlement.view', 'platform.audit.view', 'platform.support.view', 'platform.role.view'),
      ...edit('platform.company.create', 'platform.company.update', 'platform.company.suspend', 'platform.company.reactivate', 'platform.membership.grant', 'platform.membership.update', 'platform.membership.revoke', 'platform.entitlement.manage', 'platform.support.grant', 'platform.support.revoke'),
    ],
  },
  {
    key: 'support_operations',
    nameEn: 'Support / Operations',
    nameAr: 'الدعم والتشغيل',
    descriptionEn: 'Read access plus explicit, time-boxed, reason-required, audited, Company-visible support access. No entitlement or lifecycle changes.',
    descriptionAr: 'قراءة، إضافةً إلى وصول دعم صريح محدد المدة بسبب موثق ومُدقَّق وظاهر للشركة. بلا تغيير في الاستحقاقات أو دورة الحياة.',
    grants: [
      ...view('platform.company.view', 'platform.membership.view', 'platform.user.view', 'platform.plan.view', 'platform.entitlement.view', 'platform.audit.view', 'platform.support.view', 'platform.release.view'),
      ...edit('platform.support.grant', 'platform.support.revoke'),
    ],
  },
  {
    key: 'platform_audit_readonly',
    nameEn: 'Audit / Read-only',
    nameAr: 'التدقيق / للقراءة فقط',
    descriptionEn: 'Read-only view of every platform area. Cannot change anything and cannot open support access.',
    descriptionAr: 'عرض فقط لكل مناطق المنصة. لا يغيّر شيئًا ولا يفتح وصول دعم.',
    grants: view(...ALL_VIEW),
  },
];

export const PLATFORM_ROLE_KEYS: readonly string[] = [...PLATFORM_ROLES.map((r) => r.key), 'admin'];
