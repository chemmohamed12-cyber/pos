/** ADR-059 (HR Phase 1). Pure vocabulary, zero framework dependency — same shape as `employee-status.ts`. */
export type EmploymentType = 'full_time' | 'part_time' | 'contractor';

export const EMPLOYMENT_TYPES: EmploymentType[] = ['full_time', 'part_time', 'contractor'];
