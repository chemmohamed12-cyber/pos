import { Employee } from './infrastructure/employee.entity';
import { EmployeeStatusHistory } from './infrastructure/employee-status-history.entity';
import { LeaveRequest } from './infrastructure/leave-request.entity';

/**
 * ADR-074 (Hybrid B). HR's own Company-connection-capable entities — added 2026-10-05
 * (Area 21, CTO-authorized: `hr.controller.ts`). `OrgUnit` (departments) is already in the core set.
 */
export const HR_COMPANY_ENTITIES = [Employee, EmployeeStatusHistory, LeaveRequest];
