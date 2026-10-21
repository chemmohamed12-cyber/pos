/**
 * TEST-ONLY fixtures for specs that build a `ReleaseExecutionService` but are not about Company migrations. Since the Company migration gate always plans (CTO 2026-10-21)
 * the engine refuses to deploy without a `CompanyFanoutService`; those specs pass this stand-in, which reports "no READY Company exists" - a plan with nothing to do -
 * so the gate passes and the spec stays about what it is about. Specs that ARE about the gate (`release-execution-company-fanout.spec.ts`) build their own.
 */
export function currentCompanyFanoutMock() {
  return {
    plan: jest.fn(async () => ({ mode: 'off' as const, scope: [] as string[], planned: [], skipped: [], blockers: [] as string[] })),
    ensureBackups: jest.fn(async () => []),
    migrate: jest.fn(async () => ({ ok: true, outcomes: [] })),
    verify: jest.fn(async () => ({})),
    verifySchema: jest.fn(async () => ({})),
  };
}
