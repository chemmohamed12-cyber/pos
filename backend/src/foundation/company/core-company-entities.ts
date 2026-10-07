import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { RolePermission } from '../permission/role-permission.entity';
import { AuditRecord } from '../audit/audit-record.entity';
import { EventOutbox } from '../events/event-outbox.entity';
import { LimitProfile } from '../limit-engine/limit-profile.entity';
import { LimitUsageCounter } from '../limit-engine/limit-usage-counter.entity';
import { NumberingSequence } from '../numbering/numbering-sequence.entity';
import { ProcessInstance } from '../process-engine/process-instance.entity';
import { ProcessTransitionRecord } from '../process-engine/process-transition-record.entity';
import { ApprovalRequest } from '../approval-engine/approval-request.entity';
import { ApprovalRequestType } from '../approval-engine/approval-request-type.entity';
import { ApprovalMatrixRule } from '../approval-engine/approval-matrix-rule.entity';
import { ApprovalDecision } from '../approval-engine/approval-decision.entity';
import { ScopeAssignment } from '../scope/scope-assignment.entity';
import { AccessScope } from '../scope/access-scope.entity';
import { OrgUnit } from '../organization/org-unit.entity';
import { OrgMembership } from '../organization/org-membership.entity';
import { IdempotencyRecord } from '../error-contract/idempotency-record.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B — Domain-Owned Company
 * Entity Sets + Single Aggregated Company Entity Registry). The `core`
 * migration tag's own Company-connection-capable entities — foundation,
 * cross-cutting services every Company-scoped request can reach
 * regardless of which optional domain tags a Company was provisioned
 * with: Authorization (`Role`/`UserRole`, PROVEN broken before this fix —
 * ADR-074 §1), Permission, Audit, Event Outbox, Limit Engine, Numbering,
 * Process Engine, Approval Engine.
 *
 * `ScopeAssignment` added 2026-09-27 (Area 21 Operational Company Scoping
 * Retrofit) — Scope Engine (ADR-005) is the same class of cross-cutting
 * foundation service as Authorization/Permission above and was simply
 * missed when this registry was first built; `ScopeService` itself was
 * made manager-capable in the same change (`scope.service.ts`).
 *
 * `OrgUnit`/`OrgMembership` added 2026-09-27 (same pass, discovered while
 * retrofitting `treasury.controller.ts`) — `OrganizationService`
 * (consumed by `treasury`/`accounting`/`hr` via `ScopeResolver`, ADR-031)
 * was still `@InjectRepository`-based, the exact same structural gap
 * `ScopeService` had before its own fix; rewritten to `DataSource` +
 * `manager?` in the same change (`organization.service.ts`).
 *
 * `IdempotencyRecord` added 2026-09-27 (same pass) — `IdempotencyService`
 * was ALSO still `@InjectRepository`-based; without this fix a duplicate
 * `(scope, key)` pair from two different Companies would have collided
 * against the same ambient table, incorrectly deduping one Company's
 * request against another's (`idempotency.service.ts`).
 */
export const CORE_COMPANY_ENTITIES = [
  Role,
  UserRole,
  RolePermission,
  AuditRecord,
  EventOutbox,
  LimitProfile,
  LimitUsageCounter,
  NumberingSequence,
  ProcessInstance,
  ProcessTransitionRecord,
  ApprovalRequest,
  ApprovalRequestType,
  ApprovalMatrixRule,
  ApprovalDecision,
  ScopeAssignment,
  AccessScope,
  OrgUnit,
  OrgMembership,
  IdempotencyRecord,
];
